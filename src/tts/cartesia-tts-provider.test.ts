import { describe, it, expect, vi } from 'vitest';
import { CartesiaTtsProvider, toCartesiaLanguage, type SpeakFn } from './cartesia-tts-provider.js';
import { RateLimiter } from '../ratelimit/rate-limiter.js';
import type { Semaphore } from '../ratelimit/semaphore.js';

const provider = (speak: SpeakFn) => new CartesiaTtsProvider('mp3', undefined, speak);

/** The permit is private to the limiter; leak/queueing behaviour is only expressible through it. */
const semOf = (l: RateLimiter): Semaphore => (l as unknown as { concurrency: Semaphore }).concurrency;

describe('toCartesiaLanguage', () => {
  it('maps a res.lang / region-tagged code to its ISO-639-1 primary subtag', () => {
    expect(toCartesiaLanguage('en_US')).toBe('en');
    expect(toCartesiaLanguage('fr_FR')).toBe('fr');
    expect(toCartesiaLanguage('zh_CN')).toBe('zh');
  });

  it('passes a bare ISO-639-1 code (what the agent declares) through', () => {
    expect(toCartesiaLanguage('zh')).toBe('zh');
  });

  it('lowercases and accepts a hyphen separator', () => {
    expect(toCartesiaLanguage('PT-BR')).toBe('pt');
  });
});

