import type { RequestId, SessionId } from '../shared/types.js';
import type { ClientConnection } from '../realtime/client-registry.js';
import type { TtsProvider } from './tts-types.js';
import { segmentText } from './segment-text.js';
import { logger } from '../config/logger.js';

/** Correlation ids for one spoken reply's audio stream. */
export interface TtsContext {
  session_id: SessionId;
  request_id: RequestId;
}

/**
 * Turns a spoken reply into a stream of `tts.*` frames on a client socket. Owned by the Realtime
 * Gateway (the only holder of sockets) and driven off `order.reply`.
 *
 * The reply is split into ≈sentence segments; each segment is synthesized into its own **standalone**
 * audio file (a self-contained mp3) and streamed as one `tts.audio_chunk` the moment it is ready, so
 * the client plays segment 1 while segment 2 is still synthesizing (progressive playback). Frame
 * sequence per reply: `tts.audio_start` → `tts.audio_chunk` × N (base64, `seq` 0..N-1, one complete
 * file each) → `tts.audio_end` (or `tts.error`). Audio is base64 inside JSON — the socket carries no
 * binary frames (matches the mic contract).
 *
 * Barge-in (cancel-previous-only): a new reply for the same session aborts any still-running
 * synthesis before starting; the cancelled reply ends silently, so the client just sees a fresh
 * `tts.audio_start` with a new `request_id` and drops the old audio.
 */
export class TtsService {
  private readonly inflight = new Map<SessionId, AbortController>();

  constructor(private readonly provider: TtsProvider) {}

  speak(conn: ClientConnection, ctx: TtsContext, text: string): void {
    const segments = segmentText(text);
    if (segments.length === 0) return;

    const log = logger.child({ session_id: ctx.session_id, request_id: ctx.request_id });

    // Supersede any in-flight reply for this session (barge-in: cancel-previous-only).
    const previous = this.inflight.get(ctx.session_id);
    if (previous) {
      previous.abort();
      log.debug('tts.superseded');
    }

    const controller = new AbortController();
    this.inflight.set(ctx.session_id, controller);

    void this.stream(conn, ctx, segments, controller, log).catch((err) =>
      log.error('tts.stream_error', { error: err instanceof Error ? err.message : String(err) }),
    );
  }

  private async stream(
    conn: ClientConnection,
    ctx: TtsContext,
    segments: string[],
    controller: AbortController,
    log: ReturnType<typeof logger.child>,
  ): Promise<void> {
    const { signal } = controller;
    try {
      conn.send({
        type: 'tts.audio_start',
        session_id: ctx.session_id,
        request_id: ctx.request_id,
        encoding: this.provider.encoding,
        ...(this.provider.sampleRate !== undefined ? { sample_rate: this.provider.sampleRate } : {}),
      });

      let seq = 0;
      for (const segment of segments) {
        if (signal.aborted) return; // superseded / disconnected — stay silent

        let audio: Buffer;
        try {
          audio = await this.provider.synthesize(segment, signal);
        } catch (err) {
          if (signal.aborted) return; // abort surfaced as a rejection — stay silent
          conn.send({
            type: 'tts.error',
            session_id: ctx.session_id,
            request_id: ctx.request_id,
            message: err instanceof Error ? err.message : String(err),
          });
          // Non-fatal: the reply text was already delivered, but the customer won't hear it.
          log.warn('tts.synthesis_failed', { error: err instanceof Error ? err.message : String(err) });
          return;
        }
        if (signal.aborted) return;
        if (audio.length > 0) {
          conn.send({
            type: 'tts.audio_chunk',
            session_id: ctx.session_id,
            request_id: ctx.request_id,
            seq: seq++,
            audio: audio.toString('base64'),
          });
        }
      }

      conn.send({ type: 'tts.audio_end', session_id: ctx.session_id, request_id: ctx.request_id });
      log.debug('tts.spoken', { chunks: seq });
    } finally {
      // Drop the handle only if it's still ours (a barge-in/disconnect may have replaced it).
      if (this.inflight.get(ctx.session_id) === controller) this.inflight.delete(ctx.session_id);
    }
  }

  /** Cancel any in-flight synthesis for a session (e.g. on disconnect); the reply ends silently. */
  cancel(session_id: SessionId): void {
    const controller = this.inflight.get(session_id);
    if (!controller) return;
    controller.abort();
    this.inflight.delete(session_id);
  }
}
