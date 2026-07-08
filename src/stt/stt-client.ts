import type { SttProvider } from './stt-provider.js';
import type { SttStream, SttStreamHandlers } from './stt-types.js';
import { AssemblyAiSttProvider } from './assemblyai-stt-provider.js';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Placeholder provider that accepts audio but emits nothing. Kept as the fallback
 * for unknown providers and for a keyless dev boot.
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
    case 'assemblyai':
      if (!config.assemblyAiApiKey) {
        logger.warn('stt.assemblyai_no_key', { hint: 'set ASSEMBLYAI_API_KEY; using noop provider' });
        return new NoopSttProvider();
      }
      return new AssemblyAiSttProvider();
    // case 'deepgram': return new DeepgramProvider();
    default:
      return new NoopSttProvider();
  }
}
