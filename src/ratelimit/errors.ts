import { AppError } from '../shared/errors.js';

/** Why a limiter refused to grant capacity. Mirrors the `ratelimit.rejected` log field. */
export type RateLimitRejectReason = 'deadline' | 'queue_full' | 'aborted';

/**
 * A caller waited for capacity and did not get it. Lives here rather than in `rate-limiter.ts`
 * so the primitives (`TokenBucket`, `Semaphore`) can throw it without importing the facade that
 * composes them; `rate-limiter.ts` re-exports it as the module's public surface.
 */
export class RateLimitTimeoutError extends AppError {
  constructor(
    public readonly reason: RateLimitRejectReason,
    message: string,
  ) {
    super('rate_limited', message);
  }
}
