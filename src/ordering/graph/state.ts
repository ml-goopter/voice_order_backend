import { Annotation } from '@langchain/langgraph';
import type { CartId, LangCode, PosConfigId, RequestId, SessionId } from '../../shared/types.js';
import type { Cart } from '../../cart/cart-types.js';
import type { CandidateItem } from '../../menu/menu-types.js';
import type { OrderGraphOutput } from '../schemas/order-graph-output.schema.js';

/** last-write-wins channel with a default, so it can be read before it is written. */
function lww<T>(def: () => T) {
  return Annotation<T>({ reducer: (_prev: T, next: T) => next, default: def });
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
  cart: lww<Cart | null>(() => null),
  base_version: lww<number>(() => 0),
  candidates: lww<CandidateItem[]>(() => []),
  output: lww<OrderGraphOutput | null>(() => null),
});

export type OrderStateType = typeof OrderState.State;
