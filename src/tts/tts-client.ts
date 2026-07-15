import { Cartesia } from '@cartesia/cartesia-js';
import type { TtsProvider } from './tts-types.js';
import { CartesiaTtsProvider, type SpeakFn } from './cartesia-tts-provider.js';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Placeholder provider that emits no audio (an empty buffer). Kept as the fallback for unknown
 * providers and for a keyless dev boot, so the reply text still flows and the client simply gets
 * an empty audio stream (`audio_start` + `audio_end`, no chunks).
 */
class NoopTtsProvider implements TtsProvider {
  readonly name = 'noop';
  readonly encoding = 'mp3';

  async synthesize(): Promise<Buffer> {
    logger.warn('tts.noop_provider_in_use', { hint: 'set CARTESIA_API_KEY to enable spoken replies' });
    return Buffer.alloc(0);
  }
}

export function createTtsProvider(): TtsProvider {
  switch (config.ttsProvider) {
    case 'cartesia':
      if (!config.cartesiaApiKey) {
        logger.warn('tts.cartesia_no_key', { hint: 'set CARTESIA_API_KEY; using noop provider' });
        return new NoopTtsProvider();
      }
      // mp3 is self-describing; only raw PCM (linear16) advertises a sample rate to the client.
      const sampleRate = config.ttsEncoding === 'linear16' ? config.ttsSampleRate : undefined;
      return new CartesiaTtsProvider(config.ttsEncoding, sampleRate, defaultSpeakFn());
    default:
      return new NoopTtsProvider();
  }
}

/** Real Cartesia REST TTS: one client, one complete audio file per segment (drained to bytes). */
function defaultSpeakFn(): SpeakFn {
  const client = new Cartesia({ apiKey: config.cartesiaApiKey });
  type GenerateBody = Parameters<typeof client.tts.generate>[0];
  // Cartesia's mp3 container requires an explicit sample_rate + bit_rate; raw PCM (linear16) carries a
  // sample_rate and pcm_s16le encoding. Built once — the format is constant across segments.
  const outputFormat =
    config.ttsEncoding === 'linear16'
      ? { container: 'raw', encoding: 'pcm_s16le', sample_rate: config.ttsSampleRate }
      : { container: 'mp3', sample_rate: config.ttsSampleRate, bit_rate: config.ttsBitRate };
  return async (text, language, signal) => {
    const response = await client.tts.generate(
      {
        model_id: config.ttsModel,
        transcript: text,
        voice: { mode: 'id', id: config.ttsVoiceId },
        language,
        output_format: outputFormat as GenerateBody['output_format'],
      },
      { signal },
    );
    const buf = await response.arrayBuffer();
    return buf.byteLength > 0 ? new Uint8Array(buf) : null;
  };
}
