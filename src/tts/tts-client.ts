import { DeepgramClient } from '@deepgram/sdk';
import type { TtsProvider } from './tts-types.js';
import { DeepgramTtsProvider, type SpeakFn } from './deepgram-tts-provider.js';
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
    logger.warn('tts.noop_provider_in_use', { hint: 'set DEEPGRAM_API_KEY to enable spoken replies' });
    return Buffer.alloc(0);
  }
}

export function createTtsProvider(): TtsProvider {
  switch (config.ttsProvider) {
    case 'deepgram':
      if (!config.deepgramApiKey) {
        logger.warn('tts.deepgram_no_key', { hint: 'set DEEPGRAM_API_KEY; using noop provider' });
        return new NoopTtsProvider();
      }
      // Deepgram only needs an explicit sample rate for raw PCM (linear16); mp3 carries its own.
      const sampleRate = config.ttsEncoding === 'linear16' ? config.ttsSampleRate : undefined;
      return new DeepgramTtsProvider(config.ttsEncoding, sampleRate, defaultSpeakFn());
    default:
      return new NoopTtsProvider();
  }
}

/** Real Deepgram REST TTS: one client, streamed response body adapted to an async iterable. */
function defaultSpeakFn(): SpeakFn {
  const client = new DeepgramClient({ apiKey: config.deepgramApiKey });
  return async (text, signal) => {
    const response = await client.speak.v1.audio.generate(
      {
        text,
        model: config.ttsModel,
        encoding: config.ttsEncoding,
        ...(config.ttsEncoding === 'linear16' ? { sample_rate: config.ttsSampleRate } : {}),
      },
      { abortSignal: signal },
    );
    const body = response.stream();
    return body ? readStream(body) : null;
  };
}

/** Adapt a web ReadableStream to an async generator (avoids relying on ReadableStream async-iteration). */
async function* readStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
