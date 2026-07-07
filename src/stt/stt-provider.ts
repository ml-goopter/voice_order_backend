import type { SttStream, SttStreamHandlers } from './stt-types.js';

/** Cloud STT provider abstraction (AssemblyAI / Deepgram / …, design §14). */
export interface SttProvider {
  readonly name: string;
  openStream(handlers: SttStreamHandlers): Promise<SttStream>;
}
