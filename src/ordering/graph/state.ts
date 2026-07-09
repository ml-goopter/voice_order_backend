import { Annotation } from '@langchain/langgraph';
import type { CartId, LangCode, PosConfigId, RequestId, SessionId } from '../../shared/types.js';
import type { CandidateItem } from '../../menu/menu-types.js';
import type { OrderGraphOutput } from '../schemas/order-graph-output.schema.js';
import type { CartView, HistoryTurn } from '../schemas/order-graph-input.schema.js';
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
 * Accumulate prior turns' utterances + clarification answers across turns (Plan A), capped to
 * the newest `LIMITS.maxHistoryTurns`. The `finalize` node appends the completed turn; a later
 * turn's `parse` re-sends this as conversation context so references ("that", "the same")
 * resolve.
 */
function appendHistory() {
  return Annotation<HistoryTurn[]>({
    reducer: (prev, next) => mergeHistory(prev, next, LIMITS.maxHistoryTurns),
    default: () => [],
  });
}

/**
 * Order Understanding graph state (design §6). Input channels are supplied on
 * invoke; the rest are filled by nodes. `base_version` is captured at cart load
 * and rides through resumes so the proposal always carries the version it was
 * computed against (design §9).
 */
export const OrderState = Annotation.Root({
  // ── inputs (provided at invoke) ──
  request_id: Annotation<RequestId>(),
  session_id: Annotation<SessionId>(),
  cart_id: Annotation<CartId>(),
  pos_config_id: Annotation<PosConfigId>(),
  customer_text: Annotation<string>(),
  language: lww<LangCode | undefined>(() => undefined),
  supported_languages: lww<LangCode[]>(() => []),

  // ── working state (filled by nodes) ──
  clarification_answer: lww<string | undefined>(() => undefined),
  clarification_question: lww<string | undefined>(() => undefined),
  cart_view: lww<CartView | null>(() => null),
  base_version: lww<number>(() => 0),
  candidates: lww<CandidateItem[]>(() => []),
  history: appendHistory(),
  output: lww<OrderGraphOutput | null>(() => null),
});

export type OrderStateType = typeof OrderState.State;
