import { AssemblyAI, type StreamingTranscriber, type TurnEvent } from 'assemblyai';
import type { SttProvider } from './stt-provider.js';
import type { SttStream, SttStreamHandlers } from './stt-types.js';
import { NO_LIMIT, type Lease, type RateLimiter } from '../ratelimit/rate-limiter.js';
import { is429, retryAfterMs } from '../ratelimit/retry-after.js';
import { RATE_LIMIT } from '../config/constants.js';
import { config } from '../config/env.js';

/** Client audio contract: raw PCM16, mono, `config.sttSampleRate` Hz (design §5). */
const ENCODING = 'pcm_s16le' as const;

/**
 * AssemblyAI close codes that mean "we refused this session because you are over quota".
 *
 * The v3 streaming API never closes with WebSocket policy-violation 1008; it uses its own
 * application range. These values mirror the SDK's `StreamingErrorType`, which it does not export
 * (node_modules/assemblyai/dist/index.mjs:1096-1119) — keep them in sync on an SDK bump.
 *
 * Included, all of them a statement about the plan's budget:
 *   4029 RateLimited              — "Rate limited"
 *   4102 TooManyStreams           — "Too many streams"
 *   3009 ConcurrencyLimitExceeded — "Too many concurrent sessions"
 *
 * Deliberately EXCLUDED:
 *   4030 UniqueSessionViolation — the session id is already in use. That is our own bug (or a
 *     stale socket we failed to close), not a quota state: waiting does not fix it and the next
 *     caller, who has a different id, would be throttled for nothing. It falls through to the
 *     ordinary failure path — refund, no penalty.
 */
const OVER_LIMIT_CLOSE_CODES: ReadonlySet<number> = new Set([4029, 4102, 3009]);

/** True when the provider REFUSED the session for rate/quota. Matched on the close code the SDK
 *  puts on its `StreamingError` (or an HTTP 429, for the REST-shaped failures), never on the
 *  message: the "Too many concurrent sessions" text is a display string, not a contract. */
