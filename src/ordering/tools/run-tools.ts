import { z } from 'zod';
import type { AgentMessage, ToolCall } from '../../llm/llm-provider.js';
import type { LangCode } from '../../shared/types.js';
import type { MenuService } from '../../menu/menu-service.js';
import type { MenuItem } from '../../menu/menu-types.js';
import { findRequiredModifierViolations } from './required-modifiers.js';
import type { OrderStateType } from '../graph/state.js';
import type { OrderGraphOutput } from '../schemas/order-graph-output.schema.js';
import { parseOrderGraphOutput } from '../schemas/order-graph-output.schema.js';
import { parseAgentReply } from '../graph/parse-agent-reply.js';
import { formatZodError } from '../../shared/zod-error.js';
import { TOOL_NAMES } from './tool-specs.js';
import { logger } from '../../config/logger.js';
import { messageOf } from '../../shared/errors.js';
import { RateLimitTimeoutError } from '../../ratelimit/rate-limiter.js';
import type { MentionedItem } from '../../contracts/mentioned-item.js';
import { toMentionedItem, resolveMentionedItems } from '../mentioned-items.js';

/**
 * Every field optional: an argument-less call is a valid "what's popular?" browse. Unknown keys
 * are ignored rather than rejected — a model inventing a filter should still get its search.
 */
const searchArgs = z.object({
  query: z.string().min(1).optional(),
  sort: z.enum(['relevance', 'popularity']).optional(),
  max_price_cents: z.number().int().nonnegative().optional(),
  min_price_cents: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
});

/** What one tool call produced: a `content` string appended to the scratchpad (fed back to the
 *  model on a loop), plus `output` when `propose_cart` validated (the terminal action). `error`
 *  is set on the branches whose `content` is a tool error for the agent to retry — it carries no
 *  information the scratchpad lacks, it just spares the log site from re-deriving the outcome by
 *  matching on prose. `meta` holds tool-specific fields for the call's log line. */
interface ToolExecResult {
  content: string;
  output?: OrderGraphOutput;
  /** A short spoken confirmation bundled into `propose_cart` (approach B): the agent may commit
   *  operations AND speak in one terminal call. Set only when a non-blank `reply` was supplied. */
  reply?: string;
  /** The language the agent declared `reply` is in; omitted when absent or malformed (the caller
   *  then defaults to `TTS_LANGUAGE`, matching the standalone spoken-reply path). */
  reply_language?: LangCode;
  /** Set only by a `search_menu` call: this call's items, projected and keyed by
   *  `menu_item_key`, for `runTools` to fold into the turn's accumulated `search_results`. */
  search_results?: Record<string, MentionedItem>;
  /** Set only by a `propose_cart` call that bundled a `reply`: the raw keys it declared the reply
   *  named. Deferred here rather than resolved inline — this function does not see search calls
   *  made earlier in the SAME batch, only `runTools` accumulates that as it iterates. */
  mentioned_item_keys?: string[];
  error?: string;
  meta?: Record<string, unknown>;
}

/**
 * Resolve the items a batch's `add_item` ops name (concurrently, one read per DISTINCT key), then
 * run the pure required-group check. A menu read that fails or misses resolves to "unknown", which
 * the checker skips — an unreachable menu must not block an order.
 */
async function findViolations(
  menu: MenuService,
  s: OrderStateType,
  operations: OrderGraphOutput['operations'],
): Promise<string[]> {
  const keys = [
    ...new Set(operations.filter((o) => o.action === 'add_item').map((o) => o.menu_item_key)),
  ];
  const resolved = await Promise.all(
    keys.map(async (key) => {
      try {
        return [key, await menu.resolveItemKey(s.pos_config_id, key)] as const;
      } catch (err) {
        // Skipping the check is the deliberate degrade, but it is logged at ERROR, not warn: a
        // genuine menu miss RETURNS undefined, so a THROW is always abnormal (a broken query, a
        // missing method, Postgres down). Left at warn, a permanent breakage that silently
        // disables the whole check would be indistinguishable from routine noise.
        logger.error('order.required_modifier_check_skipped', {
          menu_item_key: key,
          request_id: s.request_id,
          cart_id: s.cart_id,
          message: messageOf(err),
        });
        return [key, undefined] as const;
      }
    }),
  );
  const itemsByKey = new Map(
    resolved.filter((e): e is readonly [string, MenuItem] => e[1] !== undefined),
  );
  return findRequiredModifierViolations(operations, s.cart_view, itemsByKey);
}

/** Runtime constructors for a programming mistake: a property read off `undefined`, a bad array
 *  length, a missing binding. Nothing a tool can retry its way out of. */
const BUG_SHAPED = [TypeError, RangeError, ReferenceError] as const;

/** How far down the `cause` chain to look for IO evidence — `fetch` hides the socket error one
 *  level deep and SDKs add a couple more. Mirrors `arrival.ts`. */
const MAX_CAUSE_DEPTH = 5;

