import type { LangCode } from '../shared/types.js';
import { RATE_LIMIT, TIMEOUTS } from '../config/constants.js';
import { NO_LIMIT, type RateLimiter } from '../ratelimit/rate-limiter.js';
import type { TtsProvider } from './tts-types.js';

/** The provider-specific bit: given text + a target language + an abort signal, return the audio
 *  bytes. Injectable so tests skip the network. `null` means the provider returned no audio body. */
export type SpeakFn = (text: string, language: string, signal: AbortSignal) => Promise<Uint8Array | null>;

/**
 * Language code (`en_US`, `zh-CN`) → Cartesia ISO-639-1 language (`en`, `zh`): take the primary
 * subtag and lowercase it. Total, because every caller supplies a real code: a reply's language is
 * either agent-declared (shape-checked by `parse-agent-reply`) or `TTS_LANGUAGE`, which `str()`
 * guarantees is non-blank.
 */
export function toCartesiaLanguage(code: LangCode): string {
  return code.split(/[-_]/)[0]!.toLowerCase();
}

/**
 * Cartesia Sonic TTS (design §14, mirrors the AssemblyAI STT provider). Synthesizes one text segment
 * into a single complete audio buffer (a standalone mp3). The reply's language (declared by the agent
 * that wrote it, or `TTS_LANGUAGE` when it declared none — defaulted by `order-understanding-service`,
 * the only `speak` caller) is mapped to Cartesia's `language` param so a multi-locale voice speaks the
 * reply in the same language the LLM produced it in. A cancel aborts the
 * request (via the caller's `AbortSignal`) and the buffer is discarded upstream. Everything
 * Cartesia-specific stays in the injected `SpeakFn` (built in tts-client.ts); swapping providers is a
 * new class + one `case`.
 *
 * Cartesia meters CONCURRENT CONTEXTS and publishes no request-rate limit, so the injected
 * {@link RateLimiter} is configured with a concurrency cap only. One REST call is one context, so a
 * permit is taken per SEGMENT. The caller's `AbortSignal` is threaded into the acquire so a
 * barged-in reply surrenders its place in the queue immediately instead of holding it for work
 * nobody is listening to.
 */
export class CartesiaTtsProvider implements TtsProvider {
  readonly name = 'cartesia';

  constructor(
    readonly encoding: string,
    readonly sampleRate: number | undefined,
    private readonly speak: SpeakFn,
    private readonly limiter: RateLimiter = NO_LIMIT,
    /** Wait budget per segment (`TTS_RATE_LIMIT_WAIT_MS`) — mid-reply, so the tightest of them. */
    private readonly waitMs: number = RATE_LIMIT.defaultWaitMs,
    /** Hard ceiling on one request (`TIMEOUTS.ttsRequestMs`); injectable so tests need not wait. */
    private readonly requestTimeoutMs: number = TIMEOUTS.ttsRequestMs,
  ) {}

  async synthesize(text: string, signal: AbortSignal, language: LangCode): Promise<Buffer> {
    const bytes = await this.limiter.run({ signal, deadlineMs: this.waitMs }, () =>
      this.speakBounded(text, toCartesiaLanguage(language), signal),
    );
    if (!bytes || signal.aborted) return Buffer.alloc(0);
    return Buffer.from(bytes);
  }

  /**
   * One synthesis request, bounded by BOTH the caller's barge-in signal and a request timeout.
   *
   * The permit is held for the whole call, so a request that stalls retires a concurrency slot for
   * as long as it hangs — and barge-in cannot rescue it, because that signal only fires on
   * supersede/disconnect. On the 2-context Free plan, two stalled requests are two dead slots.
   * The timeout is composed with the caller's signal rather than replacing it, so a real barge-in
   * still cancels immediately, and it is armed AFTER the queue wait (which has its own deadline) so
   * queueing never eats the request's budget.
   */
  private async speakBounded(text: string, language: string, signal: AbortSignal): Promise<Uint8Array | null> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    try {
      return await this.speak(text, language, AbortSignal.any([signal, timeout]));
    } catch (err) {
      // Name the cause: an abort error otherwise reads identically whether the customer interrupted
      // or the provider went silent.
      if (timeout.aborted && !signal.aborted) {
        throw new Error(`tts_request_timeout: no response in ${this.requestTimeoutMs}ms`);
      }
      throw err;
    }
  }
}
