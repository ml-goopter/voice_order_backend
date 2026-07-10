/**
 * The internal event contract between modules (design §2 "Core internal events").
 * Modules communicate ONLY through these events; direct calls stay within a module.
 */
import type { CartId, LangCode, PosConfigId, RequestId, SessionId } from '../shared/types.js';
import type { Cart } from '../cart/cart-types.js';
import type { CartOperation } from '../ordering/schemas/cart-operation.schema.js';
import type { OrderProposal } from '../ordering/schemas/proposal.js';

export interface SttFinalTranscriptReceived {
  request_id: RequestId;
  session_id: SessionId;
  cart_id: CartId;
  pos_config_id: PosConfigId;
  text: string;
  language?: LangCode;
}

export interface OrderOperationsProposed {
  session_id: SessionId;
  /** Turn id — duplicated from `proposal` at the top level so the event bus can trace it. */
  request_id: RequestId;
  cart_id: CartId;
  proposal: OrderProposal;
}

export interface OrderClarificationNeeded {
  cart_id: CartId;
  session_id: SessionId;
  request_id: RequestId;
  question: string;
  options?: string[];
}

export interface OrderClarificationAnswered {
  cart_id: CartId;
  session_id: SessionId;
  request_id: RequestId;
  answer: string;
}

export interface CartUpdated {
  cart_id: CartId;
  pos_config_id: PosConfigId;
  version: number;
  cart: Cart;
  /** Turn that produced this update, so the event bus can trace it. */
  request_id: RequestId;
}

export interface CartOperationRejected {
  cart_id: CartId;
  session_id?: SessionId;
  request_id: RequestId;
  reason: string; // "line_gone" | "stale_edit" | "unavailable_item" | ...
  message: string; // customer-facing
  operation?: CartOperation;
}

export interface VoiceSessionFailed {
  session_id: SessionId;
  cart_id: CartId;
  reason: string;
}

export interface VoiceSessionEnded {
  session_id: SessionId;
  cart_id: CartId;
}

/** Event name → payload. Keys mirror design §2. */
export interface AppEventMap {
  'stt.final_transcript.received': SttFinalTranscriptReceived;
  'order.operations_proposed': OrderOperationsProposed;
  'order.clarification_needed': OrderClarificationNeeded;
  'order.clarification_answered': OrderClarificationAnswered;
  'cart.updated': CartUpdated;
  'cart.operation_rejected': CartOperationRejected;
  'voice.session_failed': VoiceSessionFailed;
  'voice.session_ended': VoiceSessionEnded;
}

export type AppEventName = keyof AppEventMap;
