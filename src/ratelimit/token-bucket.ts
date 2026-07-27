import { RATE_LIMIT } from '../config/constants.js';
import { logger } from '../config/logger.js';
import { RateLimitTimeoutError } from './errors.js';

/** A caller parked until the bucket can pay for `need`. Strict FIFO — never reordered. */
interface Waiter {
  readonly need: number;
  readonly startedAt: number;
  readonly resolve: (waitedMs: number) => void;
  readonly reject: (err: RateLimitTimeoutError) => void;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  detachAbort: (() => void) | null;
}

/**
 * Token bucket for the rate dimensions providers actually meter (RPM, TPM).
 *
 * Waiting is scheduled, not polled: exactly ONE timer is armed, for the queue head, and re-armed
 * as the queue drains. The clock is injected and must be monotonic — `Date.now()` can be stepped
 * backwards by NTP, which would make tokens vanish.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;
  /** No grant may happen before this instant (a 429 penalty). Not a drain — see policy §6. */
  private penaltyUntil = 0;
  private readonly queue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private warnedOversizedCost = false;

  constructor(
    readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number = () => performance.now(),
    private readonly name = 'bucket',
  ) {
    this.tokens = capacity;
    this.lastRefillAt = this.now();
  }

  /** Tokens on hand right now; negative after a reconciliation overshoot. */
  get available(): number {
    this.refill();
    return this.tokens;
  }

  /** Number of callers parked on this bucket. */
  get queued(): number {
    return this.queue.length;
  }

  /**
   * Take `n` if it can be paid for immediately. Never waits, never queues. Yields to parked
   * waiters: a sync taker must not jump a queue that has been waiting for the same tokens.
   * Unlike {@link take} this does NOT clamp `n` — an over-capacity ask simply fails.
   */
  tryTake(n: number): boolean {
    if (n <= 0) return true;
    this.refill();
    if (this.now() < this.penaltyUntil) return false;
    if (this.queue.length > 0) return false;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  /**
   * Take `n`, waiting up to the absolute `deadlineAt` (same monotonic clock as `now`).
   * Resolves with the milliseconds spent waiting.
   */
  take(cost: number, deadlineAt: number, signal?: AbortSignal): Promise<number> {
    const need = this.clamp(cost);
    if (signal?.aborted) {
      return Promise.reject(new RateLimitTimeoutError('aborted', `${this.name}: aborted before capacity was granted`));
    }
    const startedAt = this.now();
    if (this.tryTake(need)) return Promise.resolve(0);
    if (this.queue.length >= RATE_LIMIT.maxQueuedWaiters) {
      return Promise.reject(new RateLimitTimeoutError('queue_full', `${this.name}: rate limit queue is full`));
    }

    return new Promise<number>((resolve, reject) => {
      const waiter: Waiter = { need, startedAt, resolve, reject, deadlineTimer: null, detachAbort: null };
      // A dead waiter must hold no place in the queue — a corpse ahead of live callers is a
      // capacity leak that never resolves itself.
      const fail = (reason: 'deadline' | 'aborted', message: string): void => {
        if (!this.remove(waiter)) return; // already granted
        waiter.reject(new RateLimitTimeoutError(reason, message));
        this.reschedule();
      };

      waiter.deadlineTimer = setTimeout(
        () => fail('deadline', `${this.name}: timed out waiting for capacity`),
        Math.max(0, deadlineAt - startedAt),
      );
      waiter.deadlineTimer.unref?.();

      if (signal) {
        const onAbort = (): void => fail('aborted', `${this.name}: aborted while waiting for capacity`);
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.detachAbort = () => signal.removeEventListener('abort', onAbort);
      }

      this.queue.push(waiter);
      this.reschedule();
    });
  }

  /** Charge `n` unconditionally. May drive the bucket negative — an honest "already overspent"
   *  that drains at the quota rate. Used to reconcile an under-estimate. */
  forceTake(n: number): void {
    if (n <= 0) return;
    this.refill();
    this.tokens -= n;
    this.reschedule();
  }

  /** Give `n` back, never above capacity. */
  refund(n: number): void {
    if (n <= 0) return;
    this.refill();
    this.tokens = Math.min(this.capacity, this.tokens + n);
    this.reschedule();
  }

  /** Floor the next grant at `untilMs` (an instant on the injected clock). Penalties only ever
   *  extend, so a shorter one can't undo a longer one still in force. */
  penalize(untilMs: number): void {
    if (untilMs <= this.penaltyUntil) return;
    this.penaltyUntil = untilMs;
    this.reschedule();
  }

  /** A cost above capacity can never be paid, so an unguarded waiter would hang to its deadline
   *  on every single call. Clamp to capacity — it degrades to "wait one refill period" — and say
   *  so once, since the cause is a misconfigured plan tier, not a transient. */
  private clamp(cost: number): number {
    const need = Math.max(0, cost);
    if (need <= this.capacity) return need;
    if (!this.warnedOversizedCost) {
      this.warnedOversizedCost = true;
      logger.warn('ratelimit.cost_exceeds_capacity', { limiter: this.name, cost: need, capacity: this.capacity });
    }
    return this.capacity;
  }

  private refill(): void {
    const t = this.now();
    const elapsed = Math.max(0, t - this.lastRefillAt);
    // Never move the mark backwards: a clock that stepped back and then forward again would
    // otherwise be credited twice for the same interval.
    if (t > this.lastRefillAt) this.lastRefillAt = t;
    if (elapsed === 0 || this.refillPerSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.refillPerSec);
  }

  /** Splice a waiter out and drop its timers. False when it is no longer queued. */
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

  /** Pay out whoever can be paid, head-first, then arm one timer for the new head. */
  private reschedule(): void {
    this.refill();
    const t = this.now();
    while (this.queue.length > 0 && t >= this.penaltyUntil) {
      const head = this.queue[0];
      if (head === undefined || this.tokens < head.need) break;
      this.tokens -= head.need;
      this.queue.shift();
      this.dispose(head);
      head.resolve(Math.max(0, t - head.startedAt));
    }

    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const head = this.queue[0];
    if (head === undefined) return;

    const deficit = head.need - this.tokens;
    const refillWait =
      deficit <= 0 ? 0 : this.refillPerSec > 0 ? Math.ceil((deficit / this.refillPerSec) * 1000) : Number.POSITIVE_INFINITY;
    const waitMs = Math.max(this.penaltyUntil - t, refillWait);
    // A bucket that never refills can only be released by the waiter's own deadline timer.
    if (!Number.isFinite(waitMs)) return;

    this.timer = setTimeout(() => {
      this.timer = null;
      this.reschedule();
    }, Math.max(0, waitMs));
    // Housekeeping timer: never keep the process alive on its own account.
    this.timer.unref?.();
  }
}
