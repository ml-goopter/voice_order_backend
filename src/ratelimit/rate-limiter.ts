import { RATE_LIMIT } from '../config/constants.js';
import { logger } from '../config/logger.js';
import { reachedProvider } from './arrival.js';
import { RateLimitTimeoutError } from './errors.js';
import { Semaphore, type Release } from './semaphore.js';
import { TokenBucket } from './token-bucket.js';

export { RateLimitTimeoutError, type RateLimitRejectReason } from './errors.js';

/** Quota bought from one provider plan. Every value `0` means unlimited in that dimension;
 *  all of them `0` means the caller should get {@link NO_LIMIT}. */
export interface RateLimits {
  /** Requests per minute. */
  readonly rpm?: number;
  /** Tokens per minute. */
  readonly tpm?: number;
  /** Simultaneous in-flight calls. */
  readonly maxConcurrent?: number;
}

/** One reservation. Exactly one of `settle`/`abandon` takes effect; later calls are no-ops. */
export interface Lease {
  /** The provider counted this request — it completed, or it was REJECTED after arriving (any
   *  HTTP status, not just a 429). `actualCost` reconciles the TPM reservation upwards only — see
   *  the reservation-basis rule on {@link RateLimiter}. Omit it when the provider reported no usage. */
  settle(actualCost?: number): void;
  /** The call provably never left this process (connection refused, DNS failure, abandoned before
   *  dispatch). Refunds everything. Never use this for a failure that MIGHT have arrived — see
   *  {@link reachedProvider}. */
  abandon(): void;
  /** Milliseconds this acquire spent waiting for capacity. */
  readonly waitedMs: number;
}

export interface AcquireOptions {
  /** TPM cost to reserve. `0`/omitted skips the token bucket entirely. */
  readonly cost?: number;
  /** Wait budget for THIS call, in ms. A latency budget belongs to the call site, not to the
   *  quota: two adapters sharing one limiter (parser vs. intent classifier) legitimately want
   *  different budgets. Omitted → {@link RATE_LIMIT.defaultWaitMs}. */
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

const NOOP_LEASE: Lease = { settle: () => {}, abandon: () => {}, waitedMs: 0 };

/** True when at least one dimension is actually capped. */
export function hasAnyLimit(limits: RateLimits): boolean {
  return (limits.rpm ?? 0) > 0 || (limits.tpm ?? 0) > 0 || (limits.maxConcurrent ?? 0) > 0;
}

function reasonOf(err: unknown): string {
  return err instanceof RateLimitTimeoutError ? err.reason : 'error';
}

/**
 * Proactive rate shaping for one provider quota: RPM and TPM token buckets plus a concurrency
 * semaphore, behind a single acquire/settle facade. Purely local — the provider SDK stays the
 * sole reactive 429 handler (policy §6).
 *
 * Two rules are load-bearing:
 *
 * - **One absolute deadline** is computed once and shared by all three stages, so total wait is
 *   bounded by `deadlineMs` rather than three times it.
 * - **The reservation basis never shrinks.** `settle` only ever charges MORE. Providers assess
 *   the estimate before generation and issue no refund when the response comes in short, so a
 *   limiter that refunded locally would be more permissive than the provider it protects and
 *   would manufacture the 429s it exists to prevent (policy §5.3).
 */
export class RateLimiter {
  private readonly rpm: TokenBucket | null;
  private readonly tpm: TokenBucket | null;
  private readonly concurrency: Semaphore | null;
  private readonly unlimited: boolean;

  constructor(
    readonly name: string,
    limits: RateLimits,
    private readonly clock: () => number = () => performance.now(),
  ) {
    const rpm = limits.rpm ?? 0;
    const tpm = limits.tpm ?? 0;
    const maxConcurrent = limits.maxConcurrent ?? 0;
    // Capacity is one minute's budget and refill is that budget spread over the minute: burst
    // tolerance matches how the providers themselves meter.
    this.rpm = rpm > 0 ? new TokenBucket(rpm, rpm / 60, clock, `${name}:rpm`) : null;
    this.tpm = tpm > 0 ? new TokenBucket(tpm, tpm / 60, clock, `${name}:tpm`) : null;
    this.concurrency = maxConcurrent > 0 ? new Semaphore(maxConcurrent, clock, `${name}:concurrency`) : null;
    this.unlimited = !hasAnyLimit(limits);
  }

  /** The limiter's monotonic clock. Callers need it to turn a `Retry-After` duration into the
   *  absolute instant {@link penalize} expects. */
  nowMs(): number {
    return this.clock();
  }

