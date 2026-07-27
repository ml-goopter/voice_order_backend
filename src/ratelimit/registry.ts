import { logger } from '../config/logger.js';
import { hasAnyLimit, NO_LIMIT, RateLimiter, type RateLimits } from './rate-limiter.js';

/**
 * What the provider actually meters against. Two adapters pointing at the same account, model and
 * endpoint share ONE quota and must therefore share ONE limiter: `env.ts` falls every
 * `INTENT_LLM_*` var back to its `LLM_*` twin, so by default both LLM adapters are the same pool
 * and two independent limiters would silently grant twice the real budget.
 *
 * `name` is a log label only — it is NOT part of the identity, precisely so `llm` and `intent-llm`
 * collapse onto one limiter when they share credentials. `provider` IS part of it: STT, TTS and
 * embeddings key on their api key alone, so without a vendor namespace two unset keys (or two
 * deployments that happen to reuse one string) would collapse unrelated vendors onto one bucket.
 */
export interface QuotaKey {
  /** Log label for this call site. Never part of the identity. */
  readonly name: string;
  /** Vendor pool this quota belongs to. Both LLM adapters deliberately pass the SAME value. */
  readonly provider: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly model?: string;
}

function identityOf(key: QuotaKey): string {
  return `${key.provider}|${key.baseUrl ?? ''}|${key.apiKey ?? ''}|${key.model ?? ''}`;
}

/** One resolved limiter, for the boot line. Env values alone cannot answer the question an
 *  operator actually has — did `llm` and `intent-llm` end up on one bucket or two? — because that
 *  depends on identity, not on the numbers. */
export interface LimiterReport {
  /** The limiter instance's own name (the call site that registered it first). */
  readonly limiter: string;
  /** Every call site resolved to this instance, in registration order. */
  readonly callSites: readonly string[];
  /** The limits actually in force (the first writer's). */
  readonly limits: RateLimits;
  /** False when this identity resolved to the shared {@link NO_LIMIT} passthrough. */
  readonly shaped: boolean;
}

/** Compares the QUOTA dimensions only. A disagreement here is a real bug — two adapters claiming
 *  different budgets for one provider pool — and must be reported. Wait deadlines are deliberately
 *  absent: they are per-acquire latency budgets, so two call sites sharing a limiter may differ
 *  without conflict (see `AcquireOptions.deadlineMs`). */
function sameLimits(a: RateLimits, b: RateLimits): boolean {
  return (
    (a.rpm ?? 0) === (b.rpm ?? 0) &&
    (a.tpm ?? 0) === (b.tpm ?? 0) &&
    (a.maxConcurrent ?? 0) === (b.maxConcurrent ?? 0)
  );
}

interface Entry {
  readonly limiter: RateLimiter;
  readonly limits: RateLimits;
  readonly callSites: string[];
}

/** Memoizes one {@link RateLimiter} per quota identity. */
export class RateLimiterRegistry {
  private readonly limiters = new Map<string, Entry>();

  get(key: QuotaKey, limits: RateLimits): RateLimiter {
    // The identity bookkeeping runs even when nothing is capped. Short-circuiting on "no limits"
    // would make `{rpm: 0}` invisible to the conflict check, so an operator who zeroed ONE side of
    // a shared pool (INTENT_LLM_RPM=0 against a shaped LLM_RPM) would get an unshaped adapter
    // hammering the quota the other adapter is being throttled against, silently.
    const id = identityOf(key);
    const existing = this.limiters.get(id);
    if (existing !== undefined) {
      // First writer wins: silently re-configuring a live limiter would strand its queued
      // waiters under limits they were never admitted against, and would split one quota pool
      // across two limiter objects — the exact thing this registry exists to prevent.
      if (!sameLimits(existing.limits, limits)) {
        logger.warn('ratelimit.limits_conflict', {
          limiter: existing.limiter.name,
          requested_by: key.name,
          kept: existing.limits,
          ignored: limits,
          // The worst shape of this conflict is `kept` being all-zero: the first writer registered
          // NO_LIMIT, so the pool ends up entirely UNSHAPED even though a later call site asked for
          // a cap (`LLM_RPM=0` with `INTENT_LLM_RPM=500` on shared creds). `kept`/`ignored` alone
          // read as "we picked one of two caps"; this field says whether any cap survived at all.
          shaped: hasAnyLimit(existing.limits),
        });
      }
      existing.callSites.push(key.name);
      return existing.limiter;
    }

    // Nothing capped → the SHARED passthrough: no buckets, no permits, no timers. This is what
    // keeps the feature dark by default; only the map entry is new, and it exists solely so a
    // later disagreement on this identity is still reported.
    const limiter = hasAnyLimit(limits) ? new RateLimiter(key.name, limits) : NO_LIMIT;
    this.limiters.set(id, { limiter, limits, callSites: [key.name] });
    return limiter;
  }

  /** What the registry actually resolved, one row per quota identity. */
  describe(): LimiterReport[] {
    return [...this.limiters.values()].map((e) => ({
      limiter: e.limiter.name,
      callSites: [...e.callSites],
      limits: e.limits,
      shaped: e.limiter !== NO_LIMIT,
    }));
  }

  /** Test seam — the singleton otherwise leaks limiters between cases. */
  reset(): void {
    this.limiters.clear();
  }
}

/** Process-wide registry (mirrors `eventBus`). */
export const rateLimiters = new RateLimiterRegistry();
