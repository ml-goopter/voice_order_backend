import { describe, it, expect, vi } from 'vitest';
import { TtsService } from './tts-service.js';
import type { TtsProvider } from './tts-types.js';
import type { ClientConnection } from '../realtime/client-registry.js';

type FakeConn = ClientConnection & { send: ReturnType<typeof vi.fn> };

function conn(session_id = 's1'): FakeConn {
  return {
    session_id,
    cart_id: 'cart_1',
    pos_config_id: 1,
    send: vi.fn(),
    close: vi.fn(),
    isAlive: () => true,
  } as FakeConn;
}

interface Call {
  text: string;
  signal: AbortSignal;
  language: string | undefined;
  resolve: (b: Buffer) => void;
  reject: (e: unknown) => void;
}

/** A provider whose `synthesize` hands back a deferred so the test drives each segment by hand. */
function controllableProvider(overrides: Partial<Pick<TtsProvider, 'encoding' | 'sampleRate'>> = {}) {
  const calls: Call[] = [];
  const provider: TtsProvider = {
    name: 'fake',
    encoding: overrides.encoding ?? 'mp3',
    ...(overrides.sampleRate !== undefined ? { sampleRate: overrides.sampleRate } : {}),
    synthesize(text: string, signal: AbortSignal, language?: string): Promise<Buffer> {
      return new Promise<Buffer>((resolve, reject) => calls.push({ text, signal, language, resolve, reject }));
    },
  };
  return { provider, calls };
}

/** Let the async stream loop advance one await. */
const flush = () => new Promise((r) => setImmediate(r));

const ctx = { session_id: 's1', request_id: 'r1' };

