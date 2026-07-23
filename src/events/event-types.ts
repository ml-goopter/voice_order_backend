/**
 * The internal event contract between modules (design §2 "Core internal events").
 * Modules communicate ONLY through these events; direct calls stay within a module.
 */
import type {
  CartId,
  DeviceId,
  LangCode,
  PosConfigId,
  RequestId,
  RestaurantTableId,
  SessionId,
} from '../shared/types.js';
import type { Cart } from '../cart/cart-types.js';
import type { CartOperation } from '../contracts/cart-operation.schema.js';
import type { OrderProposal } from '../contracts/proposal.js';
import type { MentionedItem } from '../contracts/mentioned-item.js';

/** No `language`: STT's per-turn language detection is not used anywhere (docs/text-to-speech.md
 *  §Multilingual). The agent declares the reply's language instead — see `OrderReply.language`. */
export interface SttFinalTranscriptReceived {
  request_id: RequestId;
  session_id: SessionId;
  cart_id: CartId;
  pos_config_id: PosConfigId;
  text: string;
}

export interface OrderOperationsProposed {
  session_id: SessionId;
  /** Turn id — duplicated from `proposal` at the top level so the event bus can trace it. */
  request_id: RequestId;
  cart_id: CartId;
  proposal: OrderProposal;
}

/**
 * The agent ended a turn by speaking to the customer instead of committing operations — one
 * merged outcome that covers both a clarifying question and a recommendation (docs/agent-tools.md
 * §3). Fire-and-forget: the customer's answer arrives as the next transcript.
 */
export interface OrderReply {
  cart_id: CartId;
  session_id: SessionId;
  request_id: RequestId;
  /** The spoken reply (a question or a recommendation). */
  reply: string;
  /** The language the AGENT declared it wrote `reply` in, so TTS speaks it in the language it was
   *  actually written in. `en` when it declared none. Never sourced from STT detection. */
  language: LangCode;
  /** Menu items the reply named, verified against this turn's search results. Absent when the
   *  reply named nothing verifiable — optional so an existing client is unaffected. */
  mentioned_items?: MentionedItem[];
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

/**
 * A client socket authenticated and attached to a cart. The cart module uses this to create the
 * cart with its durable identity (device, and table for dine-in) before any ordering happens —
 * identity is not threaded through the ordering module, which has no use for it.
 */
export interface ClientConnected {
  cart_id: CartId;
  pos_config_id: PosConfigId;
  session_id: SessionId;
  device_id: DeviceId;
  table_id?: RestaurantTableId;
}

/**
 * A turn failed inside a module that owns no client socket (the ordering service). The realtime
 * gateway subscribes and relays it to the customer's socket as a `voice.error` frame. Voice's own
 * STT/timeout failures notify the client directly (they hold the socket) and do not emit this.
 */
export interface VoiceSessionFailed {
  session_id: SessionId;
  cart_id: CartId;
  reason: string;
  /** Customer-facing text the gateway relays in the `voice.error` frame. */
  message: string;
}

export interface VoiceSessionEnded {
  session_id: SessionId;
  cart_id: CartId;
}

/** Event name → payload. Keys mirror design §2. */
export interface AppEventMap {
  'client.connected': ClientConnected;
  'stt.final_transcript.received': SttFinalTranscriptReceived;
  'order.operations_proposed': OrderOperationsProposed;
  'order.reply': OrderReply;
  'cart.updated': CartUpdated;
  'cart.operation_rejected': CartOperationRejected;
  'voice.session_failed': VoiceSessionFailed;
  'voice.session_ended': VoiceSessionEnded;
}

export type AppEventName = keyof AppEventMap;
