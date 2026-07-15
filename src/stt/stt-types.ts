export interface SttStreamHandlers {
  onPartial(text: string): void;
  /** No language: the provider's per-turn detection is unreliable and nothing consumes it — the
   *  agent declares the reply's language instead (docs/text-to-speech.md §Multilingual). */
  onFinal(text: string): void;
  onError(error: Error): void;
}

/** A live streaming STT session for one voice utterance flow. */
export interface SttStream {
  sendAudio(chunk: Buffer): void;
  /** Signal end-of-speech; provider should flush a final transcript (design §11.2 C). */
  stop(): Promise<void>;
  close(): void;
}
