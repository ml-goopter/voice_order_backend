import { Annotation } from '@langchain/langgraph';
import type { CartId, LangCode, PosConfigId, RequestId, SessionId } from '../../shared/types.js';
import type { AgentMessage } from '../../llm/llm-provider.js';
import type { OrderGraphOutput } from '../schemas/order-graph-output.schema.js';
import type { CartView, HistoryTurn } from '../schemas/order-graph-input.schema.js';
import { DEFAULT_INTENT } from './intents.js';
import type { Intent } from './intents.js';
import { LIMITS } from '../../config/constants.js';

/** last-write-wins channel with a default, so it can be read before it is written. */
function lww<T>(def: () => T) {
  return Annotation<T>({ reducer: (_prev: T, next: T) => next, default: def });
}

/**
 * Append the completed turn(s) in `next` after the persisted history in `prev`, keeping the
 * newest `cap` (oldest → newest order). Extracted so the semantics can be unit-tested without
 * LangGraph. Pure + deterministic (LangGraph requirement).
 */
export function mergeHistory(prev: HistoryTurn[], next: HistoryTurn[], cap: number): HistoryTurn[] {
  return [...prev, ...next].slice(-cap);
}

/**
 * Accumulate prior turns' utterances + the agent's spoken replies across turns (Plan A), capped to
 * the newest `LIMITS.maxHistoryTurns`. The `finalize` node appends the completed turn; a later
 * turn's `agent` re-sends this as conversation context so references ("that", "the same", answers
 * to a prior reply) resolve.
 */
function appendHistory() {
  return Annotation<HistoryTurn[]>({
    reducer: (prev, next) => mergeHistory(prev, next, LIMITS.maxHistoryTurns),
    default: () => [],
  });
}

/**
 * Order Understanding graph state (docs/agent-tools.md). Input channels are supplied on invoke;
 * the rest are filled by nodes. `base_version` is captured at cart load and rides through resumes
 * so the proposal always carries the version it was computed against (design §9). The agent
 * scratchpad channels are turn-scoped and cleared by `normalize` each fresh turn.
 */
export const OrderState = Annotation.Root({
  // ── inputs (provided at invoke) ──
  request_id: Annotation<RequestId>(),
  session_id: Annotation<SessionId>(),
  cart_id: Annotation<CartId>(),
  pos_config_id: Annotation<PosConfigId>(),
  customer_text: Annotation<string>(),
  // No STT-detected `language` input: the graph does not depend on STT language detection at all.
  // The agent reads the language off `customer_text` and declares it (see `reply_language`).
  supported_languages: lww<LangCode[]>(() => []),

  // ── working state (filled by nodes) ──
  intent: lww<Intent>(() => DEFAULT_INTENT),
  cart_view: lww<CartView | null>(() => null),
  base_version: lww<number>(() => 0),
  history: appendHistory(),
  // The agent's terminal outcomes (mutually exclusive per turn): `output` when it committed
  // operations via `propose_cart`; `reply` when it ended the turn by speaking to the customer.
  // Both cleared by `normalize` (the checkpointer persists everything, so anything left would leak).
  output: lww<OrderGraphOutput | null>(() => null),
  reply: lww<string | null>(() => null),
  // The language the agent declared it wrote `reply` in — the sole source of the reply's language.
  // Turn-scoped: a declaration is evidence about the turn that made it, so it must not outlive that
  // turn (a shared channel once leaked it into later turns that declared none). Cleared by
  // `normalize`; when absent the caller defaults the reply to English.
  reply_language: lww<LangCode | undefined>(() => undefined),
  // ── agent scratchpad (turn-scoped; docs/agent-tools.md §5) ──
  // The tool-calling transcript for THIS turn (assistant tool_calls ↔ tool results). Manually
  // appended by the `agent`/`tools` nodes and CLEARED by `normalize` each turn — it must never
  // persist across turns (checkpoint bloat + stale menu data). Never written to `history`.
  agent_messages: lww<AgentMessage[]>(() => []),
  // Count of `agent` LLM turns this turn; guards `LIMITS.maxAgentSteps`. Cleared by `normalize`.
  agent_steps: lww<number>(() => 0),
  // Set when the agent loop ends without a terminal (step-limit exhaustion, or an empty reply).
  // The façade maps it to `voice.session_failed`. Cleared by `normalize`.
  failure_reason: lww<string | undefined>(() => undefined),
});

export type OrderStateType = typeof OrderState.State;