/** True when the error carries transport evidence anywhere in its cause chain: an HTTP status or a
 *  socket/system `code`. This is what keeps `TypeError: fetch failed` — the shape `fetch` reports
 *  EVERY network failure in, with the real `code` on `cause` — on the retriable side. */
function hasIoEvidence(err: unknown): boolean {
  let node: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (node === null || typeof node !== 'object') return false;
    const e = node as { status?: unknown; statusCode?: unknown; code?: unknown; cause?: unknown };
    if (typeof e.status === 'number' || typeof e.statusCode === 'number') return true;
    if (typeof e.code === 'string') return true;
    node = e.cause;
  }
  return false;
}

/** Is this throw a failed tool/IO call the agent can usefully retry, or a bug in our own code? */
function isRetriableToolFailure(err: unknown): boolean {
  if (err instanceof RateLimitTimeoutError) return true;
  if (!BUG_SHAPED.some((ctor) => err instanceof ctor)) return true;
  return hasIoEvidence(err);
}

/**
 * Execute one tool call, converting a failed tool/IO call into the retriable tool-error channel the
 * agent already understands (`content` fed back to the model, `error` set for the log line).
 *
 * Without this, an exception from a tool — a `search_menu` whose embedder was rate-limited, a
 * Postgres blip — escapes the graph node and kills the whole turn. That is the wrong blast radius
 * for one failed retrieval: the agent can search again, search differently, or end the turn by
 * asking the customer, and the loop is already bounded by `LIMITS.maxAgentSteps`. It is also the
 * wrong DIAGNOSIS: an embedding-quota timeout escaping to `order-understanding-service` was
 * reported to operators as `llm_rate_limited`, blaming a provider that was never involved.
 *
 * The catch is FILTERED for the same reason. A programming error here — a `TypeError` out of
 * `parseAgentReply`, `toMentionedItem` or `parseOrderGraphOutput` — is not retriable, and folding
 * it into this channel is strictly worse than letting it escape: it is logged at WARN as a routine
 * bad tool call, replayed to the model up to `maxAgentSteps` times, and finally kills the turn as
 * `agent_step_limit` — a reason that describes nothing about the actual fault. Bug-shaped throws
 * therefore propagate to `order.node_failed` / `order_parse_failed`, where they name themselves.
 */
async function executeToolCall(menu: MenuService, s: OrderStateType, call: ToolCall): Promise<ToolExecResult> {
  try {
    return await runToolCall(menu, s, call);
  } catch (err) {
    if (!isRetriableToolFailure(err)) throw err;
    // Saturation is named separately from a broken tool so the two are distinguishable in the
    // logs, and so the message steers the agent somewhere useful: retrying a rate-limited call
    // immediately just burns steps against a provider that is already saying stop.
    const limited = err instanceof RateLimitTimeoutError;
    // Name the tool that actually ran out of capacity. The message used to say "menu search is
    // temporarily unavailable … do not repeat this search" for EVERY tool, so a saturated
    // `propose_cart` steered the agent with advice about a search it never made.
    const error = limited
      ? `Error: ${call.name} is temporarily unavailable (capacity). Do not repeat this call — end this turn with a spoken reply: answer from what you already know, or tell the customer you could not complete their request just now.`
      : `Error: tool "${call.name}" failed: ${messageOf(err)}`;
    return { content: error, error, meta: { rate_limited: limited } };
  }
}

/** Execute one tool call against the (in-progress) turn state. */
async function runToolCall(menu: MenuService, s: OrderStateType, call: ToolCall): Promise<ToolExecResult> {
  switch (call.name) {
    case TOOL_NAMES.search: {
      const parsed = searchArgs.safeParse(call.arguments);
      if (!parsed.success) {
        const error = `Invalid arguments: ${formatZodError(parsed.error)}`;
        return { content: error, error };
      }
      const set = await menu.searchMenu(s.pos_config_id, parsed.data);
      const search_results: Record<string, MentionedItem> = {};
      for (const item of set.items) search_results[item.menu_item_key] = toMentionedItem(item);
      // Spreading the parsed args logs only the filters the model actually sent (absent optionals
      // are not keys), so a bare browse stays a bare line. `results` is the other half of the
      // story: a filter combination that matched nothing is what sends the agent round the loop.
      return {
        content: JSON.stringify(set.items),
        search_results,
        meta: { ...parsed.data, results: set.items.length },
      };
    }
    case TOOL_NAMES.propose: {
      const argsObj = (call.arguments ?? {}) as Record<string, unknown>;
      const result = parseOrderGraphOutput({ operations: argsObj.operations });
      if (!result.ok) {
        const error = `Validation error: ${result.error.message}`;
        return { content: error, error };
      }
      // `operations` defaults to [] when absent/unparsable, so a malformed call would otherwise
      // "succeed" as an empty proposal and silently drop the customer's request. Reject it as a
      // retriable tool error instead — a turn with nothing to change must end with a spoken reply.
      if (result.value.operations.length === 0) {
        const error =
          'Validation error: propose_cart needs at least one operation. If there is nothing to change, do not call propose_cart — reply to the customer in words instead.';
        return { content: error, error };
      }
      // Required modifier groups (display_type <> 'multi') must carry EXACTLY ONE selection. Odoo
      // enforces this nowhere, so we do — as a retriable tool error, which is what lets the agent
      // turn around and ASK the customer within the same turn instead of guessing a default.
      const violations = await findViolations(menu, s, result.value.operations);
      if (violations.length > 0) {
        const error = `Validation error: ${violations.join(' ')}`;
        return { content: error, error };
      }
      // A `propose_cart` may bundle a spoken confirmation (approach B): commit AND speak in one
      // terminal call. Its reply fields are parsed by the same function as the standalone spoken
      // terminal, so the two can't drift on what counts as a usable reply; an absent one is not an
      // error. `null` there means "nothing to say", which is `undefined` in this result shape.
      const agentReply = parseAgentReply(argsObj);
      const reply = agentReply.reply !== null ? agentReply.reply : undefined;
      return {
        content: 'Proposal accepted.',
        output: result.value,
        ...(reply !== undefined ? { reply, mentioned_item_keys: agentReply.mentioned_items } : {}),
        ...(agentReply.language !== undefined ? { reply_language: agentReply.language } : {}),
        meta: { operations: result.value.operations.length, ...(reply !== undefined ? { reply: true } : {}) },
      };
    }
    default: {
      const error = `Error: unknown tool "${call.name}".`;
      return { content: error, error };
    }
  }
}

