import { describe, it, expect, vi } from 'vitest';
import type { StreamingTranscriber, TurnEvent } from 'assemblyai';
import { AssemblyAiSttProvider, defaultTranscriberFactory } from './assemblyai-stt-provider.js';
import { config } from '../config/env.js';
import { RATE_LIMIT } from '../config/constants.js';
import { logger } from '../config/logger.js';
import { RateLimiter, RateLimitTimeoutError } from '../ratelimit/rate-limiter.js';
import type { Semaphore } from '../ratelimit/semaphore.js';
import type { TokenBucket } from '../ratelimit/token-bucket.js';
import type { SttStreamHandlers } from './stt-types.js';

// Capture the params the real factory hands to AssemblyAI's transcriber, without a network client.
const transcriberParams = vi.fn();
vi.mock('assemblyai', () => ({
  AssemblyAI: class {
    streaming = {
      transcriber: (params: unknown) => {
        transcriberParams(params);
        return {} as StreamingTranscriber;
      },
    };
  },
}));

/** Minimal stand-in for the AssemblyAI StreamingTranscriber (no network). */
class FakeTranscriber {
  private readonly listeners: Record<string, (...args: unknown[]) => void> = {};
  sent: ArrayBufferLike[] = [];
  forced = 0;
  closedWith: boolean[] = [];
  connectCalls = 0;

  on(event: string, cb: (...args: unknown[]) => void): void {
    this.listeners[event] = cb;
  }
  async connect(): Promise<unknown> {
    this.connectCalls++;
    return { type: 'Begin' };
  }
  sendAudio(a: ArrayBufferLike): void {
    this.sent.push(a);
  }
  forceEndpoint(): void {
    this.forced++;
  }
  async close(wait?: boolean): Promise<void> {
    this.closedWith.push(Boolean(wait));
  }
  fire(event: string, ...args: unknown[]): void {
    this.listeners[event]?.(...args);
  }
}

/**
 * Close codes AssemblyAI's v3 streaming API genuinely emits, with the server text the SDK pairs
 * them with (node_modules/assemblyai/dist/index.mjs:1096-1119). Written out here rather than
 * imported from the provider so these tests assert against the VENDOR's contract instead of
 * echoing whatever constant the implementation happens to hold. 1008 appears nowhere in the SDK.
 */
const AA_CLOSE = {
  RateLimited: [4029, 'Rate limited'],
  UniqueSessionViolation: [4030, 'Unique session violation'],
  ConcurrencyLimitExceeded: [3009, 'Too many concurrent sessions'],
  TooManyStreams: [4102, 'Too many streams'],
  AuthFailed: [4001, 'Not Authorized'],
  NormalClosure: [1000, 'Streaming connection closed (code=1000)'],
  AbnormalClosure: [1006, 'Streaming connection closed (code=1006)'],
} as const;

/** The rejection the SDK really builds for a close before `Begin`: a `StreamingError` (a bare
 *  Error subclass) with `.code` and `.retryable` stamped on (index.mjs:1404-1409). */
function streamingCloseError(kind: keyof typeof AA_CLOSE): Error {
  const [code, message] = AA_CLOSE[kind];
  const err = new Error(message);
  err.name = 'StreamingError';
  return Object.assign(err, { code, retryable: code !== 1000 });
}

function turn(partial: Partial<TurnEvent>): TurnEvent {
  return {
    type: 'Turn',
    turn_order: 0,
    turn_is_formatted: false,
    end_of_turn: false,
    transcript: '',
    end_of_turn_confidence: 1,
    words: [],
    ...partial,
  };
}

function collectHandlers() {
  return {
    partials: [] as string[],
    finals: [] as Array<{ text: string }>,
    errors: [] as string[],
    handlers(): SttStreamHandlers {
      return {
        onPartial: (t) => this.partials.push(t),
        onFinal: (t) => this.finals.push({ text: t }),
        onError: (e) => this.errors.push(e.message),
      };
    },
  };
}

async function open() {
  const fake = new FakeTranscriber();
  const provider = new AssemblyAiSttProvider(() => fake as unknown as StreamingTranscriber);
  const sink = collectHandlers();
  const stream = await provider.openStream(sink.handlers());
  return { fake, stream, sink };
}