describe('TtsService', () => {
  it('emits audio_start → one standalone-mp3 audio_chunk per segment → audio_end', async () => {
    const { provider, calls } = controllableProvider();
    const c = conn();
    new TtsService(provider).speak(c, ctx, 'One. Two.', 'en');

    // audio_start goes out up front; the first segment is already being synthesized.
    expect(c.send).toHaveBeenNthCalledWith(1, {
      type: 'tts.audio_start',
      session_id: 's1',
      request_id: 'r1',
      encoding: 'mp3',
    });
    expect(calls.map((x) => x.text)).toEqual(['One.']);

    calls[0]!.resolve(Buffer.from([0xde, 0xad]));
    await flush();

    // First segment shipped as its own chunk; the second segment starts only now (sequential).
    expect(c.send).toHaveBeenNthCalledWith(2, {
      type: 'tts.audio_chunk',
      session_id: 's1',
      request_id: 'r1',
      seq: 0,
      audio: Buffer.from([0xde, 0xad]).toString('base64'),
    });
    expect(calls.map((x) => x.text)).toEqual(['One.', 'Two.']);

    calls[1]!.resolve(Buffer.from([0xbe, 0xef]));
    await flush();

    expect(c.send).toHaveBeenNthCalledWith(3, {
      type: 'tts.audio_chunk',
      session_id: 's1',
      request_id: 'r1',
      seq: 1,
      audio: Buffer.from([0xbe, 0xef]).toString('base64'),
    });
    expect(c.send).toHaveBeenNthCalledWith(4, { type: 'tts.audio_end', session_id: 's1', request_id: 'r1' });
  });

  it('advertises sample_rate on audio_start for raw-PCM encodings', () => {
    const { provider } = controllableProvider({ encoding: 'linear16', sampleRate: 24000 });
    const c = conn();
    new TtsService(provider).speak(c, ctx, 'hi', 'en');
    expect(c.send).toHaveBeenNthCalledWith(1, {
      type: 'tts.audio_start',
      session_id: 's1',
      request_id: 'r1',
      encoding: 'linear16',
      sample_rate: 24000,
    });
  });

  it('emits tts.error and stops when a segment fails to synthesize', async () => {
    const { provider, calls } = controllableProvider();
    const c = conn();
    new TtsService(provider).speak(c, ctx, 'hi', 'en');
    await flush();
    calls[0]!.reject(new Error('cartesia_down'));
    await flush();
    expect(c.send).toHaveBeenLastCalledWith({
      type: 'tts.error',
      session_id: 's1',
      request_id: 'r1',
      message: 'cartesia_down',
    });
    // No audio_end after an error.
    expect(c.send.mock.calls.some(([m]) => m.type === 'tts.audio_end')).toBe(false);
  });

  it('skips a chunk for an empty audio buffer (e.g. noop provider) but still ends', async () => {
    const { provider, calls } = controllableProvider();
    const c = conn();
    new TtsService(provider).speak(c, ctx, 'hi', 'en');
    await flush();
    calls[0]!.resolve(Buffer.alloc(0));
    await flush();
    expect(c.send).toHaveBeenCalledTimes(2);
    expect(c.send).toHaveBeenNthCalledWith(2, { type: 'tts.audio_end', session_id: 's1', request_id: 'r1' });
  });

  it('forwards the reply language to the provider (per-segment)', async () => {
    const { provider, calls } = controllableProvider();
    const c = conn();
    new TtsService(provider).speak(c, ctx, 'Un. Deux.', 'fr_FR');
    expect(calls[0]!.language).toBe('fr_FR');
    calls[0]!.resolve(Buffer.from([1]));
    await flush();
    expect(calls[1]!.language).toBe('fr_FR');
  });

  it('ignores an empty / whitespace reply', () => {
    const { provider, calls } = controllableProvider();
    const c = conn();
    new TtsService(provider).speak(c, ctx, '   ', 'en');
    expect(c.send).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('aborts the previous in-flight reply for the same session (barge-in)', async () => {
    const { provider, calls } = controllableProvider();
    const c = conn();
    const svc = new TtsService(provider);

    svc.speak(c, { session_id: 's1', request_id: 'r1' }, 'first', 'en');
    await flush();
    svc.speak(c, { session_id: 's1', request_id: 'r2' }, 'second', 'en');

    expect(calls[0]!.signal.aborted).toBe(true);
    // The second reply started its own stream (fresh audio_start with the new request_id).
    expect(c.send).toHaveBeenCalledWith({
      type: 'tts.audio_start',
      session_id: 's1',
      request_id: 'r2',
      encoding: 'mp3',
    });
  });

  it('does not abort across different sessions', async () => {
    const { provider, calls } = controllableProvider();
    const svc = new TtsService(provider);
    svc.speak(conn('s1'), { session_id: 's1', request_id: 'r1' }, 'a', 'en');
    await flush();
    svc.speak(conn('s2'), { session_id: 's2', request_id: 'r2' }, 'b', 'en');
    expect(calls[0]!.signal.aborted).toBe(false);
  });

  it('cancel(session) aborts the in-flight synthesis (e.g. on disconnect)', async () => {
    const { provider, calls } = controllableProvider();
    const c = conn();
    const svc = new TtsService(provider);
    svc.speak(c, { session_id: 's1', request_id: 'r1' }, 'reply', 'en');
    await flush();
    svc.cancel('s1');
    expect(calls[0]!.signal.aborted).toBe(true);
  });

  it('cancel(session) is a no-op when nothing is in flight', () => {
    const { provider, calls } = controllableProvider();
    const svc = new TtsService(provider);
    expect(() => svc.cancel('s1')).not.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('clears the in-flight handle after a reply completes', async () => {
    const { provider, calls } = controllableProvider();
    const c = conn();
    const svc = new TtsService(provider);
    svc.speak(c, { session_id: 's1', request_id: 'r1' }, 'hi', 'en');
    await flush();
    calls[0]!.resolve(Buffer.from([1]));
    await flush();
    // Reply finished and the handle was dropped, so a later cancel finds nothing to abort.
    svc.cancel('s1');
    expect(calls[0]!.signal.aborted).toBe(false);
  });
});