function isOverLimit(error: unknown): boolean {
  if (is429(error)) return true;
  if (error === null || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' && OVER_LIMIT_CLOSE_CODES.has(code);
}

/** Builds a fresh streaming transcriber. Injectable so tests avoid the network. */
export type TranscriberFactory = () => StreamingTranscriber;

/**
 * AssemblyAI universal-streaming STT (design §14). Maps the provider's `turn`
 * events onto our three callbacks:
 *   - non-final turn        → onPartial (live display only)
 *   - end-of-turn (final)   → onFinal   (the one signal that may touch the cart, §11)
 *   - error / early close   → onError   (§11.2 B: never treat a partial as final)
 * Everything provider-specific stays in this file; swapping providers is a new
 * class + one `case` in stt-client.ts.
 *
 * AssemblyAI meters NEW SESSIONS PER MINUTE, not concurrent streams, so the injected
 * {@link RateLimiter}'s per-minute bucket is the quota guard and is taken before the socket opens.
 * Its optional concurrency permit is a COST guard instead — AA bills on socket-open time and
 * auto-closes only after three hours — and is off by default.
 *
 * A leaked permit is permanent, so the reservation has five exits, and every one of them releases
 * unconditionally (`finally`, or the caller's `catch`):
 *   1. `stop()` — normal flush
 *   2. `close()` — disconnect teardown (also how a stream whose caller went away is retired)
 *   3. the `'close'` event — the socket died on its own
 *   4. the `'error'` event — a socket error is not guaranteed to be followed by a `'close'`, so it
 *      cannot be the close handler's job
 *   5. anything thrown while opening — the transcriber factory, a listener registration, or the
 *      handshake, all of which run inside one guarded region in `openStream`
 * Several of these fire together on a normal stop (1 then 3) or a dying socket (4 then 3), which is
 * why release must be idempotent.
 */
export class AssemblyAiSttProvider implements SttProvider {
  readonly name = 'assemblyai';

  constructor(
    private readonly makeTranscriber: TranscriberFactory = defaultTranscriberFactory,
    private readonly limiter: RateLimiter = NO_LIMIT,
    /** Wait budget per session open (`STT_RATE_LIMIT_WAIT_MS`) — once per session, not per turn,
     *  so it can be the most generous of the call sites. */
    private readonly waitMs: number = RATE_LIMIT.defaultWaitMs,
  ) {}

  async openStream(handlers: SttStreamHandlers): Promise<SttStream> {
    // Reserve BEFORE the handshake: the metered event is session creation, not audio.
    const lease = await this.limiter.acquire({ deadlineMs: this.waitMs });
    try {
      // EVERYTHING between the reservation and a live socket runs inside this guard. Building the
      // transcriber and registering its listeners can throw exactly as the handshake can, and a
      // throw there would leak the permit AND spend the session token for a socket that never
      // existed.
      return await this.attach(handlers, lease);
    } catch (error) {
      // Exit 5. A refusal for RATE is not a session that never happened: the provider received the
      // connect and counted it, so it SETTLES (policy §6) — handing the token back would admit the
      // next connect exactly when the bucket should be holding it shut. Any other failure never
      // became a session, so the reservation goes back in full — UNLESS the socket already fired
      // 'close'/'error' and settled the lease, in which case a session did exist and
      // first-write-wins correctly leaves its token spent. Erring towards spent is the safe
      // direction: it under-admits rather than over-admitting against the provider's own count.
      if (isOverLimit(error)) {
        lease.settle();
        // Adaptation (policy §6): the refusal proves the local estimate of the sessions-per-minute
        // budget was wrong, so floor the NEXT grant instead of letting the next caller connect
        // straight back into a provider that just said stop. AssemblyAI sends no `Retry-After` on a
        // streaming refusal, so this is `RATE_LIMIT.penalty429Ms` in practice (a REST-shaped 429
        // would supply one), clamped by `RATE_LIMIT.maxPenaltyMs`. It cannot ratchet: a penalty
        // only ever extends, is always measured from `nowMs()` on a monotonic clock, and no further
        // refusal is even reachable until the current floor has elapsed.
        this.limiter.penalize(this.limiter.nowMs() + retryAfterMs(error), 'stt_over_limit');
      } else {
        // Auth, network, bad config: says nothing about quota, so no penalty.
        lease.abandon();
      }
      throw error;
    }
  }

  /** Build the socket, wire the callbacks, connect. Every failure is the caller's `catch`. */
  private async attach(handlers: SttStreamHandlers, lease: Lease): Promise<SttStream> {
    // The permit lives as long as the socket, so every teardown path must hand it back — a leaked
    // permit is permanent and progressively strangles the restaurant. `settle`/`abandon` are
    // idempotent by contract, which is load-bearing here: a normal stop fires BOTH the explicit
    // teardown below and the socket's own 'close' event.
    const release = (): void => lease.settle();

    const transcriber = this.makeTranscriber();
    let finalDelivered = false;
    let lastFinalTurn = -1;
    // Set once we tear the socket down ourselves (stop/close) so the resulting
    // 'close' is not misread as a mid-speech drop.
    let selfClosing = false;

    transcriber.on('turn', (turn: TurnEvent) => {
      const text = turn.transcript.trim();
      if (!turn.end_of_turn) {
        if (text) handlers.onPartial(text);
        return;
      }
      // formatTurns=true yields two end-of-turn events per turn (unformatted then
      // formatted). Prefer the formatted one; dedupe by turn_order so a turn never
      // fires onFinal twice.
      if (!turn.turn_is_formatted || turn.turn_order === lastFinalTurn || !text) return;
      lastFinalTurn = turn.turn_order;
      finalDelivered = true;
      handlers.onFinal(text);
    });

    transcriber.on('error', (err: Error) => {
      // Exit 4: the socket is done for, and an 'error' is not guaranteed to be followed by a
      // 'close'. Nothing downstream flushes a failed session either (the handler marks it failed
      // and its stop path then short-circuits), so without this the permit would ride the dead
      // socket. Release first, and idempotently: a 'close' commonly follows.
      release();
      // Drop the socket too. AssemblyAI bills on socket-open TIME and auto-closes only after three
      // hours, so an errored socket nobody closes bills silence until the client reconnects or
      // disconnects. Nothing downstream tears this one down. Mark it self-closed first: this is our
      // teardown, so the resulting 'close' must not be re-reported as a mid-speech drop.
      selfClosing = true;
      try {
        // Fire-and-forget on an already-broken socket: neither a sync throw nor a rejection may
        // preempt handlers.onError below, and a rejection must not surface as unhandled.
        void transcriber.close(false).catch(() => undefined);
      } catch {
        // Already gone. The real failure is `err`, which the customer is about to be told about.
      }
      handlers.onError(err);
    });

    // An UNEXPECTED close before any final is a mid-speech drop (§11.2 B): surface as
    // an error so the session fails and the customer is asked to repeat. A close we
    // initiated (stop/close) is expected — the handler's finalTranscript timeout
    // (§11.2 C) is the single authority for the no-final case, so stay silent.
    transcriber.on('close', (code: number, reason: string) => {
      // Exit 3: the socket died on its own. Without this the permit would never come back.
      release();
      if (!finalDelivered && !selfClosing) {
        handlers.onError(new Error(`stt_socket_closed_before_final_transcript: ${code} ${reason}`));
      }
    });

    // Rejects on auth/handshake failure (§11.2 A) so openStream surfaces the error.
    await transcriber.connect();

    return {
      // The SDK wants an ArrayBuffer; hand it the exact bytes this Buffer views.
      sendAudio: (chunk: Buffer) =>
        transcriber.sendAudio(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)),
      // Flush: force the current turn to end, then wait for session termination so a
      // pending final turn is delivered before we resolve. The handler-side
      // finalTranscript timeout (§11.2 C) is the hard backstop if none arrives.
      // `finally` on both teardowns: a throwing forceEndpoint/close must still hand the permit
      // back. Nothing retries a failed teardown, so a skipped release here is permanent.
      stop: async () => {
        selfClosing = true;
        try {
          transcriber.forceEndpoint();
          await transcriber.close(true);
        } finally {
          release(); // exit 1
        }
      },
      // Cleanup on disconnect: drop the socket without waiting for a flush.
      close: () => {
        selfClosing = true;
        try {
          // Fire-and-forget, but a rejected teardown must not surface as an unhandled rejection.
          void transcriber.close(false).catch(() => undefined);
        } finally {
          release(); // exit 2
        }
      },
    };
  }
}

export function defaultTranscriberFactory(): StreamingTranscriber {
  const client = new AssemblyAI({ apiKey: config.assemblyAiApiKey });
  return client.streaming.transcriber({
    sampleRate: config.sttSampleRate,
    encoding: ENCODING,
    formatTurns: true,
    // Endpointing tuned so a customer's natural mid-order pauses don't end the turn early
    // and split one spoken order into several finals (each of which would be its own
    // ordering request). See docs/customer-stop-detection.md.
    minTurnSilence: config.sttMinTurnSilenceMs,
    maxTurnSilence: config.sttMaxTurnSilenceMs,
  });
}
