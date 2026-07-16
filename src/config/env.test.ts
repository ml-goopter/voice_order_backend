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

    it('truncates a decimal via parseInt', async () => {
      expect((await freshConfig({ PORT: '80.9' })).port).toBe(80);
    });
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
});
