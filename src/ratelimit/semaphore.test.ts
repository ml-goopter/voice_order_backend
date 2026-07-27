import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Semaphore, type Release } from './semaphore.js';
import { logger } from '../config/logger.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Semaphore', () => {
  it('parks a caller once the permits are gone and grants on release', async () => {
    const s = new Semaphore(2);
    const first = await s.acquire(60_000);
    await s.acquire(60_000);
    expect(s.inUse).toBe(2);

    let third: Release | undefined;
    const pending = s.acquire(60_000).then((r) => {
      third = r;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(third).toBeUndefined();

    first();
    await pending;
    expect(third).toBeDefined();
    expect(s.inUse).toBe(2);
  });

  it('a double release is a no-op — the permit pool never inflates', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const s = new Semaphore(2);
    const first = await s.acquire(60_000);
    await s.acquire(60_000);

    let third: Release | undefined;
    const pending = s.acquire(60_000).then((r) => {
      third = r;
    });

    first();
    first(); // the STT teardown paths can all fire; the second must change nothing
    await pending;

    expect(third).toBeDefined();
    expect(s.inUse).toBe(2);
    expect(s.queued).toBe(0);
    expect(warn).toHaveBeenCalledWith('ratelimit.double_release', expect.anything());
  });

  it('hands each released permit to the queue head in arrival order', async () => {
    const s = new Semaphore(1);
    const held = await s.acquire(60_000);
    const order: number[] = [];
    const releases: Release[] = [];
    for (const n of [1, 2, 3, 4]) {
      void s.acquire(60_000).then((r) => {
        order.push(n);
        releases.push(r);
      });
    }

    let current = held;
    for (let i = 0; i < 4; i++) {
      current();
      await vi.advanceTimersByTimeAsync(0);
      current = releases[i] as Release;
    }
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('a deadline-expired waiter is dequeued, so a later release reaches a live one', async () => {
    const s = new Semaphore(1);
    const held = await s.acquire(60_000);

    const dying = s.acquire(1_000);
    const rejected = expect(dying).rejects.toMatchObject({ reason: 'deadline' });
    let live = false;
    const survivor = s.acquire(60_000).then(() => {
      live = true;
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(s.queued).toBe(1);

    held();
    await survivor;
    expect(live).toBe(true);
    expect(s.inUse).toBe(1);
  });

  it('an abort rejects a pending acquire and frees its queue slot', async () => {
    const s = new Semaphore(1);
    const held = await s.acquire(60_000);
    const ac = new AbortController();
    const pending = s.acquire(60_000, ac.signal);
    const rejected = expect(pending).rejects.toMatchObject({ reason: 'aborted' });

    ac.abort();
    await rejected;
    expect(s.queued).toBe(0);

    held();
    expect(s.inUse).toBe(0);
  });

  it('releasing in a finally returns the permit even when the body throws', async () => {
    const s = new Semaphore(1);
    const release = await s.acquire(60_000);
    await expect(
      (async () => {
        try {
          throw new Error('boom');
        } finally {
          release();
        }
      })(),
    ).rejects.toThrow('boom');
    expect(s.inUse).toBe(0);
  });
});
