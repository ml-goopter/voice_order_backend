import type { LangCode } from '../shared/types.js';
import type { TtsProvider } from './tts-types.js';

/** The provider-specific bit: given text + a target language + an abort signal, return the audio
 *  bytes. Injectable so tests skip the network. `null` means the provider returned no audio body. */
export type SpeakFn = (text: string, language: string, signal: AbortSignal) => Promise<Uint8Array | null>;

/**
 * Language code (`en_US`, `zh-CN`) → Cartesia ISO-639-1 language (`en`, `zh`): take the primary
 * subtag and lowercase it. Total, because every caller supplies a real code: a reply's language is
 * either agent-declared (shape-checked by `parse-spoken-reply`) or `TTS_LANGUAGE`, which `str()`
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
 */
export class CartesiaTtsProvider implements TtsProvider {
  readonly name = 'cartesia';

  constructor(
    readonly encoding: string,
    readonly sampleRate: number | undefined,
    private readonly speak: SpeakFn,
  ) {}

  async synthesize(text: string, signal: AbortSignal, language: LangCode): Promise<Buffer> {
    const bytes = await this.speak(text, toCartesiaLanguage(language), signal);
    if (!bytes || signal.aborted) return Buffer.alloc(0);
    return Buffer.from(bytes);
  }
}
