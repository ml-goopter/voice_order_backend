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
import { messageOf } from '../shared/errors.js';

/** Cap on audio chunks buffered during STT connect, so a stalled connect can't grow memory unbounded. */
const MAX_PENDING_AUDIO_CHUNKS = 200;

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
        onPartial: (text) => {
          conn.send({ type: 'voice.partial_transcript', session_id: session.session_id, text });
          // Reset the stopped-talking timer only on real speech progress — ignore empty or
          // keepalive partials and verbatim repeats so a genuine silence can actually elapse.
          if (text.trim() !== '' && text !== session.lastPartialText) {
            session.lastPartialText = text;
            this.armIdleStop(conn, session);
          }
        },
        // Final: the one signal that may touch the cart (§11 invariant).
        onFinal: (text) => {
          // A final that lands after the session already went terminal (timeout-failed,
          // ended, or interrupted) must not touch the cart — the customer was already
          // asked to repeat (§11.2 C).
          if (session.isTerminal) return;
          session.finalReceived = true;
          // Display twin of the partial: show the customer what we heard. Display-only —
          // the backend acts on its own internal copy (the bus event below), never this.
          conn.send({
            type: 'voice.final_transcript',
            session_id: session.session_id,
            text,
          });
          // Mint the turn id here and log it against the session so a developer can
          // pivot from a socket (session_id) to the turn (request_id) it spawned — the
          // one join point between the connection-scoped and turn-scoped logs.
          const request_id = newRequestId();
          logger.info('voice.final_transcript', {
            request_id,
            session_id: session.session_id,
            cart_id: session.cart_id,
          });
          this.bus.emit('stt.final_transcript.received', {
            request_id,
            session_id: session.session_id,
            cart_id: session.cart_id,
            pos_config_id: session.pos_config_id,
            text,
          });
          // A final that arrives after voice.stop clears the §11.2 C timeout and
          // closes out the session cleanly.
          if (session.finalTimer) {
            clearTimeout(session.finalTimer);
            session.finalTimer = null;
            session.status = 'ended';
            this.bus.emit('voice.session_ended', { session_id: session.session_id, cart_id: session.cart_id });
          }
          // A final is speech activity: reset the stopped-talking countdown for the next
          // utterance (no-op once the session ended above). Clear the last partial so the
          // next utterance's first partial always registers as fresh progress.
          session.lastPartialText = '';
          this.armIdleStop(conn, session);
        },
        onError: (error) => {
          if (session.stopTimer) {
            clearTimeout(session.stopTimer);
            session.stopTimer = null;
          }
          session.status = 'failed';
          logger.warn('voice.stt_error', { session_id: session.session_id, error: error.message });
          conn.send({
            type: 'voice.error',
            session_id: session.session_id,
            reason: 'stt_failed',
            message: 'Speech recognition disconnected. Please repeat your last sentence.',
          });
        },
      });
    } catch (error) {
      // Auth/handshake failure (§11.2 A): the session never became listenable.
      // Tear it down and tell the client, mirroring the onError path.
      this.manager.remove(session.session_id);
      logger.warn('voice.stt_open_failed', {
        session_id: session.session_id,
        error: messageOf(error),
      });
      conn.send({
        type: 'voice.error',
        session_id: session.session_id,
        reason: 'stt_failed',
        message: 'Speech recognition is unavailable. Please try again.',
      });
      return;
    }
    // Flush audio that arrived during the connect round-trip so the onset of speech
    // reaches STT in order, then go live for subsequent chunks.
    for (const chunk of session.pendingAudio) session.stream?.sendAudio(chunk);
    session.pendingAudio = [];
    session.status = 'listening';
  }

  handleAudioChunk(conn: ClientConnection, msg: VoiceAudioChunkMsg): void {
    const session = this.manager.get(conn.session_id);
    if (!session || session.stopping) return;
    // Terminal sessions get nothing more (a late chunk must never revive a flushed/failed turn).
    if (session.isTerminal) return;
    const audio = Buffer.from(msg.audio, 'base64');
    if (!session.stream || session.status !== 'listening') {
      // Stream still connecting: retain the onset of speech (bounded) instead of
      // dropping it, so nothing is lost to the connect round-trip.
      if (session.pendingAudio.length < MAX_PENDING_AUDIO_CHUNKS) session.pendingAudio.push(audio);
      return;
    }
    session.stream.sendAudio(audio);
  }

  async handleStop(conn: ClientConnection, _msg: VoiceStopMsg): Promise<void> {
    const session = this.manager.get(conn.session_id);
    if (!session?.stream) return;
    // Ignore a repeat/concurrent voice.stop: a flush is already in flight (stopping),
    // a grace window is pending (finalTimer set), or the session already went terminal.
    // Re-running would flush a closing socket and orphan the first timer.
    if (session.stopping || session.finalTimer || session.status === 'ended' || session.status === 'failed') return;
    // Committed to stopping: stop feeding audio into the stream we're about to flush,
    // and disarm the stopped-talking timer (this stop supersedes it).
    session.stopping = true;
    if (session.stopTimer) {
      clearTimeout(session.stopTimer);
      session.stopTimer = null;
    }
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
      if (session.stopTimer) {
        clearTimeout(session.stopTimer);
        session.stopTimer = null;
      }
      if (session.status === 'listening') session.status = 'interrupted';
    }
    this.manager.remove(session_id);
  }

  /**
   * Arm (or reset) the stopped-talking timer: if no further speech activity arrives
   * within `TIMEOUTS.partialIdleMs`, auto-fire voice.stop so the customer need not press
   * stop. Only tracked while actively listening — audio chunks keep flowing during
   * silence, so the timer rides on transcript activity (partials/finals), not audio.
   */
  private armIdleStop(conn: ClientConnection, session: VoiceSession): void {
    if (session.stopTimer) {
      clearTimeout(session.stopTimer);
      session.stopTimer = null;
    }
    if (session.status !== 'listening' || session.stopping) return;
    session.stopTimer = setTimeout(() => {
      session.stopTimer = null;
      if (session.status !== 'listening' || session.stopping) return;
      // Server-initiated stop: tell the client we closed the mic so it can drop its
      // listening UI (a client-sent voice.stop needs no such echo — it already knows).
      conn.send({ type: 'voice.stopped', session_id: session.session_id, reason: 'idle' });
      // No new speech for partialIdleMs → end-of-turn. Same flush/grace path as voice.stop.
      void this.handleStop(conn, { type: 'voice.stop', session_id: session.session_id });
    }, TIMEOUTS.partialIdleMs);
    // Housekeeping timer: never keep the process alive on its own account.
    session.stopTimer.unref?.();
  }
}