/**
 * The `tools` node (docs/agent-tools.md §3.1): run the tool calls the agent just requested, append
 * each result to the turn scratchpad (`agent_messages`), and carry the `output` a successful
 * `propose_cart` set. Returns a state patch. A `propose_cart` that fails validation sets no
 * `output` — it is a tool error the agent retries (bounded by `maxAgentSteps`); the loop router
 * sends control back to the agent because no terminal channel was written. A tool that THROWS
 * lands in that same channel rather than failing the whole turn (see {@link executeToolCall}).
 */
export async function runTools(menu: MenuService, s: OrderStateType): Promise<Partial<OrderStateType>> {
  const last = s.agent_messages.at(-1);
  const calls = last?.role === 'assistant' && last.tool_calls ? last.tool_calls : [];

  let output = s.output;
  // `propose_cart` may bundle these (approach B). Only assigned when a call sets them, so a turn
  // without a bundled reply leaves them unset and `lww` keeps the normalized (cleared) defaults.
  let reply: string | undefined;
  let reply_language: LangCode | undefined;
  // Accumulated across every `search_menu` call in this batch, seeded from the turn's existing
  // `search_results` so a later agent step keeps what an earlier step already found. Left
  // `undefined` when this batch has no search call, so the returned patch omits the key entirely
  // and `lww` leaves the channel (this turn's accumulation so far, or the normalized default) alone.
  let search_results: Record<string, MentionedItem> | undefined;
  // Set only when this batch's `propose_cart` bundled a reply — resolved against everything
  // accumulated in THIS batch so far (a same-batch search feeding a same-batch propose must still
  // resolve), not just the turn's state entering this node.
  let mentioned_items: MentionedItem[] | undefined;
  const toolMsgs: AgentMessage[] = [];

  for (const call of calls) {
    const started = Date.now();
    const res = await executeToolCall(menu, s, call);
    toolMsgs.push({ role: 'tool', tool_call_id: call.id, content: res.content });
    if (res.output !== undefined) output = res.output;
    if (res.reply !== undefined) reply = res.reply;
    if (res.reply_language !== undefined) reply_language = res.reply_language;
    // Later calls win on a key collision — the fresher read.
    if (res.search_results !== undefined) {
      search_results = { ...(search_results ?? s.search_results), ...res.search_results };
    }
    // Unresolvable keys never fail the call — the proposal already committed via `output` above.
    let mentionedCount: number | undefined;
    if (res.mentioned_item_keys !== undefined) {
      mentioned_items = resolveMentionedItems(res.mentioned_item_keys, search_results ?? s.search_results, {
        request_id: s.request_id,
        cart_id: s.cart_id,
      });
      mentionedCount = mentioned_items.length;
    }

    const meta = {
      tool: call.name,
      ok: res.error === undefined,
      ms: Date.now() - started,
      request_id: s.request_id,
      cart_id: s.cart_id,
      ...res.meta,
      ...(mentionedCount !== undefined ? { mentioned_items: mentionedCount } : {}),
    };
    // A tool error is the agent's problem to retry, not a fault of ours — warn, don't error, so
    // `order.node_failed` stays the signal for a genuinely broken turn.
    if (res.error !== undefined) logger.warn('order.agent_tool', { ...meta, error: res.error });
    else logger.info('order.agent_tool', meta);
  }

  return {
    agent_messages: [...s.agent_messages, ...toolMsgs],
    output,
    ...(reply !== undefined ? { reply } : {}),
    ...(reply_language !== undefined ? { reply_language } : {}),
    ...(search_results !== undefined ? { search_results } : {}),
    ...(mentioned_items !== undefined ? { mentioned_items } : {}),
  };
}
