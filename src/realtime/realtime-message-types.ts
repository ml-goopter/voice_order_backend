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
export interface OrderReplyMsg {
  type: 'order.reply';
  cart_id: CartId;
  request_id: string;
  /** The spoken reply — a clarifying question or a recommendation (one merged outcome). */
  reply: string;
}
/**
 * Spoken-reply audio (from `order.reply`), streamed as base64 inside JSON — the socket carries no
 * binary frames. Sequence per reply: `tts.audio_start` → `tts.audio_chunk` × N → `tts.audio_end`
 * (or `tts.error`). The reply is split into ≈sentence segments and each `tts.audio_chunk` is one
 * **complete, standalone** audio file for a segment (a self-contained mp3), sent as soon as it is
 * synthesized so the client can play it while later segments are still being made. A new
 * `tts.audio_start` (new `request_id`) supersedes any prior reply's audio.
 */
export interface TtsAudioStartMsg {
  type: 'tts.audio_start';
  session_id: SessionId;
  request_id: string;
  encoding: string; // 'mp3' by default; 'linear16' etc.
  sample_rate?: number; // present only for raw-PCM encodings (linear16)
}
export interface TtsAudioChunkMsg {
  type: 'tts.audio_chunk';
  session_id: SessionId;
  request_id: string;
  seq: number; // 0-based segment index, monotonically increasing within one reply
  audio: string; // base64 of one complete, standalone audio file (a self-contained mp3) for the segment
}
export interface TtsAudioEndMsg {
  type: 'tts.audio_end';
  session_id: SessionId;
  request_id: string;
}
export interface TtsErrorMsg {
  type: 'tts.error';
  session_id: SessionId;
  request_id: string;
  message: string;
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
  | OrderReplyMsg
  | TtsAudioStartMsg
  | TtsAudioChunkMsg
  | TtsAudioEndMsg
  | TtsErrorMsg
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
    case 'connection.resume':
      return data as InboundMessage;
    default:
      return null;
  }
}
