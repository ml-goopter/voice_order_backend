import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rateLimiters } from './registry.js';
import { NO_LIMIT } from './rate-limiter.js';
import { logger } from '../config/logger.js';

const LIMITS = { rpm: 500, tpm: 90_000, maxConcurrent: 8 };
/** Both LLM adapters share one quota namespace, so only creds/model decide whether they collapse. */
const LLM = 'openai-compatible';

beforeEach(() => {
  rateLimiters.reset();
});
afterEach(() => {
  vi.restoreAllMocks();
  rateLimiters.reset();
});

describe('RateLimiterRegistry', () => {
  it('gives two adapters on the same account/model ONE limiter', () => {
    // The default config falls every INTENT_LLM_* var back to its LLM_* twin, so both adapters
    // are the same quota pool; two limiters would grant twice the real budget.
    const key = { provider: LLM, baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1', model: 'gpt-4o-mini' };
    const a = rateLimiters.get({ name: 'llm', ...key }, LIMITS);
    const b = rateLimiters.get({ name: 'intent-llm', ...key }, LIMITS);
    expect(b).toBe(a);
  });

  it('gives separate limiters to genuinely separate quotas', () => {
    const base = { provider: LLM, baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1' };
    const a = rateLimiters.get({ name: 'llm', ...base, model: 'gpt-4o' }, LIMITS);
    const b = rateLimiters.get({ name: 'intent-llm', ...base, model: 'gpt-4o-mini' }, LIMITS);
    expect(b).not.toBe(a);
  });

  it('keeps different vendors apart even when their api keys are identical', () => {
    // STT/TTS/embedding key on the api key alone, and an unconfigured key is ''. Without a vendor
    // namespace all three would collapse onto ONE bucket — an STT session then eating an embedding
    // token — and each would warn about the others' limits.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const stt = rateLimiters.get({ name: 'stt', provider: 'assemblyai', apiKey: '' }, { rpm: 5 });
    const tts = rateLimiters.get({ name: 'tts', provider: 'cartesia', apiKey: '' }, { maxConcurrent: 2 });
    const embedding = rateLimiters.get({ name: 'embedding', provider: 'jina', apiKey: '' }, { rpm: 500 });

    expect(new Set([stt, tts, embedding]).size).toBe(3);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns the shared passthrough when nothing is capped', () => {
    const limiter = rateLimiters.get({ name: 'llm', provider: LLM, model: 'gpt-4o' }, {});
    expect(limiter).toBe(NO_LIMIT);
  });

  it('keeps a deployment that configured nothing anywhere completely dark', () => {
    vi.useFakeTimers();
    try {
      const all = [
        rateLimiters.get({ name: 'stt', provider: 'assemblyai', apiKey: '' }, { rpm: 0, maxConcurrent: 0 }),
        rateLimiters.get({ name: 'tts', provider: 'cartesia', apiKey: '' }, { maxConcurrent: 0 }),
        rateLimiters.get({ name: 'llm', provider: LLM, model: 'm' }, { rpm: 0, tpm: 0, maxConcurrent: 0 }),
        rateLimiters.get({ name: 'intent-llm', provider: LLM, model: 'm' }, { rpm: 0, tpm: 0, maxConcurrent: 0 }),
      ];
      // One shared passthrough, no buckets, no permits, no timers — recording the identities for
      // conflict detection must not cost a deployment that turned nothing on.
      expect(all.every((l) => l === NO_LIMIT)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('warns when one call site zeroes a quota another call site capped', () => {
    // INTENT_LLM_RPM=0 against a shaped LLM_RPM is a real double-quota bug: the classifier would
    // hammer, unshaped, the very pool the parser is being throttled against. Resolving "no limits"
    // before the identity lookup made this disagreement invisible.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const key = { provider: LLM, apiKey: 'sk-1', model: 'gpt-4o' };
    const first = rateLimiters.get({ name: 'llm', ...key }, { rpm: 60 });
    const second = rateLimiters.get({ name: 'intent-llm', ...key }, { rpm: 0, tpm: 0 });

    expect(second).toBe(first);
    expect(second).not.toBe(NO_LIMIT); // the shaped limiter wins; the zero does not disable it
    expect(warn).toHaveBeenCalledWith(
      'ratelimit.limits_conflict',
      expect.objectContaining({ requested_by: 'intent-llm' }),
    );
  });

  it('warns when a capped call site lands on an identity already registered as unlimited', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const key = { provider: LLM, apiKey: 'sk-1', model: 'gpt-4o' };
    rateLimiters.get({ name: 'llm', ...key }, {});
    const second = rateLimiters.get({ name: 'intent-llm', ...key }, { rpm: 60 });

    // First writer still wins — NO_LIMIT is shared and cannot be reconfigured in place — but the
    // operator must be told, because the WHOLE pool is now unshaped: `LLM_RPM=0` with
    // `INTENT_LLM_RPM=500` on shared creds asks for shaping and gets none. `kept`/`ignored` alone
    // read as "we picked one of two caps", so the line has to say no cap survived.
    expect(second).toBe(NO_LIMIT);
    expect(warn).toHaveBeenCalledWith(
      'ratelimit.limits_conflict',
      expect.objectContaining({ requested_by: 'intent-llm', shaped: false, ignored: { rpm: 60 } }),
    );
  });

  it('marks a conflict that still leaves the pool shaped as shaped', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const key = { provider: LLM, apiKey: 'sk-1', model: 'gpt-4o' };
    rateLimiters.get({ name: 'llm', ...key }, { rpm: 60 });
    rateLimiters.get({ name: 'intent-llm', ...key }, { rpm: 0 });

    expect(warn).toHaveBeenCalledWith(
      'ratelimit.limits_conflict',
      expect.objectContaining({ shaped: true }),
    );
  });

  it('keeps the first configuration and warns when a later get disagrees', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const key = { name: 'llm', provider: LLM, apiKey: 'sk-1', model: 'gpt-4o' };
    const first = rateLimiters.get(key, LIMITS);
    const second = rateLimiters.get({ ...key, name: 'intent-llm' }, { ...LIMITS, rpm: 1 });

    expect(second).toBe(first);
    expect(warn).toHaveBeenCalledWith('ratelimit.limits_conflict', expect.objectContaining({ requested_by: 'intent-llm' }));
  });

  it.each(['rpm', 'tpm', 'maxConcurrent'] as const)('warns when %s disagrees', (dimension) => {
    // Each of these is a real double-quota bug: two adapters claiming different budgets for one
    // provider pool. Narrowing this check would let that pass silently.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const key = { name: 'llm', provider: LLM, apiKey: 'sk-1', model: 'gpt-4o' };
    rateLimiters.get(key, LIMITS);
    rateLimiters.get({ ...key, name: 'intent-llm' }, { ...LIMITS, [dimension]: 3 });

    expect(warn).toHaveBeenCalledWith('ratelimit.limits_conflict', expect.anything());
  });

  describe('describe()', () => {
    it('reports which call sites share a bucket and which got their own', () => {
      // The boot line's whole job: env values cannot say whether llm and intent-llm collapsed,
      // because that depends on identity rather than on the numbers.
      const shared = { provider: LLM, baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1', model: 'gpt-4o' };
      rateLimiters.get({ name: 'llm', ...shared }, { rpm: 500 });
      rateLimiters.get({ name: 'intent-llm', ...shared }, { rpm: 500 });
      rateLimiters.get({ name: 'embedding', provider: 'jina', apiKey: 'jk' }, { rpm: 100 });

      expect(rateLimiters.describe()).toEqual([
        { limiter: 'llm', callSites: ['llm', 'intent-llm'], limits: { rpm: 500 }, shaped: true },
        { limiter: 'embedding', callSites: ['embedding'], limits: { rpm: 100 }, shaped: true },
      ]);
    });

    it('marks an identity that resolved to the passthrough as unshaped', () => {
      rateLimiters.get({ name: 'tts', provider: 'cartesia', apiKey: 'ck' }, { maxConcurrent: 0 });
      expect(rateLimiters.describe()).toEqual([
        { limiter: 'none', callSites: ['tts'], limits: { maxConcurrent: 0 }, shaped: false },
      ]);
    });
  });
});
