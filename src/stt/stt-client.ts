import type { SttProvider } from './stt-provider.js';
import type { SttStream, SttStreamHandlers } from './stt-types.js';
import { AssemblyAiSttProvider, defaultTranscriberFactory } from './assemblyai-stt-provider.js';
import { rateLimiters } from '../ratelimit/registry.js';
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
      // `rpm` is sessions-per-minute (the dimension AA actually meters); `maxConcurrent` is the
      // optional cost guard on socket-open time. Quota is per account, so the key is the api key.
      return new AssemblyAiSttProvider(
        defaultTranscriberFactory,
        rateLimiters.get(
          { name: 'stt', provider: 'assemblyai', apiKey: config.assemblyAiApiKey },
          { rpm: config.sttSessionsPerMin, maxConcurrent: config.sttMaxConcurrentSessions },
        ),
        config.sttRateLimitWaitMs,
      );
    // Add another provider here: a new class + one `case`.
    default:
      return new NoopSttProvider();
  }
}
