/**
 * TTS provider abstraction — the mirror image of STT: text in, audio out.
 *
 * A synthesis produces one **complete** audio buffer per call (a standalone file for mp3), and is
 * cancellable via an `AbortSignal` so a superseded reply (barge-in) can stop an in-flight segment.
 * The caller (`TtsService`) splits a reply into ≈sentence segments and calls `synthesize` once per
 * segment, streaming each finished buffer to the client as its own `tts.audio_chunk`.
 */
export interface TtsProvider {
  readonly name: string;
  /** Audio encoding of the emitted buffer (e.g. 'mp3', 'linear16'); advertised to the client. */
  readonly encoding: string;
  /** Sample rate of the emitted audio when the encoding needs one (e.g. linear16); else undefined. */
  readonly sampleRate?: number | undefined;
  /**
   * Synthesize `text` into one complete audio buffer. Rejects on failure. If `signal` aborts, the
   * synthesis stops early — it may resolve with a partial/empty buffer or reject with the abort
   * error; either way the caller discards the result once the signal is aborted.
   */
  synthesize(text: string, signal: AbortSignal): Promise<Buffer>;
}
