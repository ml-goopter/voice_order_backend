import { RATE_LIMIT } from '../config/constants.js';
import { logger } from '../config/logger.js';
import { RateLimitTimeoutError } from './errors.js';

/** Hands the permit back. Idempotent: calling it twice must not inflate the permit pool. */
export type Release = () => void;

interface Waiter {
  readonly resolve: (release: Release) => void;
  readonly reject: (err: RateLimitTimeoutError) => void;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  detachAbort: (() => void) | null;
}

/**
 * FIFO counting semaphore for the concurrency dimension (Cartesia contexts, STT sockets).
 *
 * A released permit is handed straight to the queue head rather than re-contended for, so there
 * is no thundering herd and no chance of a later arrival overtaking.
 */
export class Semaphore {
  private used = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    private readonly permits: number,
    private readonly now: () => number = () => performance.now(),
    private readonly name = 'semaphore',
  ) {}

  /** Permits currently held by live callers. */
  get inUse(): number {
    return this.used;
  }

  /** Number of callers parked waiting for a permit. */
  get queued(): number {
    return this.queue.length;
  }

  /** Take a permit, waiting up to the absolute `deadlineAt` (same monotonic clock as `now`). */
  acquire(deadlineAt: number, signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) {
      return Promise.reject(new RateLimitTimeoutError('aborted', `${this.name}: aborted before a permit was granted`));
    }
    if (this.used < this.permits) {
      this.used += 1;
      return Promise.resolve(this.makeRelease());
    }
    if (this.queue.length >= RATE_LIMIT.maxQueuedWaiters) {
      return Promise.reject(new RateLimitTimeoutError('queue_full', `${this.name}: concurrency queue is full`));
    }

    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, deadlineTimer: null, detachAbort: null };
      // A dead waiter must not stay in line: the next release would be handed to a caller that
      // already gave up, permanently retiring the permit.
      const fail = (reason: 'deadline' | 'aborted', message: string): void => {
        if (!this.remove(waiter)) return; // already granted
        waiter.reject(new RateLimitTimeoutError(reason, message));
      };

      waiter.deadlineTimer = setTimeout(
        () => fail('deadline', `${this.name}: timed out waiting for a permit`),
        Math.max(0, deadlineAt - this.now()),
      );
      waiter.deadlineTimer.unref?.();

      if (signal) {
        const onAbort = (): void => fail('aborted', `${this.name}: aborted while waiting for a permit`);
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.detachAbort = () => signal.removeEventListener('abort', onAbort);
      }

      this.queue.push(waiter);
    });
  }

  /** Each grant gets its OWN release closure, so an idempotency flag can't be shared between
   *  two holders of the same permit slot. */
  private makeRelease(): Release {
    let released = false;
    return () => {
      if (released) {
        logger.warn('ratelimit.double_release', { limiter: this.name });
        return;
      }
      released = true;
      const next = this.queue.shift();
      if (next === undefined) {
        this.used -= 1;
        return;
      }
      // Direct handoff: the permit never returns to the pool, so `used` is unchanged.
      this.dispose(next);
      next.resolve(this.makeRelease());
    };
  }

  private remove(w: Waiter): boolean {
    const i = this.queue.indexOf(w);
    if (i === -1) return false;
    this.queue.splice(i, 1);
    this.dispose(w);
    return true;
  }

  private dispose(w: Waiter): void {
    if (w.deadlineTimer !== null) {
      clearTimeout(w.deadlineTimer);
      w.deadlineTimer = null;
    }
    w.detachAbort?.();
    w.detachAbort = null;
  }
}
