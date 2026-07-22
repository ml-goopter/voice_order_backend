import { z } from 'zod';
import type { AgentMessage, ToolCall } from '../../llm/llm-provider.js';
import type { LangCode } from '../../shared/types.js';
import type { MenuService } from '../../menu/menu-service.js';
import type { OrderStateType } from '../graph/state.js';
import type { OrderGraphOutput } from '../schemas/order-graph-output.schema.js';
import { parseOrderGraphOutput } from '../schemas/order-graph-output.schema.js';
import { parseAgentReply } from '../graph/parse-agent-reply.js';
import { formatZodError } from '../../shared/zod-error.js';
import { TOOL_NAMES } from './tool-specs.js';
import { logger } from '../../config/logger.js';
import type { MentionedItem } from '../../contracts/mentioned-item.js';
import { toMentionedItem } from '../mentioned-items.js';

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
  error?: string;
  meta?: Record<string, unknown>;
}

/** Execute one tool call against the (in-progress) turn state. */
async function executeToolCall(menu: MenuService, s: OrderStateType, call: ToolCall): Promise<ToolExecResult> {
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
      // A `propose_cart` may bundle a spoken confirmation (approach B): commit AND speak in one
      // terminal call. Its reply fields are parsed by the same function as the standalone spoken
      // terminal, so the two can't drift on what counts as a usable reply; an absent one is not an
      // error. `null` there means "nothing to say", which is `undefined` in this result shape.
      const agentReply = parseAgentReply(argsObj);
      const reply = agentReply.reply !== null ? agentReply.reply : undefined;
      return {
        content: 'Proposal accepted.',
        output: result.value,
        ...(reply !== undefined ? { reply } : {}),
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
 * sends control back to the agent because no terminal channel was written.
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

    const meta = {
      tool: call.name,
      ok: res.error === undefined,
      ms: Date.now() - started,
      request_id: s.request_id,
      cart_id: s.cart_id,
      ...res.meta,
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
  };
}
