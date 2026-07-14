import { describe, it, expect } from 'vitest';
import { DeepgramTtsProvider, type SpeakFn } from './deepgram-tts-provider.js';

async function* fromChunks(chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const c of chunks) yield c;
}

const provider = (speak: SpeakFn) => new DeepgramTtsProvider('mp3', undefined, speak);

describe('DeepgramTtsProvider', () => {
  it('concatenates the streamed frames into one complete buffer', async () => {
    const speak: SpeakFn = async () => fromChunks([new Uint8Array([1, 2]), new Uint8Array([3])]);
    const buf = await provider(speak).synthesize('hi', new AbortController().signal);
    expect(buf).toEqual(Buffer.from([1, 2, 3]));
  });

  it('skips empty frames', async () => {
    const speak: SpeakFn = async () => fromChunks([new Uint8Array([]), new Uint8Array([9])]);
    const buf = await provider(speak).synthesize('hi', new AbortController().signal);
    expect(buf).toEqual(Buffer.from([9]));
  });

  it('returns an empty buffer when the body is null', async () => {
    const speak: SpeakFn = async () => null;
    const buf = await provider(speak).synthesize('hi', new AbortController().signal);
    expect(buf).toEqual(Buffer.alloc(0));
  });

  it('rejects when the request fails', async () => {
    const speak: SpeakFn = async () => {
      throw new Error('deepgram_down');
    };
    await expect(provider(speak).synthesize('hi', new AbortController().signal)).rejects.toThrow('deepgram_down');
  });

  it('stops reading once the signal is aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const speak: SpeakFn = async () => fromChunks([new Uint8Array([1]), new Uint8Array([2])]);
    const buf = await provider(speak).synthesize('hi', ctl.signal);
    expect(buf.length).toBe(0);
  });
});
