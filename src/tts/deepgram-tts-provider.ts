import type { TtsProvider } from './tts-types.js';

/** The provider-specific bit: given text + an abort signal, yield audio frames. Injectable so
 *  tests skip the network. `null` means the provider returned no audio body. */
export type SpeakFn = (text: string, signal: AbortSignal) => Promise<AsyncIterable<Uint8Array> | null>;

/**
 * Deepgram Aura TTS (design §14, mirrors the AssemblyAI STT provider). Synthesizes one text segment
 * into a single complete audio buffer (a standalone mp3): the streamed response body is drained and
 * concatenated. A cancel aborts the request (via the caller's `AbortSignal`); the read then stops
 * and the buffer is discarded upstream. Everything Deepgram-specific stays in the injected
 * `SpeakFn` (built in tts-client.ts); swapping providers is a new class + one `case`.
 */
export class DeepgramTtsProvider implements TtsProvider {
  readonly name = 'deepgram';

  constructor(
    readonly encoding: string,
    readonly sampleRate: number | undefined,
    private readonly speak: SpeakFn,
  ) {}

  async synthesize(text: string, signal: AbortSignal): Promise<Buffer> {
    const stream = await this.speak(text, signal);
    if (!stream) return Buffer.alloc(0);

    const parts: Buffer[] = [];
    for await (const chunk of stream) {
      if (signal.aborted) break;
      if (chunk.length > 0) parts.push(Buffer.from(chunk));
    }
    return Buffer.concat(parts);
  }
}
