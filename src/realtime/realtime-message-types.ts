/**
 * WebSocket message contracts (design §3). One socket carries both voice and cart.
 * Partial transcripts are display-only and never re-enter the backend event flow.
 */
import type { CartId, SessionId } from '../shared/types.js';
import type { Cart } from '../cart/cart-types.js';

// ── Inbound (mobile app → gateway) ────────────────────────────────────────────
export interface VoiceStartMsg {
  type: 'voice.start';
  session_id: SessionId;
  cart_id: CartId;
}
export interface VoiceAudioChunkMsg {
  type: 'voice.audio_chunk';
  session_id: SessionId;
  seq: number;
  audio: string; // base64-encoded PCM/opus frame
}
export interface VoiceStopMsg {
  type: 'voice.stop';
  session_id: SessionId;
}
export interface ClarificationAnsweredMsg {
  type: 'order.clarification_answered';
  session_id: SessionId;
  cart_id: CartId;
  request_id: string;
  answer: string;
}
export interface ConnectionResumeMsg {
  type: 'connection.resume';
  session_id: SessionId;
  cart_id: CartId;
  last_seen_cart_version: number;
}

export type InboundMessage =
  | VoiceStartMsg
  | VoiceAudioChunkMsg
  | VoiceStopMsg
  | ClarificationAnsweredMsg
  | ConnectionResumeMsg;

// ── Outbound (gateway → mobile app) ───────────────────────────────────────────
export interface PartialTranscriptMsg {
  type: 'voice.partial_transcript';
  session_id: SessionId;
  text: string;
}
export interface FinalTranscriptMsg {
  type: 'voice.final_transcript';
  session_id: SessionId;
  text: string;
  language?: string;
}
export interface ClarificationNeededMsg {
  type: 'order.clarification_needed';
  cart_id: CartId;
  request_id: string;
  question: string;
  options?: string[];
}
export interface CartUpdatedMsg {
  type: 'cart.updated';
  cart_id: CartId;
  version: number;
  cart: Cart;
}
export interface CartOperationRejectedMsg {
  type: 'cart.operation_rejected';
  cart_id: CartId;
  request_id: string;
  reason: string;
  message: string;
}
export interface VoiceErrorMsg {
  type: 'voice.error';
  session_id: SessionId;
  reason: string;
  message: string;
}
export interface ConnectionResumedMsg {
  type: 'connection.resumed';
  session_id: SessionId;
  cart_id: CartId;
  cart_version: number;
  cart: Cart;
  voice_session_status: string;
}

export type OutboundMessage =
  | PartialTranscriptMsg
  | FinalTranscriptMsg
  | ClarificationNeededMsg
  | CartUpdatedMsg
  | CartOperationRejectedMsg
  | VoiceErrorMsg
  | ConnectionResumedMsg;

export function parseInbound(raw: string): InboundMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const type = (data as Record<string, unknown>)['type'];
  // Trust-but-verify at the module boundary; handlers re-validate their fields.
  switch (type) {
    case 'voice.start':
    case 'voice.audio_chunk':
    case 'voice.stop':
    case 'order.clarification_answered':
    case 'connection.resume':
      return data as InboundMessage;
    default:
      return null;
  }
}
