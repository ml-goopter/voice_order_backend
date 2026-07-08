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
import { TIMEOUTS } from '../config/constants.js';
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

    try {
      session.stream = await this.stt.openStream({
        // Partial: display-only, straight back to the client (never enters backend flow, §3).
        onPartial: (text) => conn.send({ type: 'voice.partial_transcript', session_id: session.session_id, text }),
        // Final: the one signal that may touch the cart (§11 invariant).
        onFinal: (text, language) => {
          // A final that lands after the session already went terminal (timeout-failed,
          // ended, or interrupted) must not touch the cart — the customer was already
          // asked to repeat (§11.2 C).
          if (session.status === 'ended' || session.status === 'failed' || session.status === 'interrupted') return;
          session.finalReceived = true;
          this.bus.emit('stt.final_transcript.received', {
            request_id: newRequestId(),
            session_id: session.session_id,
            cart_id: session.cart_id,
            pos_config_id: session.pos_config_id,
            text,
            ...(language !== undefined ? { language } : {}),
          });
          // A final that arrives after voice.stop clears the §11.2 C timeout and
          // closes out the session cleanly.
          if (session.finalTimer) {
            clearTimeout(session.finalTimer);
            session.finalTimer = null;
            session.status = 'ended';
            this.bus.emit('voice.session_ended', { session_id: session.session_id, cart_id: session.cart_id });
          }
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
    } catch (error) {
      // Auth/handshake failure (§11.2 A): the session never became listenable.
      // Tear it down and tell the client, mirroring the onError path.
      this.manager.remove(session.session_id);
      logger.warn('voice.stt_open_failed', {
        session_id: session.session_id,
        error: (error as Error).message,
      });
      conn.send({
        type: 'voice.error',
        session_id: session.session_id,
        reason: 'stt_failed',
        message: 'Speech recognition is unavailable. Please try again.',
      });
      this.bus.emit('voice.session_failed', {
        session_id: session.session_id,
        cart_id: session.cart_id,
        reason: 'stt_failed',
      });
      return;
    }
    session.status = 'listening';
  }

  handleAudioChunk(conn: ClientConnection, msg: VoiceAudioChunkMsg): void {
    const session = this.manager.get(conn.session_id);
    if (!session?.stream || session.status !== 'listening' || session.stopping) return;
    session.stream.sendAudio(Buffer.from(msg.audio, 'base64'));
  }

  async handleStop(conn: ClientConnection, _msg: VoiceStopMsg): Promise<void> {
    const session = this.manager.get(conn.session_id);
    if (!session?.stream) return;
    // Ignore a repeat/concurrent voice.stop: a flush is already in flight (stopping),
    // a grace window is pending (finalTimer set), or the session already went terminal.
    // Re-running would flush a closing socket and orphan the first timer.
    if (session.stopping || session.finalTimer || session.status === 'ended' || session.status === 'failed') return;
    // Committed to stopping: stop feeding audio into the stream we're about to flush.
    session.stopping = true;
    // Flush the stream; a pending final may be delivered during/just after this.
    await session.stream.stop();
    if (session.finalReceived) {
      session.status = 'ended';
      this.bus.emit('voice.session_ended', { session_id: session.session_id, cart_id: session.cart_id });
      return;
    }
    // §11.2 C — no final yet: give it a bounded grace window, then fail the session
    // and ask the customer to repeat (never parse a partial as final).
    session.finalTimer = setTimeout(() => {
      session.finalTimer = null;
      // A final landed, or the session already failed (e.g. a provider error during
      // flush) — don't fail it a second time.
      if (session.finalReceived || session.status === 'failed') return;
      session.status = 'failed';
      conn.send({
        type: 'voice.error',
        session_id: session.session_id,
        reason: 'final_transcript_timeout',
        message: 'I did not catch that. Please try again.',
      });
      this.bus.emit('voice.session_failed', {
        session_id: session.session_id,
        cart_id: session.cart_id,
        reason: 'final_transcript_timeout',
      });
    }, TIMEOUTS.finalTranscriptMs);
  }

  /** Socket closed while listening: discard partials, keep cart, ask to repeat (§5/§11.1). */
  handleDisconnect(session_id: string): void {
    const session = this.manager.get(session_id);
    if (session) {
      if (session.finalTimer) {
        clearTimeout(session.finalTimer);
        session.finalTimer = null;
      }
      if (session.status === 'listening') session.status = 'interrupted';
    }
    this.manager.remove(session_id);
  }
}
