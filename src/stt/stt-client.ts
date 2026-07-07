import type { SttProvider } from './stt-provider.js';
import type { SttStream, SttStreamHandlers } from './stt-types.js';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Placeholder provider that accepts audio but emits nothing. Keeps the pipeline
 * type-safe until a real streaming client is wired.
 * TODO: implement AssemblyAI / Deepgram clients (design §14) behind SttProvider.
 */
class NoopSttProvider implements SttProvider {
  readonly name = 'noop';

  async openStream(handlers: SttStreamHandlers): Promise<SttStream> {
    logger.warn('stt.noop_provider_in_use', { hint: 'wire a real STT client' });
    return {
      sendAudio: () => undefined,
      stop: async () => {
        // A real provider would flush and deliver onFinal here.
        handlers.onError(new Error('stt_not_implemented'));
      },
      close: () => undefined,
    };
  }
}

export function createSttProvider(): SttProvider {
  switch (config.sttProvider) {
    // case 'assemblyai': return new AssemblyAiProvider();
    // case 'deepgram':   return new DeepgramProvider();
    default:
      return new NoopSttProvider();
  }
}