describe('CartesiaTtsProvider', () => {
  it('reserves with its own wait budget (a per-call latency budget, not a limiter property)', async () => {
    const run = vi.fn(async (_opts: unknown, fn: () => Promise<unknown>) => fn());
    const limiter = { run } as unknown as RateLimiter;
    const speak: SpeakFn = async () => new Uint8Array([1]);

    await new CartesiaTtsProvider('mp3', undefined, speak, limiter, 800).synthesize(
      'hi',
      new AbortController().signal,
      'en',
    );

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ deadlineMs: 800 }), expect.any(Function));
  });

  it('returns the synthesized bytes as a Buffer', async () => {
    const speak: SpeakFn = async () => new Uint8Array([1, 2, 3]);
    const buf = await provider(speak).synthesize('hi', new AbortController().signal, 'en');
    expect(buf).toEqual(Buffer.from([1, 2, 3]));
  });

  it('normalizes the language and passes it to the speak fn', async () => {
    let seen: string | undefined;
    const speak: SpeakFn = async (_text, language) => {
      seen = language;
      return new Uint8Array([1]);
    };
    await provider(speak).synthesize('hi', new AbortController().signal, 'fr_FR');
    expect(seen).toBe('fr');
  });

  it('returns an empty buffer when the body is null', async () => {
    const speak: SpeakFn = async () => null;
    const buf = await provider(speak).synthesize('hi', new AbortController().signal, 'en');
    expect(buf).toEqual(Buffer.alloc(0));
  });

  it('rejects when the request fails', async () => {
    const speak: SpeakFn = async () => {
      throw new Error('cartesia_down');
    };
    await expect(provider(speak).synthesize('hi', new AbortController().signal, 'en')).rejects.toThrow('cartesia_down');
  });

  it('returns an empty buffer once the signal is aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const speak: SpeakFn = async () => new Uint8Array([1, 2]);
    const buf = await provider(speak).synthesize('hi', ctl.signal, 'en');
    expect(buf.length).toBe(0);
  });

  // The permit is held for the whole request, and barge-in only fires on supersede/disconnect, so
  // without a timeout of its own a stalled request retires a concurrency slot indefinitely.
  describe('request timeout', () => {
    /** Resolves only if its signal aborts — stands in for a Cartesia call that never answers. */
    const hangs: SpeakFn = (_text, _language, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });

    it('aborts a request that never answers, and names the cause', async () => {
      const p = new CartesiaTtsProvider('mp3', undefined, hangs, undefined, undefined, 10);
      await expect(p.synthesize('hi', new AbortController().signal, 'en')).rejects.toThrow('tts_request_timeout');
    });

    it('hands the permit back when a request times out', async () => {
      const limiter = new RateLimiter('tts', { maxConcurrent: 1 });
      const p = new CartesiaTtsProvider('mp3', undefined, hangs, limiter, 800, 10);

      await expect(p.synthesize('hi', new AbortController().signal, 'en')).rejects.toThrow('tts_request_timeout');
      expect(semOf(limiter).inUse).toBe(0);
    });

    it('still lets barge-in cancel, and reports it as an abort rather than a timeout', async () => {
      // The timeout is composed WITH the caller's signal, never in place of it.
      const ctl = new AbortController();
      const p = new CartesiaTtsProvider('mp3', undefined, hangs, undefined, undefined, 10_000);
      const pending = p.synthesize('hi', ctl.signal, 'en');
      const rejected = expect(pending).rejects.toThrow('aborted');
      ctl.abort();
      await rejected;
    });

    it('leaves a request that answers in time alone', async () => {
      const speak: SpeakFn = async () => new Uint8Array([1, 2]);
      const p = new CartesiaTtsProvider('mp3', undefined, speak, undefined, undefined, 10_000);
      await expect(p.synthesize('hi', new AbortController().signal, 'en')).resolves.toEqual(Buffer.from([1, 2]));
    });
  });

  // One REST call is one Cartesia context, so a permit is taken per SEGMENT and must come back
  // however the segment ends — a leak here silences later replies for the rest of the process.
  describe('rate limiting', () => {
    /** A provider holding the ONE permit of `limiter` inside `speak` until the returned `release`
     *  is called, so a second `synthesize` is guaranteed to queue. */
    function saturated(limiter: RateLimiter, spoken: string[]) {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let entered!: () => void;
      const inSpeak = new Promise<void>((r) => (entered = r));
      const speak: SpeakFn = async (text) => {
        spoken.push(text);
        if (spoken.length === 1) {
          entered();
          await held;
        }
        return new Uint8Array([1]);
      };
      const p = new CartesiaTtsProvider('mp3', undefined, speak, limiter, 800);
      return { provider: p, release, inSpeak };
    }

    it('takes one permit per synthesize and hands it back even when speak rejects', async () => {
      const limiter = new RateLimiter('tts', { maxConcurrent: 1 });
      const speak: SpeakFn = async () => {
        // Observed mid-call: the permit is held for the duration of the request, not just taken.
        expect(semOf(limiter).inUse).toBe(1);
        throw new Error('cartesia_down');
      };

      await expect(
        new CartesiaTtsProvider('mp3', undefined, speak, limiter, 800).synthesize(
          'hi',
          new AbortController().signal,
          'en',
        ),
      ).rejects.toThrow('cartesia_down');
      expect(semOf(limiter).inUse).toBe(0);
    });

    it('propagates a limiter rejection out of synthesize', async () => {
      vi.useFakeTimers();
      try {
        const limiter = new RateLimiter('tts', { maxConcurrent: 1 });
        const spoken: string[] = [];
        const { provider: p, release, inSpeak } = saturated(limiter, spoken);

        const first = p.synthesize('first', new AbortController().signal, 'en');
        await inSpeak;

        const second = p.synthesize('second', new AbortController().signal, 'en');
        const rejected = expect(second).rejects.toMatchObject({ code: 'rate_limited', reason: 'deadline' });
        await vi.advanceTimersByTimeAsync(800); // the provider's own wait budget elapses
        await rejected;

        release();
        await first;
        expect(spoken).toEqual(['first']); // the rejected segment never reached Cartesia
      } finally {
        vi.useRealTimers();
      }
    });

    it('surrenders a queued place on abort and never calls speak (barge-in)', async () => {
      const limiter = new RateLimiter('tts', { maxConcurrent: 1 });
      const spoken: string[] = [];
      const { provider: p, release, inSpeak } = saturated(limiter, spoken);

      const first = p.synthesize('first', new AbortController().signal, 'en');
      await inSpeak;

      // The customer talks over the reply while this segment is still queued: it must give up its
      // place immediately rather than hold it for audio nobody will hear.
      const ctl = new AbortController();
      const second = p.synthesize('second', ctl.signal, 'en');
      const rejected = expect(second).rejects.toMatchObject({ code: 'rate_limited', reason: 'aborted' });
      ctl.abort();
      await rejected;
      expect(spoken).toEqual(['first']);

      release();
      await first;
      expect(semOf(limiter).inUse).toBe(0);
    });
  });
});
