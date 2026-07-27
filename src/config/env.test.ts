import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AppConfig } from './env.js';

// env.ts binds `config` from process.env at import time, so each case sets env then
// re-imports a fresh module. Snapshot/restore process.env around every test.
let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  vi.resetModules();
  // Without this a console spy is reused across cases and accumulates the previous ones' calls.
  vi.restoreAllMocks();
});

async function freshConfig(env: Record<string, string | undefined>): Promise<AppConfig> {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  return (await import('./env.js')).config;
}

describe('env config', () => {
  describe('int()', () => {
    it('parses a numeric value', async () => {
      expect((await freshConfig({ PORT: '8080' })).port).toBe(8080);
    });

    it('falls back (not NaN) on a non-numeric value', async () => {
      const c = await freshConfig({ PORT: 'not-a-number' });
      expect(c.port).toBe(3000);
      expect(Number.isNaN(c.port)).toBe(false);
    });

    it('treats an empty string as unset → fallback', async () => {
      expect((await freshConfig({ PORT: '' })).port).toBe(3000);
    });

    it('falls back when unset', async () => {
      expect((await freshConfig({ PORT: undefined })).port).toBe(3000);
    });

    // Every int here is a count, a port or a duration, so a fraction or a negative is always a
    // typo. `parseInt` obeyed them silently, and for a rate limit the silence was dangerous:
    // `LLM_RPM=0.9` truncated to 0, which in this config means UNLIMITED — the exact opposite of
    // what was asked for — and `LLM_RPM=-5` disabled shaping just as quietly.
    it('rejects a fractional value instead of truncating it', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect((await freshConfig({ PORT: '80.9' })).port).toBe(3000);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('config.invalid_int'));
    });

    it('rejects a fractional rate limit rather than silently disabling shaping', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect((await freshConfig({ LLM_RPM: '0.9' })).llmRpm).toBe(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('LLM_RPM'));
    });

    it('rejects a negative value', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect((await freshConfig({ LLM_TPM: '-5' })).llmTpm).toBe(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('config.invalid_int'));
    });

    // Asserting the spy saw NOTHING would depend on the ambient environment holding no other
    // malformed int — a machine with a typo'd unrelated var would fail this case. Assert instead
    // that nothing complained about THIS name.
    it('accepts a plain non-negative integer without complaint', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect((await freshConfig({ LLM_RPM: '500' })).llmRpm).toBe(500);
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('"name":"LLM_RPM"'));
    });

    // `Number` is far wider than a dotenv value ever is. Each of these parses to a real number the
    // operator did not write — `0x10` to 16, `1e3` to 1000, `+7`/`' 5 '` to 7 and 5 — so obeying
    // them silently sets a quota nobody asked for. Digits only, everything else is a typo.
    it.each(['0x10', '1e3', ' 5 ', '+7', '5.0', 'Infinity'])(
      'rejects %j rather than coercing it to a number nobody wrote',
      async (raw) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        expect((await freshConfig({ LLM_RPM: raw })).llmRpm).toBe(0);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"name":"LLM_RPM"'));
      },
    );
  });

  describe('str()', () => {
    it('treats an empty string as unset → fallback', async () => {
      expect((await freshConfig({ LOG_LEVEL: '' })).logLevel).toBe('info');
    });

    it('uses the provided value', async () => {
      expect((await freshConfig({ LOG_LEVEL: 'debug' })).logLevel).toBe('debug');
    });
  });

  describe('list()', () => {
    it('splits on commas, trims, and drops blank entries', async () => {
      const c = await freshConfig({ MENU_EXCLUDED_CATEGORIES: 'CUSTOMER TYPE, ,Charges,' });
      expect(c.menuExcludedCategories).toEqual(['CUSTOMER TYPE', 'Charges']);
    });

    it('is empty when unset', async () => {
      expect((await freshConfig({ MENU_EXCLUDED_CATEGORIES: undefined })).menuExcludedCategories).toEqual([]);
    });
  });

  describe('INTENT_LLM_* → LLM_* fallback chain', () => {
    it('reuses LLM_* when the INTENT_LLM_* var is unset', async () => {
      const c = await freshConfig({
        LLM_PROVIDER: 'openai',
        LLM_TIMEOUT_MS: '5000',
        INTENT_LLM_PROVIDER: undefined,
        INTENT_LLM_TIMEOUT_MS: undefined,
      });
      expect(c.intentLlmProvider).toBe('openai');
      expect(c.intentLlmTimeoutMs).toBe(5000);
    });

    it('prefers the INTENT_LLM_* var when set', async () => {
      const c = await freshConfig({ LLM_PROVIDER: 'openai', INTENT_LLM_PROVIDER: 'ollama' });
      expect(c.intentLlmProvider).toBe('ollama');
    });
  });

  describe('rate limits', () => {
    it('parses a configured quota', async () => {
      expect((await freshConfig({ LLM_TPM: '90000' })).llmTpm).toBe(90_000);
    });

    it('defaults every quota to 0 = unlimited, so the limiter ships dark', async () => {
      const c = await freshConfig({
        LLM_RPM: undefined,
        LLM_TPM: undefined,
        LLM_MAX_CONCURRENT: undefined,
        TTS_MAX_CONCURRENT: undefined,
        STT_SESSIONS_PER_MIN: undefined,
        STT_MAX_CONCURRENT_SESSIONS: undefined,
        EMBEDDING_RPM: undefined,
        EMBEDDING_TPM: undefined,
        EMBEDDING_MAX_CONCURRENT: undefined,
      });
      expect([
        c.llmRpm,
        c.llmTpm,
        c.llmMaxConcurrent,
        c.ttsMaxConcurrent,
        c.sttSessionsPerMin,
        c.sttMaxConcurrentSessions,
        c.embeddingRpm,
        c.embeddingTpm,
        c.embeddingMaxConcurrent,
      ]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    });

    it('keeps non-zero wait deadlines', async () => {
      const c = await freshConfig({
        LLM_RATE_LIMIT_WAIT_MS: undefined,
        TTS_RATE_LIMIT_WAIT_MS: undefined,
        STT_RATE_LIMIT_WAIT_MS: undefined,
        EMBEDDING_RATE_LIMIT_WAIT_MS: undefined,
        LLM_MAX_OUTPUT_TOKENS_EST: undefined,
      });
      expect(c.llmRateLimitWaitMs).toBe(1_500);
      expect(c.ttsRateLimitWaitMs).toBe(800);
      expect(c.sttRateLimitWaitMs).toBe(2_000);
      expect(c.embeddingRateLimitWaitMs).toBe(1_000);
      expect(c.llmMaxOutputTokensEst).toBe(800);
    });

    it('falls INTENT_LLM_TPM back to LLM_TPM — shared creds mean a shared quota', async () => {
      const c = await freshConfig({ LLM_TPM: '90000', INTENT_LLM_TPM: undefined });
      expect(c.intentLlmTpm).toBe(90_000);
    });

    it('prefers INTENT_LLM_TPM when the classifier has its own quota', async () => {
      const c = await freshConfig({ LLM_TPM: '90000', INTENT_LLM_TPM: '1000' });
      expect(c.intentLlmTpm).toBe(1_000);
    });

    it('is 0 when neither the INTENT_LLM_* var nor its twin is set', async () => {
      const c = await freshConfig({ LLM_TPM: undefined, INTENT_LLM_TPM: undefined });
      expect(c.intentLlmTpm).toBe(0);
    });

    // The output estimate is the ONE var that must NOT inherit its LLM_* twin: it sizes a reply,
    // and the classifier's whole reply is `{"intent":"service"}`. Inheriting 800 reserves ~80× the
    // real cost on a bucket the two adapters share by default.
    it('does not fall the intent output estimate back to LLM_MAX_OUTPUT_TOKENS_EST', async () => {
      const c = await freshConfig({
        LLM_MAX_OUTPUT_TOKENS_EST: '4000',
        INTENT_LLM_MAX_OUTPUT_TOKENS_EST: undefined,
      });
      expect(c.llmMaxOutputTokensEst).toBe(4_000);
      expect(c.intentLlmMaxOutputTokensEst).toBe(32);
    });

    it('honours an explicit INTENT_LLM_MAX_OUTPUT_TOKENS_EST', async () => {
      expect(
        (await freshConfig({ INTENT_LLM_MAX_OUTPUT_TOKENS_EST: '64' })).intentLlmMaxOutputTokensEst,
      ).toBe(64);
    });
  });
});
