import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NO_LIMIT, RateLimiter, type RateLimits } from './rate-limiter.js';
import { RATE_LIMIT } from '../config/constants.js';
import type { Semaphore } from './semaphore.js';
import type { TokenBucket } from './token-bucket.js';
import { logger } from '../config/logger.js';

beforeEach(() => {
  vi.useFakeTimers();
  // These cases exercise rejection paths on purpose; keep their log lines out of the report.
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// The buckets/semaphore are private by design — the reservation arithmetic is only observable
// through them, so the tests reach in rather than widening the public surface.
const bucketOf = (l: RateLimiter, dim: 'rpm' | 'tpm'): TokenBucket =>
  (l as unknown as Record<string, TokenBucket>)[dim] as TokenBucket;
const semOf = (l: RateLimiter): Semaphore => (l as unknown as { concurrency: Semaphore }).concurrency;
const penaltyOf = (b: TokenBucket): number => (b as unknown as { penaltyUntil: number }).penaltyUntil;

/** A limiter on a clock the test moves by hand, so nothing refills behind the assertions. */
function frozen(limits: RateLimits): RateLimiter {
  return new RateLimiter('test', limits, () => 0);
}

describe('RateLimiter', () => {
  it('bounds the whole acquire by ONE absolute deadline, not one per stage', async () => {
    const limiter = new RateLimiter('test', { rpm: 60, tpm: 60, maxConcurrent: 1 });
    // Drain both buckets to zero and keep the single permit, all at t=0.
    for (let i = 0; i < 59; i++) (await limiter.acquire({ cost: 1 })).settle();
    await limiter.acquire({ cost: 1 });

    // RPM grants after 1_000ms; TPM would then need 1_000ms more, past the shared deadline.
    const p = limiter.acquire({ cost: 2, deadlineMs: 1_500 });
    const rejected = expect(p).rejects.toMatchObject({ code: 'rate_limited', reason: 'deadline' });

    let settled = false;
    void p.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(1_499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
  });

  it('gives each acquire ITS OWN deadline on a shared limiter', async () => {
    // The wait budget is a call-site latency budget, not a quota property: two adapters sharing
    // one limiter (parser vs. intent classifier on the same creds) must each keep their own.
    const limiter = new RateLimiter('test', { rpm: 1 });
    await limiter.acquire({ deadlineMs: 500 }); // takes the only token

    const short = limiter.acquire({ deadlineMs: 500 });
    const long = limiter.acquire({ deadlineMs: 2_000 });
    const shortRejected = expect(short).rejects.toMatchObject({ reason: 'deadline' });
    const longRejected = expect(long).rejects.toMatchObject({ reason: 'deadline' });

    let longSettled = false;
    void long.catch(() => {
      longSettled = true;
    });
    await vi.advanceTimersByTimeAsync(500);
    await shortRejected;
    expect(longSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    await longRejected;
  });

  it('falls back to the constant wait budget when an acquire names no deadline', async () => {
    const limiter = new RateLimiter('test', { rpm: 1 });
    await limiter.acquire();

    const p = limiter.acquire();
    const rejected = expect(p).rejects.toMatchObject({ reason: 'deadline' });
    let settled = false;
    void p.catch(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(RATE_LIMIT.defaultWaitMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
  });

  it('refunds the RPM token when the TPM stage fails', async () => {
    const limiter = frozen({ rpm: 60, tpm: 60 });
    const rpm = bucketOf(limiter, 'rpm');
    await limiter.acquire({ cost: 60 });
    expect(rpm.available).toBe(59);

    const p = limiter.acquire({ cost: 60, deadlineMs: 500 });
    const rejected = expect(p).rejects.toMatchObject({ reason: 'deadline' });
    await vi.advanceTimersByTimeAsync(500);
    await rejected;

    expect(rpm.available).toBe(59);
  });

  it('refunds both buckets when the concurrency stage fails', async () => {
    const limiter = frozen({ rpm: 60, tpm: 600, maxConcurrent: 1 });
    const [rpm, tpm] = [bucketOf(limiter, 'rpm'), bucketOf(limiter, 'tpm')];
    await limiter.acquire({ cost: 100 }); // holds the only permit
    expect([rpm.available, tpm.available]).toEqual([59, 500]);

    const p = limiter.acquire({ cost: 100, deadlineMs: 500 });
    const rejected = expect(p).rejects.toMatchObject({ reason: 'deadline' });
    await vi.advanceTimersByTimeAsync(500);
    await rejected;

    expect([rpm.available, tpm.available]).toEqual([59, 500]);
  });

  describe('settle', () => {
    it('does NOT refund when the actual cost came in under the estimate', async () => {
      const limiter = frozen({ tpm: 600 });
      const tpm = bucketOf(limiter, 'tpm');
      const lease = await limiter.acquire({ cost: 100 });
      expect(tpm.available).toBe(500);

      lease.settle(40);

      // The provider charges on the reservation basis and issues no refund; refunding locally
      // would make this limiter more permissive than the quota it protects (policy §5.3).
      expect(tpm.available).toBe(500);
    });

    it('charges the delta when the actual cost overran, even into a negative bucket', async () => {
      const limiter = frozen({ tpm: 100 });
      const tpm = bucketOf(limiter, 'tpm');
      const lease = await limiter.acquire({ cost: 100 });
      expect(tpm.available).toBe(0);

      lease.settle(160);
      expect(tpm.available).toBe(-60);
    });

    it('reconciles against the CLAMPED reservation when the ask exceeded capacity', async () => {
      const limiter = frozen({ tpm: 100 });
      const tpm = bucketOf(limiter, 'tpm');
      // An over-capacity ask can never be paid, so the bucket clamps and only 100 is reserved.
      const lease = await limiter.acquire({ cost: 300 });
      expect(tpm.available).toBe(0);

      lease.settle(250);

      // 250 actually burned against a 100-token reservation: charge the 150 difference. Measuring
      // the delta from the unclamped 300 would have charged nothing at all.
      expect(tpm.available).toBe(-150);
    });

    it('leaves the reservation standing when the provider reported no usage', async () => {
      const limiter = frozen({ tpm: 600 });
      const tpm = bucketOf(limiter, 'tpm');
      const lease = await limiter.acquire({ cost: 100 });

      lease.settle();
      expect(tpm.available).toBe(500);
    });

    it('releases the concurrency permit', async () => {
      const limiter = frozen({ tpm: 600, maxConcurrent: 1 });
      const lease = await limiter.acquire({ cost: 100 });
      expect(semOf(limiter).inUse).toBe(1);
      lease.settle(100);
      expect(semOf(limiter).inUse).toBe(0);
    });

    it('is idempotent, and a later abandon cannot undo it', async () => {
      const limiter = frozen({ tpm: 100, maxConcurrent: 1 });
      const tpm = bucketOf(limiter, 'tpm');
      const lease = await limiter.acquire({ cost: 100 });

      lease.settle(160);
      lease.settle(160);
      lease.abandon();

      expect(tpm.available).toBe(-60);
      expect(semOf(limiter).inUse).toBe(0);
    });
  });

  it('abandon refunds the whole reservation and releases the permit', async () => {
    const limiter = frozen({ rpm: 60, tpm: 600, maxConcurrent: 1 });
    const [rpm, tpm] = [bucketOf(limiter, 'rpm'), bucketOf(limiter, 'tpm')];
    const lease = await limiter.acquire({ cost: 100 });
    expect(semOf(limiter).inUse).toBe(1);

    lease.abandon();

    expect([rpm.available, tpm.available]).toEqual([60, 600]);
    expect(semOf(limiter).inUse).toBe(0);
  });

  it('penalize floors the next grant on both buckets', async () => {
    const limiter = new RateLimiter('test', { rpm: 60, tpm: 600 });
    limiter.penalize(5_000, 'llm_429');
    expect(penaltyOf(bucketOf(limiter, 'rpm'))).toBe(5_000);
    expect(penaltyOf(bucketOf(limiter, 'tpm'))).toBe(5_000);

    let granted = false;
    const p = limiter.acquire({ cost: 10, deadlineMs: 60_000 }).then(() => {
      granted = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(granted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(granted).toBe(true);
  });

  // `STT_MAX_CONCURRENT_SESSIONS=4` with `STT_SESSIONS_PER_MIN=0` is a plausible deployment —
  // .env.example presents the concurrency cap as the COST guard and the rate cap as optional. It
  // builds a real limiter with no rate buckets, so a penalty has nowhere to land.
  describe('a concurrency-only limiter', () => {
    it('shapes concurrency and builds no rate buckets', async () => {
      const limiter = frozen({ maxConcurrent: 1 });
      expect(bucketOf(limiter, 'rpm')).toBeNull();
      expect(bucketOf(limiter, 'tpm')).toBeNull();

      const held = await limiter.acquire({ cost: 5_000 });
      expect(semOf(limiter).inUse).toBe(1);

      // Still a real cap: the second acquire waits and times out rather than passing straight through.
      const p = limiter.acquire({ deadlineMs: 500 });
      const rejected = expect(p).rejects.toMatchObject({ code: 'rate_limited', reason: 'deadline' });
      await vi.advanceTimersByTimeAsync(500);
      await rejected;

      held.settle();
      expect(semOf(limiter).inUse).toBe(0);
    });

    it('reports that back-off was UNAVAILABLE instead of claiming a penalty it never applied', () => {
      const limiter = frozen({ maxConcurrent: 4 });
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      warn.mockClear();

      limiter.penalize(limiter.nowMs() + 5_000, 'stt_over_limit');

      // `ratelimit.penalized` is the "we backed off" signal. Emitting it here would tell an
      // operator the refusal was absorbed when in fact nothing was held back at all.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'ratelimit.penalty_unavailable',
        expect.objectContaining({ limiter: 'test', reason: 'stt_over_limit' }),
      );
    });

    it('still penalizes normally once a rate dimension exists alongside the permits', () => {
      const limiter = frozen({ rpm: 60, maxConcurrent: 4 });
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      warn.mockClear();

      limiter.penalize(5_000, 'stt_over_limit');

      expect(penaltyOf(bucketOf(limiter, 'rpm'))).toBe(5_000);
      expect(warn).toHaveBeenCalledWith('ratelimit.penalized', expect.objectContaining({ reason: 'stt_over_limit' }));
    });
  });

  describe('NO_LIMIT', () => {
    it('is a straight passthrough with no wait and no timers', async () => {
      const lease = await NO_LIMIT.acquire({ cost: 100_000, deadlineMs: 0 });
      expect(lease.waitedMs).toBe(0);
      lease.settle(999_999);

      await expect(NO_LIMIT.run({ cost: 100_000 }, async () => 'ok')).resolves.toBe('ok');
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('run', () => {
    it('settles on success and releases the permit', async () => {
      const limiter = frozen({ tpm: 600, maxConcurrent: 1 });
      const tpm = bucketOf(limiter, 'tpm');

      await expect(limiter.run({ cost: 100 }, async () => 'ok')).resolves.toBe('ok');
      expect(tpm.available).toBe(500); // settled: the reservation stands
      expect(semOf(limiter).inUse).toBe(0);
    });

    it('keeps the charge for an unclassifiable throw (fail closed)', async () => {
      // Refunding a request that DID arrive makes the limiter permanently laxer than the pool it
      // protects, exactly when that pool is under strain; over-charging one that never arrived
      // costs a little throughput that refills within the window. So the unknown case pays.
      const limiter = frozen({ rpm: 60, tpm: 600, maxConcurrent: 1 });
      const [rpm, tpm] = [bucketOf(limiter, 'rpm'), bucketOf(limiter, 'tpm')];

      await expect(
        limiter.run({ cost: 100 }, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect([rpm.available, tpm.available]).toEqual([59, 500]);
      expect(semOf(limiter).inUse).toBe(0); // the permit still comes back — the call is over
    });

    it('does NOT refund a 5xx or a terminal 4xx either — the provider counted those too', async () => {
      // The distinction is arrival, not rejection-for-rate. A 500 was transmitted, parsed and
      // billed against the quota exactly like a 429 was; special-casing only 429 refunded the
      // rest of them.
      const limiter = frozen({ rpm: 60, tpm: 600 });
      const [rpm, tpm] = [bucketOf(limiter, 'rpm'), bucketOf(limiter, 'tpm')];

      for (const status of [500, 400]) {
        await expect(
          limiter.run({ cost: 100 }, async () => {
            throw Object.assign(new Error(`http ${status}`), { status });
          }),
        ).rejects.toThrow(`http ${status}`);
      }

      expect([rpm.available, tpm.available]).toEqual([58, 400]);
    });

    it('does NOT refund a 429 — the provider already counted that request', async () => {
      // Policy §6: failed requests still count against the limit. Refunding here would let the
      // caller retry for free against a pool that is already rejecting us, so a burst of 429s
      // would cost nothing locally and compound at the provider.
      const limiter = frozen({ rpm: 60, tpm: 600, maxConcurrent: 1 });
      const [rpm, tpm] = [bucketOf(limiter, 'rpm'), bucketOf(limiter, 'tpm')];

      await expect(
        limiter.run({ cost: 100 }, async () => {
          throw Object.assign(new Error('rate limited'), { status: 429 });
        }),
      ).rejects.toThrow('rate limited');

      expect([rpm.available, tpm.available]).toEqual([59, 500]);
      expect(semOf(limiter).inUse).toBe(0); // the permit still comes back — the call is over
    });

    it('still refunds a failure that never reached the provider', async () => {
      // The distinction is arrival, not failure: a connection refused before the request was sent
      // spent no quota, so refusing to refund it would shape against calls that never happened.
      const limiter = frozen({ rpm: 60, tpm: 600 });
      const [rpm, tpm] = [bucketOf(limiter, 'rpm'), bucketOf(limiter, 'tpm')];

      await expect(
        limiter.run({ cost: 100 }, async () => {
          throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        }),
      ).rejects.toThrow('ECONNREFUSED');

      expect([rpm.available, tpm.available]).toEqual([60, 600]);
    });

    it('refunds through the cause chain fetch hides the connection error behind', async () => {
      const limiter = frozen({ rpm: 60, tpm: 600 });
      const [rpm, tpm] = [bucketOf(limiter, 'rpm'), bucketOf(limiter, 'tpm')];

      await expect(
        limiter.run({ cost: 100 }, async () => {
          throw Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
          });
        }),
      ).rejects.toThrow('fetch failed');

      expect([rpm.available, tpm.available]).toEqual([60, 600]);
    });
  });
});
