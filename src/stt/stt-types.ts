import type { LangCode } from '../shared/types.js';

export interface SttStreamHandlers {
  onPartial(text: string): void;
  onFinal(text: string, language?: LangCode): void;
  onError(error: Error): void;
}

/** A live streaming STT session for one voice utterance flow. */
export interface SttStream {
  sendAudio(chunk: Buffer): void;
  /** Signal end-of-speech; provider should flush a final transcript (design §11.2 C). */
  stop(): Promise<void>;
  close(): void;
}
