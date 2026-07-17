import type { LangCode, CartId, PosConfigId, RequestId, SessionId } from '../shared/types.js';
import type { MenuService } from '../menu/menu-service.js';
import type { LlmProvider } from '../llm/llm-provider.js';
import type { CartCache } from '../redis/cart-cache.js';
import type { OrderGraphOutput } from './schemas/order-graph-output.schema.js';
import type { Intent } from '../contracts/intent.js';
import { buildOrderGraph } from './graph/build-graph.js';
import { cacheHitRate, type TurnUsage } from '../llm/usage.js';
import { logger } from '../config/logger.js';

export interface OrderGraphParams {
  request_id: RequestId;
  session_id: SessionId;
  cart_id: CartId;
  pos_config_id: PosConfigId;
  text: string;
  supported_languages: LangCode[];
}

/**
 * Outcome of a graph turn — determined by how the agent ended the turn (docs/agent-tools.md §3),
 * not by an upstream router. `complete` — the agent committed operations via `propose_cart`;
 * `reply` — the agent ended by speaking to the customer (a clarifying question OR a recommendation;
 * fire-and-forget, no pause); `junk` — the classifier junk-gate short-circuited a non-orderable
 * utterance (the agent never ran); `fail` — the agent loop ended without a terminal (e.g.
 * `agent_step_limit`), which the façade surfaces as a session failure.
 */
export type GraphTurnResult =
  | { status: 'complete'; output: OrderGraphOutput; base_version: number }
  | { status: 'reply'; reply: string; language?: LangCode }
  | { status: 'junk' }
  | { status: 'fail'; reason: string };

type InvokeReturn = {
  intent: Intent;
  output: OrderGraphOutput | null;
  base_version: number;
  reply: string | null;
  /** The language the agent declared it wrote `reply` in; absent when it declared none. Its own
   *  channel, not the STT `language` input — so "absent" really means the agent stayed silent on
   *  it, and the caller's fallback to the STT code actually fires. */
  reply_language?: LangCode;
  failure_reason: string | undefined;
  token_usage: TurnUsage;
};

/**
 * Turns a final transcript into proposed operations or a spoken reply (docs/agent-tools.md),
 * backed by @langchain/langgraph with a cart-keyed checkpointer so conversation history
 * follows the CART across turns. The thread id is `${pos_config_id}:${cart_id}`, not a
 * single voice session (design §6). A reply is fire-and-forget: the graph records it to history
 * and ends; the answer arrives as the next transcript. The per-cart FIFO that serializes turns
 * lives in OrderUnderstandingService, in front of this graph.
 */
export class OrderGraph {
  private readonly graph: ReturnType<typeof buildOrderGraph>;
  private readonly llm: LlmProvider;

  // `intentLlm` is the intent classifier's own provider (its own creds, design §6); it defaults
  // to the parser `llm` so a caller that doesn't wire a separate one shares a single provider.
  constructor(menu: MenuService, llm: LlmProvider, carts: CartCache, intentLlm: LlmProvider = llm) {
    this.llm = llm;
    this.graph = buildOrderGraph({ menu, llm, intentLlm, carts });
  }

  /** Start a new turn. A node throw rejects (caller fails the turn); the agent's own dead-ends
   *  (step limit / empty reply) surface as a `fail` GraphTurnResult rather than a throw. */
  async start(p: OrderGraphParams): Promise<GraphTurnResult> {
    const input = {
      request_id: p.request_id,
      session_id: p.session_id,
      cart_id: p.cart_id,
      pos_config_id: p.pos_config_id,
      customer_text: p.text,
      supported_languages: p.supported_languages,
    };
    const out = (await this.graph.invoke(input, this.threadConfig(p.pos_config_id, p.cart_id))) as InvokeReturn;
    this.logTurnUsage(p, out.token_usage);
    return this.interpret(out);
  }

  /** Emit the per-turn agent-loop usage rollup (`llm.turn_usage`), tagged with the turn's
   *  correlation ids and the parser model. Skipped when the agent never ran (junk turns) or the
   *  provider reported no usage. Cache fields are omitted unless some call reported cache detail —
   *  see {@link TurnUsage}. Attributes the parser `llm`; the intent classifier's separate call is
   *  observable via its own per-call `llm.usage` line. */
  private logTurnUsage(p: OrderGraphParams, usage: TurnUsage): void {
    if (usage.calls === 0) return;
    const rate = usage.cacheReported ? cacheHitRate(usage.promptTokens, usage.cachedTokens) : null;
    logger.info('llm.turn_usage', {
      request_id: p.request_id,
      cart_id: p.cart_id,
      pos_config_id: p.pos_config_id,
      provider: this.llm.name,
      model: this.llm.model,
      steps: usage.calls,
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
      ...(usage.cacheReported ? { cached_tokens: usage.cachedTokens } : {}),
      ...(rate !== null ? { cache_hit_rate: rate } : {}),
    });
  }

  private interpret(out: InvokeReturn): GraphTurnResult {
    // The junk-gate short-circuits before the agent runs: nothing to propose or say.
    if (out.intent === 'junk') return { status: 'junk' };
    // The agent loop ended without a terminal (step-limit exhaustion, or an empty reply).
    if (out.failure_reason !== undefined) return { status: 'fail', reason: out.failure_reason };
    // Otherwise the outcome is however the agent ended the turn: committed operations, or spoke.
    if (out.output !== null) return { status: 'complete', output: out.output, base_version: out.base_version };
    if (out.reply !== null) {
      const lang = out.reply_language;
      return { status: 'reply', reply: out.reply, ...(lang !== undefined ? { language: lang } : {}) };
    }
    // Defensive: the agent finished with neither a terminal nor a recorded failure reason.
    return { status: 'fail', reason: 'agent_no_terminal' };
  }

  private threadConfig(pos_config_id: PosConfigId, cart_id: CartId) {
    return { configurable: { thread_id: `${pos_config_id}:${cart_id}` } };
  }
}