/** The concurrency permit is private to the limiter; the leak tests are only expressible through
 *  it, so they reach in rather than widening the public surface. */
const semOf = (l: RateLimiter): Semaphore => (l as unknown as { concurrency: Semaphore }).concurrency;
/** Same for the sessions-per-minute bucket: it is what AssemblyAI actually meters. */
const rpmOf = (l: RateLimiter): TokenBucket => (l as unknown as { rpm: TokenBucket }).rpm;
/** One session token on a clock the test never moves, so nothing refills behind an assertion. */
const frozenLimiter = (): RateLimiter => new RateLimiter('stt', { rpm: 1, maxConcurrent: 1 }, () => 0);

/** Open a stream against a REAL limiter, so `inUse` reports the permit the socket is holding. */
async function openWith(limiter: RateLimiter, fake = new FakeTranscriber()) {
  const provider = new AssemblyAiSttProvider(() => fake as unknown as StreamingTranscriber, limiter);
  const sink = collectHandlers();
  const stream = await provider.openStream(sink.handlers());
  return { fake, stream, sink };
}

describe('AssemblyAiSttProvider', () => {
  it('reserves with its own wait budget (a per-call latency budget, not a limiter property)', async () => {
    const acquire = vi.fn().mockResolvedValue({ settle: vi.fn(), abandon: vi.fn(), waitedMs: 0 });
    const provider = new AssemblyAiSttProvider(
      () => new FakeTranscriber() as unknown as StreamingTranscriber,
      { acquire } as unknown as RateLimiter,
      2_000,
    );

    await provider.openStream(collectHandlers().handlers());

    expect(acquire).toHaveBeenCalledWith({ deadlineMs: 2_000 });
  });

  it('connects the stream when opened', async () => {
    const { fake } = await open();
    expect(fake.connectCalls).toBe(1);
  });

  it('maps non-final turns to onPartial (ignoring empty transcripts)', async () => {
    const { fake, sink } = await open();
    fake.fire('turn', turn({ transcript: 'chicken', end_of_turn: false }));
    fake.fire('turn', turn({ transcript: '   ', end_of_turn: false }));
    expect(sink.partials).toEqual(['chicken']);
    expect(sink.finals).toHaveLength(0);
  });

  it('emits onFinal once, on the formatted end-of-turn', async () => {
    const { fake, sink } = await open();
    // Unformatted end-of-turn comes first and must NOT fire a final.
    fake.fire('turn', turn({ transcript: 'two burgers', end_of_turn: true, turn_is_formatted: false, turn_order: 1 }));
    expect(sink.finals).toHaveLength(0);
    // Formatted end-of-turn fires the final. `language_code` is deliberately ignored — the turn's
    // detected language is not reported to anyone (docs/text-to-speech.md §Multilingual).
    fake.fire('turn', turn({ transcript: 'Two burgers.', end_of_turn: true, turn_is_formatted: true, turn_order: 1, language_code: 'en' }));
    // A duplicate formatted event for the same turn must not double-fire.
    fake.fire('turn', turn({ transcript: 'Two burgers.', end_of_turn: true, turn_is_formatted: true, turn_order: 1 }));
    expect(sink.finals).toEqual([{ text: 'Two burgers.' }]);
  });

  it('surfaces provider errors via onError', async () => {
    const { fake, sink } = await open();
    fake.fire('error', new Error('boom'));
    expect(sink.errors).toEqual(['boom']);
  });

  it('treats a close before any final as an error (never a partial-as-final)', async () => {
    const { fake, sink } = await open();
    fake.fire('close', 1006, 'abnormal');
    expect(sink.errors[0]).toContain('stt_socket_closed_before_final_transcript');
    expect(sink.finals).toHaveLength(0);
  });

  it('does not error on a close that follows a final', async () => {
    const { fake, sink } = await open();
    fake.fire('turn', turn({ transcript: 'Done.', end_of_turn: true, turn_is_formatted: true, turn_order: 1 }));
    fake.fire('close', 1000, 'ok');
    expect(sink.errors).toHaveLength(0);
  });

  it('does not error when the socket closes as part of a graceful stop (no final)', async () => {
    const { fake, stream, sink } = await open();
    await stream.stop(); // we initiate the teardown; the handler timeout owns the no-final case
    fake.fire('close', 1000, 'ok');
    expect(sink.errors).toHaveLength(0);
  });

  it('forwards audio bytes to the transcriber', async () => {
    const { fake, stream } = await open();
    stream.sendAudio(Buffer.from([1, 2, 3]));
    expect(fake.sent).toHaveLength(1);
    expect([...new Uint8Array(fake.sent[0]!)]).toEqual([1, 2, 3]);
  });

  it('stop() forces the endpoint and closes with flush; close() closes without flush', async () => {
    const { fake, stream } = await open();
    await stream.stop();
    expect(fake.forced).toBe(1);
    expect(fake.closedWith).toEqual([true]);
    stream.close();
    expect(fake.closedWith).toEqual([true, false]);
  });

  // A session permit lives as long as the socket, and every teardown path must hand it back: a
  // leaked permit is permanent and progressively strangles the restaurant until a redeploy.
  describe('rate limiting', () => {
    it('reserves BEFORE the handshake, so a rejected session never opens a socket', async () => {
      const fake = new FakeTranscriber();
      const rejected = new RateLimitTimeoutError('deadline', 'stt: timed out waiting for capacity');
      const limiter = { acquire: vi.fn().mockRejectedValue(rejected) } as unknown as RateLimiter;
      const provider = new AssemblyAiSttProvider(() => fake as unknown as StreamingTranscriber, limiter);

      await expect(provider.openStream(collectHandlers().handlers())).rejects.toBe(rejected);
      // AssemblyAI meters session CREATION: a socket opened before the reservation would have
      // already spent the quota the limiter just refused.
      expect(fake.connectCalls).toBe(0);
    });

    it('releases the permit when the handshake fails (no leak on an auth error)', async () => {
      const limiter = new RateLimiter('stt', { maxConcurrent: 1 });
      const fake = new FakeTranscriber();
      fake.connect = () => Promise.reject(new Error('auth failed'));
      const provider = new AssemblyAiSttProvider(() => fake as unknown as StreamingTranscriber, limiter);

      await expect(provider.openStream(collectHandlers().handlers())).rejects.toThrow('auth failed');
      expect(semOf(limiter).inUse).toBe(0);
    });

    it('releases exactly once across stop() and the socket close it triggers', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      const limiter = new RateLimiter('stt', { maxConcurrent: 1 });
      const { fake, stream } = await openWith(limiter);
      expect(semOf(limiter).inUse).toBe(1);

      await stream.stop();
      expect(semOf(limiter).inUse).toBe(0);
      // A normal stop fires BOTH the explicit teardown and the socket's own 'close'. The second
      // release must be a no-op: double-releasing inflates the pool above the configured cap.
      fake.fire('close', 1000, 'ok');
      expect(semOf(limiter).inUse).toBe(0);
      expect(warnSpy).not.toHaveBeenCalledWith('ratelimit.double_release', expect.anything());
      warnSpy.mockRestore();
    });

    it('releases the permit on close()', async () => {
      const limiter = new RateLimiter('stt', { maxConcurrent: 1 });
      const { stream } = await openWith(limiter);
      stream.close();
      expect(semOf(limiter).inUse).toBe(0);
    });

    it('releases the permit when the socket dies on its own (no stop/close was ever called)', async () => {
      const limiter = new RateLimiter('stt', { maxConcurrent: 1 });
      const { fake } = await openWith(limiter);
      fake.fire('close', 1006, 'abnormal');
      expect(semOf(limiter).inUse).toBe(0);
    });

    // A teardown is nobody's retry target: whatever it throws, the permit must still come back.
    it('releases the permit when the flush rejects during stop()', async () => {
      const limiter = new RateLimiter('stt', { maxConcurrent: 1 });
      const fake = new FakeTranscriber();
      const { stream } = await openWith(limiter, fake);
      fake.close = () => Promise.reject(new Error('socket already gone'));

      await expect(stream.stop()).rejects.toThrow('socket already gone');
      expect(semOf(limiter).inUse).toBe(0);
    });

    it('releases the permit when forceEndpoint throws during stop()', async () => {
      const limiter = new RateLimiter('stt', { maxConcurrent: 1 });
      const fake = new FakeTranscriber();
      const { stream } = await openWith(limiter, fake);
      fake.forceEndpoint = () => {
        throw new Error('not connected');
      };

      await expect(stream.stop()).rejects.toThrow('not connected');
      expect(semOf(limiter).inUse).toBe(0);
    });

    it('releases the permit when close() throws', async () => {
      const limiter = new RateLimiter('stt', { maxConcurrent: 1 });
      const fake = new FakeTranscriber();
      const { stream } = await openWith(limiter, fake);
      fake.close = () => {
        throw new Error('not connected');
      };

      expect(() => stream.close()).toThrow('not connected');
      expect(semOf(limiter).inUse).toBe(0);
    });

    it('refunds everything when the transcriber factory throws (no socket ever existed)', async () => {
      const limiter = frozenLimiter();
      const provider = new AssemblyAiSttProvider(() => {
        throw new Error('factory_boom');
      }, limiter);

      await expect(provider.openStream(collectHandlers().handlers())).rejects.toThrow('factory_boom');
      expect(semOf(limiter).inUse).toBe(0);
      // AssemblyAI meters session CREATION, and none happened — spending the token here would
      // charge the plan for a socket that was never opened.
      expect(rpmOf(limiter).available).toBe(1);
    });

    it('refunds everything when registering a listener throws', async () => {
      const limiter = frozenLimiter();
      const fake = new FakeTranscriber();
      fake.on = () => {
        throw new Error('listener_boom');
      };
      const provider = new AssemblyAiSttProvider(() => fake as unknown as StreamingTranscriber, limiter);

      await expect(provider.openStream(collectHandlers().handlers())).rejects.toThrow('listener_boom');
      expect(semOf(limiter).inUse).toBe(0);
      expect(rpmOf(limiter).available).toBe(1);
      expect(fake.connectCalls).toBe(0);
    });

    it('keeps the session token spent when the socket died before the handshake rejected', async () => {
      // Ordering matters: the 'close' handler settles first, and a lease is first-write-wins, so
      // the later abandon is a no-op. That is the right answer — a socket that fired 'close' did
      // exist, so AssemblyAI counted the session — and the permit comes back either way.
      const limiter = frozenLimiter();
      const fake = new FakeTranscriber();
      fake.connect = async () => {
        fake.fire('close', 1006, 'gone');
        throw new Error('handshake failed');
      };
      const provider = new AssemblyAiSttProvider(() => fake as unknown as StreamingTranscriber, limiter);

      await expect(provider.openStream(collectHandlers().handlers())).rejects.toThrow('handshake failed');
      expect(semOf(limiter).inUse).toBe(0);
      expect(rpmOf(limiter).available).toBe(0);
    });

    // AssemblyAI refuses an over-limit streaming session by CLOSING the socket, not with an HTTP
    // 429, and it does not invoke the 'close' listener for a pre-Begin close — the SDK rejects
    // connect() with a StreamingError carrying `.code`. So this catch is the only place that sees
    // the refusal, and it has to recognise the codes the vendor actually sends.
    it.each(['RateLimited', 'ConcurrencyLimitExceeded', 'TooManyStreams'] as const)(
      'keeps the session token spent when the provider refuses the session for quota (%s)',
      async (kind) => {
        const limiter = frozenLimiter();
        const fake = new FakeTranscriber();
        fake.connect = () => Promise.reject(streamingCloseError(kind));
        const provider = new AssemblyAiSttProvider(() => fake as unknown as StreamingTranscriber, limiter);

        await expect(provider.openStream(collectHandlers().handlers())).rejects.toThrow(AA_CLOSE[kind][1]);
        // The provider COUNTED this session: refunding the token would admit the next connect at
        // exactly the moment the bucket should be holding it shut (policy §6).
        expect(rpmOf(limiter).available).toBe(0);
        // The permit is a cost guard on a live socket, and no socket survived — it comes back.
        expect(semOf(limiter).inUse).toBe(0);
      },
    );

    // The mirror image, and the reason the predicate is a code SET and not "anything in the 4xxx
    // application range": these refuse the connect just as hard, but none of them is the quota
    // talking, so the token goes back and no penalty is armed.
    //   1000/1006 — ordinary/abnormal socket close
    //   4030      — duplicate session id: our bug, and waiting does not fix it
    it.each(['NormalClosure', 'AbnormalClosure', 'UniqueSessionViolation'] as const)(
      'refunds the session token when the close is not about quota (%s)',
      async (kind) => {
        const limiter = frozenLimiter();
        const fake = new FakeTranscriber();
        fake.connect = () => Promise.reject(streamingCloseError(kind));
        const penalize = vi.spyOn(limiter, 'penalize');
        const provider = new AssemblyAiSttProvider(() => fake as unknown as StreamingTranscriber, limiter);

        await expect(provider.openStream(collectHandlers().handlers())).rejects.toThrow(AA_CLOSE[kind][1]);
        expect(rpmOf(limiter).available).toBe(1);
        expect(semOf(limiter).inUse).toBe(0);
        expect(penalize).not.toHaveBeenCalled();
        penalize.mockRestore();
      },
    );

    // Adaptation (policy §6): the refusal is proof our local estimate of the sessions-per-minute
    // budget was wrong, so it must floor the next grant. Asserted through the bucket's actual
    // behaviour — a spy on `penalize` would pass just as happily against a penalty of zero.
    it('floors the next session grant after the provider refuses the session for rate', async () => {
      vi.useFakeTimers();
      try {
        // rpm 2 so a token is still on hand after the refusal: the ONLY thing that can hold the
        // second open back is the penalty.
        const limiter = new RateLimiter('stt', { rpm: 2 });
        const refusing = new FakeTranscriber();
        refusing.connect = () => Promise.reject(streamingCloseError('RateLimited'));
        const healthy = new FakeTranscriber();
        let opens = 0;
        const provider = new AssemblyAiSttProvider(
          () => (opens++ === 0 ? refusing : healthy) as unknown as StreamingTranscriber,
          limiter,
          120_000, // generous, so the deadline is not what decides the outcome
        );

        await expect(provider.openStream(collectHandlers().handlers())).rejects.toThrow('Rate limited');
        expect(rpmOf(limiter).available).toBeGreaterThanOrEqual(1);

        let opened = false;
        const pending = provider.openStream(collectHandlers().handlers()).then(() => (opened = true));

        // AssemblyAI documents no `Retry-After` for a streaming refusal, so the floor is the
        // configured fallback.
        await vi.advanceTimersByTimeAsync(RATE_LIMIT.penalty429Ms - 1);
        expect(opened).toBe(false);
        expect(healthy.connectCalls).toBe(0); // no socket opened into a provider that just said stop
        await vi.advanceTimersByTimeAsync(1);
        await pending;
        expect(opened).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not penalize the bucket for a failure that is not about quota (auth)', async () => {
      vi.useFakeTimers();
      try {
        const limiter = new RateLimiter('stt', { rpm: 2 });
        const failing = new FakeTranscriber();
        failing.connect = () => Promise.reject(Object.assign(new Error('Not authorized'), { code: 4001 }));
        const healthy = new FakeTranscriber();
        let opens = 0;
        const provider = new AssemblyAiSttProvider(
          () => (opens++ === 0 ? failing : healthy) as unknown as StreamingTranscriber,
          limiter,
          120_000,
        );

        await expect(provider.openStream(collectHandlers().handlers())).rejects.toThrow('Not authorized');
        // An auth/network/config failure says nothing about the quota — the next session opens now.
        await provider.openStream(collectHandlers().handlers());
        expect(healthy.connectCalls).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('still refunds the session token for a refusal that is not about rate (auth)', async () => {
      const limiter = frozenLimiter();
      const fake = new FakeTranscriber();
      fake.connect = () => Promise.reject(Object.assign(new Error('Not authorized'), { code: 4001 }));
      const provider = new AssemblyAiSttProvider(() => fake as unknown as StreamingTranscriber, limiter);

      await expect(provider.openStream(collectHandlers().handlers())).rejects.toThrow('Not authorized');
      expect(rpmOf(limiter).available).toBe(1);
      expect(semOf(limiter).inUse).toBe(0);
    });

    it('releases the permit when the socket errors (an error need not be followed by a close)', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      const limiter = new RateLimiter('stt', { maxConcurrent: 1 });
      const { fake, sink } = await openWith(limiter);
      expect(semOf(limiter).inUse).toBe(1);

      // Nothing downstream flushes a failed session (the handler marks it failed and its stop path
      // then short-circuits), so if 'error' does not release, the permit rides the dead socket.
      fake.fire('error', new Error('socket blew up'));
      expect(semOf(limiter).inUse).toBe(0);
      expect(sink.errors).toEqual(['socket blew up']);

      // An 'error' is commonly followed by a 'close'; the second release must be a no-op.
      fake.fire('close', 1006, 'abnormal');
      expect(semOf(limiter).inUse).toBe(0);
      expect(warnSpy).not.toHaveBeenCalledWith('ratelimit.double_release', expect.anything());
      warnSpy.mockRestore();
    });

    // AssemblyAI bills on socket-open TIME and auto-closes only after three hours, so an errored
    // socket nobody closes bills silence. Releasing the permit fixes the leak, not the bill.
    it('closes the socket when it errors, so a dead session stops billing', async () => {
      const limiter = new RateLimiter('stt', { maxConcurrent: 1 });
      const { fake, sink } = await openWith(limiter);

      fake.fire('error', new Error('socket blew up'));

      expect(fake.closedWith).toEqual([false]); // dropped, not flushed: there is nothing to flush
      expect(sink.errors).toEqual(['socket blew up']);
      expect(semOf(limiter).inUse).toBe(0);

      // A 'close' may or may not follow our own close. If it does, it is OUR teardown, not a
      // mid-speech drop, and it must not release a second time.
      fake.fire('close', 1006, 'abnormal');
      expect(sink.errors).toEqual(['socket blew up']);
      expect(fake.closedWith).toEqual([false]);
      expect(semOf(limiter).inUse).toBe(0);
    });

    it('surfaces the error even when closing the errored socket throws', async () => {
      const limiter = new RateLimiter('stt', { maxConcurrent: 1 });
      const fake = new FakeTranscriber();
      const { sink } = await openWith(limiter, fake);
      fake.close = () => {
        throw new Error('not connected');
      };

      // A teardown throw must not escape the listener (the SDK would treat it as our bug) nor
      // preempt the customer-visible failure.
      expect(() => fake.fire('error', new Error('socket blew up'))).not.toThrow();
      expect(sink.errors).toEqual(['socket blew up']);
      expect(semOf(limiter).inUse).toBe(0);
    });

    it('does not raise an unhandled rejection when closing the errored socket rejects', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        const limiter = new RateLimiter('stt', { maxConcurrent: 1 });
        const fake = new FakeTranscriber();
        const { sink } = await openWith(limiter, fake);
        fake.close = () => Promise.reject(new Error('socket already gone'));

        fake.fire('error', new Error('socket blew up'));
        await new Promise((resolve) => setImmediate(resolve));

        expect(unhandled).toEqual([]);
        expect(sink.errors).toEqual(['socket blew up']);
        expect(semOf(limiter).inUse).toBe(0);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('parks the next session until the sessions-per-minute bucket refills', async () => {
      vi.useFakeTimers();
      try {
        // rpm 1 → capacity 1, refilling one token per 60s. A generous wait budget so the deadline
        // is not what decides the outcome.
        const limiter = new RateLimiter('stt', { rpm: 1 });
        const provider = new AssemblyAiSttProvider(
          () => new FakeTranscriber() as unknown as StreamingTranscriber,
          limiter,
          120_000,
        );
        await provider.openStream(collectHandlers().handlers()); // spends the only token

        let opened = false;
        const pending = provider.openStream(collectHandlers().handlers()).then(() => (opened = true));

        await vi.advanceTimersByTimeAsync(59_000);
        expect(opened).toBe(false); // still short of a whole token
        await vi.advanceTimersByTimeAsync(1_000);
        await pending;
        expect(opened).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('forwards the configured end-of-turn silence tuning to the transcriber', () => {
    defaultTranscriberFactory();
    expect(transcriberParams).toHaveBeenCalledWith(
      expect.objectContaining({
        minTurnSilence: config.sttMinTurnSilenceMs,
        maxTurnSilence: config.sttMaxTurnSilenceMs,
        formatTurns: true,
      }),
    );
  });
});
