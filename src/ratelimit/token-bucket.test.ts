import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TokenBucket } from './token-bucket.js';
import { RATE_LIMIT } from '../config/constants.js';
import { logger } from '../config/logger.js';

// vitest's useFakeTimers() fakes `performance.now` as well as setTimeout (verified: it starts at
// 0 and advances with the fake clock), so the bucket's DEFAULT monotonic clock is already under
// test control — no `toFake` config and no injected clock needed except where one is the subject.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A full cap-60 bucket refilling one token per second, drained to empty. */
function emptyBucket(name = 'test'): TokenBucket {
  const b = new TokenBucket(60, 1, undefined, name);
  expect(b.tryTake(60)).toBe(true);
  return b;
}

describe('TokenBucket', () => {
  describe('tryTake', () => {
    it('takes from a full bucket and debits it', () => {
      const b = new TokenBucket(60, 1);
      expect(b.tryTake(10)).toBe(true);
      expect(b.available).toBe(50);
    });

    it('refuses more than is on hand and leaves the bucket untouched', () => {
      const b = new TokenBucket(60, 1);
      b.tryTake(10);
      expect(b.tryTake(51)).toBe(false);
      expect(b.available).toBe(50);
    });
  });

  describe('refill', () => {
    it('credits elapsed time at the refill rate and clamps at capacity', async () => {
      const b = emptyBucket();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(b.available).toBe(30);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(b.available).toBe(60);
    });

    it('never loses tokens when the clock steps backwards', () => {
      let t = 0;
      const b = new TokenBucket(60, 1, () => t);
      b.tryTake(60);
      t = 30_000;
      expect(b.available).toBe(30);
      t = 20_000;
      expect(b.available).toBe(30);
    });
  });

  describe('take', () => {
    it('resolves exactly when the tokens have refilled, reporting the wait', async () => {
      const b = emptyBucket();
      let waited: number | undefined;
      const p = b.take(30, 60_000).then((w) => {
        waited = w;
      });

      await vi.advanceTimersByTimeAsync(29_999);
      expect(waited).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(waited).toBe(30_000);

      // The grant really debited the bucket — the next taker starts from ~0.
      await vi.advanceTimersByTimeAsync(1);
      expect(b.tryTake(1)).toBe(false);
    });

    it('serves waiters strictly FIFO — a small ask cannot jump a large one', async () => {
      const b = emptyBucket();
      const seen: string[] = [];
      const a = b.take(10, 60_000).then((w) => seen.push(`A:${w}`));
      const c = b.take(1, 60_000).then((w) => seen.push(`B:${w}`));

      await vi.advanceTimersByTimeAsync(1_000);
      expect(seen).toEqual([]); // B could be paid already, but A is ahead of it
      await vi.advanceTimersByTimeAsync(9_000);
      expect(seen).toEqual(['A:10000']);
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.all([a, c]);
      expect(seen).toEqual(['A:10000', 'B:11000']);
    });

    it('splices a deadline-expired waiter out, so it holds no reservation', async () => {
      const b = emptyBucket();
      const p = b.take(30, 10_000);
      const rejected = expect(p).rejects.toMatchObject({ code: 'rate_limited', reason: 'deadline' });

      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      expect(b.queued).toBe(0);

      // The corpse is not holding the 30 tokens it was waiting for.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(b.tryTake(5)).toBe(true);
    });

    it('honours a penalty floor even on a full bucket', async () => {
      const b = new TokenBucket(60, 1);
      b.penalize(5_000);
      let waited: number | undefined;
      const p = b.take(1, 60_000).then((w) => {
        waited = w;
      });

      await vi.advanceTimersByTimeAsync(4_999);
      expect(waited).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(waited).toBe(5_000);
    });

    it('clamps a cost above capacity and warns once, instead of hanging to the deadline', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const b = emptyBucket('llm:tpm');

      let waited: number | undefined;
      const p = b.take(100, 300_000).then((w) => {
        waited = w;
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await p;
      expect(waited).toBe(60_000);
      expect(warn).toHaveBeenCalledWith(
        'ratelimit.cost_exceeds_capacity',
        expect.objectContaining({ limiter: 'llm:tpm', cost: 100, capacity: 60 }),
      );

      // Once per instance — a misconfigured plan tier must not flood the log.
      void b.take(100, 300_000).catch(() => undefined);
      expect(warn.mock.calls.filter((c) => c[0] === 'ratelimit.cost_exceeds_capacity')).toHaveLength(1);
    });

    it('rejects an already-aborted signal without queueing', async () => {
      const b = emptyBucket();
      await expect(b.take(10, 60_000, AbortSignal.abort())).rejects.toMatchObject({ reason: 'aborted' });
      expect(b.queued).toBe(0);
    });

    it('an abort mid-wait rejects and dequeues', async () => {
      const b = emptyBucket();
      const ac = new AbortController();
      const p = b.take(10, 60_000, ac.signal);
      const rejected = expect(p).rejects.toMatchObject({ reason: 'aborted' });

      await vi.advanceTimersByTimeAsync(1_000);
      ac.abort();
      await rejected;
      expect(b.queued).toBe(0);

      await vi.advanceTimersByTimeAsync(9_000);
      expect(b.tryTake(10)).toBe(true);
    });

    it('rejects synchronously past the queue depth cap', async () => {
      const b = emptyBucket();
      for (let i = 0; i < RATE_LIMIT.maxQueuedWaiters; i++) {
        void b.take(60, 600_000).catch(() => undefined);
      }
      expect(b.queued).toBe(RATE_LIMIT.maxQueuedWaiters);
      await expect(b.take(1, 600_000)).rejects.toMatchObject({ reason: 'queue_full' });
    });

    it('unrefs its scheduling timer so a queued waiter cannot hold the process open', async () => {
      const b = emptyBucket();
      void b.take(30, 60_000).catch(() => undefined);
      const timer = (b as unknown as { timer: { hasRef(): boolean } | null }).timer;
      expect(timer?.hasRef()).toBe(false);
    });
  });

  describe('reconciliation', () => {
    it('forceTake drives the bucket negative and the debt drains at the quota rate', async () => {
      const b = new TokenBucket(60, 1);
      b.forceTake(80);
      expect(b.available).toBe(-20);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(b.available).toBe(20);
    });

    it('refund never credits above capacity', () => {
      const b = new TokenBucket(60, 1);
      b.refund(10);
      expect(b.available).toBe(60);
    });
  });
});