  async acquire(options: AcquireOptions = {}): Promise<Lease> {
    if (this.unlimited) return NOOP_LEASE;

    const startedAt = this.clock();
    const deadlineAt = startedAt + (options.deadlineMs ?? RATE_LIMIT.defaultWaitMs);
    const cost = Math.max(0, options.cost ?? 0);
    // The bucket clamps an over-capacity ask; mirror that here so a refund gives back exactly
    // what was taken rather than over-crediting the bucket.
    const reserved = this.tpm !== null && cost > 0 ? Math.min(cost, this.tpm.capacity) : 0;

    let rpmTaken = false;
    let tpmTaken = 0;
    let release: Release | null = null;
    try {
      // Order is RPM → TPM → concurrency: the permit is the only stage held for the duration of
      // the call, so it is taken last and held for the shortest window. Bucket tokens are cheap
      // to hand back if a later stage fails.
      if (this.rpm !== null) {
        await this.rpm.take(1, deadlineAt, options.signal);
        rpmTaken = true;
      }
      if (this.tpm !== null && cost > 0) {
        await this.tpm.take(cost, deadlineAt, options.signal);
        tpmTaken = reserved;
      }
      if (this.concurrency !== null) {
        release = await this.concurrency.acquire(deadlineAt, options.signal);
      }
    } catch (err) {
      if (tpmTaken > 0) this.tpm?.refund(tpmTaken);
      if (rpmTaken) this.rpm?.refund(1);
      logger.warn('ratelimit.rejected', { limiter: this.name, reason: reasonOf(err), cost });
      throw err;
    }

    const waitedMs = Math.max(0, this.clock() - startedAt);
    if (waitedMs > 0) logger.debug('ratelimit.waited', { limiter: this.name, waited_ms: waitedMs, cost });

    let done = false;
    return {
      waitedMs,
      settle: (actualCost?: number): void => {
        if (done) return;
        done = true;
        if (actualCost !== undefined && this.tpm !== null) {
          // Reconcile against what was actually RESERVED, not the raw ask: an over-capacity cost
          // was clamped to capacity, and measuring the delta from the unclamped figure would
          // under-charge exactly the oversized prompt `cost_exceeds_capacity` exists to flag.
          const delta = actualCost - reserved;
          // Charge an under-estimate; NEVER refund an over-estimate (reservation-basis rule).
          if (delta > 0) this.tpm.forceTake(delta);
        }
        release?.();
      },
      abandon: (): void => {
        if (done) return;
        done = true;
        if (tpmTaken > 0) this.tpm?.refund(tpmTaken);
        if (rpmTaken) this.rpm?.refund(1);
        release?.();
      },
    };
  }

  /** Acquire, run, settle.
   *
   *  A failure only gets its reservation back when it provably never reached the provider — see
   *  {@link reachedProvider} for the rule and why the ambiguous cases keep their charge. A 429 is
   *  the loudest member of that set, but not the only one: a 500, a terminal 400 and a timeout
   *  that fired after the body was sent were all counted by the provider too. */
  async run<T>(options: AcquireOptions, fn: () => Promise<T>): Promise<T> {
    if (this.unlimited) return fn();
    const lease = await this.acquire(options);
    try {
      const result = await fn();
      lease.settle();
      return result;
    } catch (err) {
      if (reachedProvider(err)) lease.settle();
      else lease.abandon();
      throw err;
    }
  }

  /** Floor the next grant on both buckets at `untilMs` (an instant on this limiter's clock).
   *  Deliberately does not drain them — draining would conflate rate with penalty (policy §6).
   *
   *  A penalty is a RATE instrument, so a limiter configured with concurrency only (e.g.
   *  `STT_MAX_CONCURRENT_SESSIONS` set, `STT_SESSIONS_PER_MIN` left at 0) has nowhere to apply it.
   *  That case gets its own line rather than `ratelimit.penalized`: the operator is being refused
   *  by the provider with no local back-off in force, and the fix is to configure the rate
   *  dimension. Logging the penalty that did not happen would hide exactly that. */
  penalize(untilMs: number, reason: string): void {
    if (this.unlimited) return;
    if (this.rpm === null && this.tpm === null) {
      logger.warn('ratelimit.penalty_unavailable', { limiter: this.name, reason });
      return;
    }
    this.rpm?.penalize(untilMs);
    this.tpm?.penalize(untilMs);
    logger.warn('ratelimit.penalized', { limiter: this.name, reason });
  }
}

/** Shared passthrough for a deployment that configured no limits: no buckets, no permits, no
 *  timers. Keeps the feature dark by default. */
export const NO_LIMIT = new RateLimiter('none', {});
