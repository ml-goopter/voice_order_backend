import type { EventBus } from '../events/event-bus.js';
import type { SttProvider } from '../stt/stt-provider.js';
import type { ClientConnection } from '../realtime/client-registry.js';
import type {
  VoiceAudioChunkMsg,
  VoiceStartMsg,
  VoiceStopMsg,
} from '../realtime/realtime-message-types.js';
import { VoiceSession } from './voice-session.js';
import type { VoiceSessionManager } from './voice-session-manager.js';
import { newRequestId } from '../shared/ids.js';
import { logger } from '../config/logger.js';

/**
 * Voice Module inbound handler (design §5). Owns STT streaming: relays partials to
 * the client for live display and emits the FINAL transcript to the event bus. It
 * never calls the LLM or mutates the cart.
 */
export class VoiceMessageHandler {
  constructor(
    private readonly manager: VoiceSessionManager,
    private readonly stt: SttProvider,
    private readonly bus: EventBus,
  ) {}

  async handleStart(conn: ClientConnection, _msg: VoiceStartMsg): Promise<void> {
    const session = this.manager.create(
      new VoiceSession(conn.session_id, conn.cart_id, conn.pos_config_id),
    );

    session.stream = await this.stt.openStream({
      // Partial: display-only, straight back to the client (never enters backend flow, §3).
      onPartial: (text) => conn.send({ type: 'voice.partial_transcript', session_id: session.session_id, text }),
      // Final: the one signal that may touch the cart (§11 invariant).
      onFinal: (text, language) => {
        this.bus.emit('stt.final_transcript.received', {
          request_id: newRequestId(),
          session_id: session.session_id,
          cart_id: session.cart_id,
          pos_config_id: session.pos_config_id,
          text,
          ...(language !== undefined ? { language } : {}),
        });
      },
      onError: (error) => {
        session.status = 'failed';
        logger.warn('voice.stt_error', { session_id: session.session_id, error: error.message });
        conn.send({
          type: 'voice.error',
          session_id: session.session_id,
          reason: 'stt_failed',
          message: 'Speech recognition disconnected. Please repeat your last sentence.',
        });
        this.bus.emit('voice.session_failed', {
          session_id: session.session_id,
          cart_id: session.cart_id,
          reason: 'stt_failed',
        });
      },
    });
    session.status = 'listening';
  }

  handleAudioChunk(conn: ClientConnection, msg: VoiceAudioChunkMsg): void {
    const session = this.manager.get(conn.session_id);
    if (!session?.stream || session.status !== 'listening') return;
    session.stream.sendAudio(Buffer.from(msg.audio, 'base64'));
  }

  async handleStop(conn: ClientConnection, _msg: VoiceStopMsg): Promise<void> {
    const session = this.manager.get(conn.session_id);
    if (!session?.stream) return;
    // TODO: start a final-transcript timeout (constants.TIMEOUTS.finalTranscriptMs, §11.2 C).
    await session.stream.stop();
    session.status = 'ended';
    this.bus.emit('voice.session_ended', { session_id: session.session_id, cart_id: session.cart_id });
  }

  /** Socket closed while listening: discard partials, keep cart, ask to repeat (§5/§11.1). */
  handleDisconnect(session_id: string): void {
    const session = this.manager.get(session_id);
    if (session && session.status === 'listening') session.status = 'interrupted';
    this.manager.remove(session_id);
  }
}
