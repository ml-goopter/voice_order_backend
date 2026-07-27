import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * `.env.example` is the configuration operators actually start from, so a hazard baked into it
 * ships to every deployment that copies it. These cases boot a config from the example itself.
 *
 * Everything reaching `config/env.js` is imported DYNAMICALLY, below the process.env setup —
 * a static import is hoisted above it and would read the ambient environment instead.
 */
const EXAMPLE = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');

/** Every KEY mentioned in the file, set or commented out. */
function mentionedKeys(): string[] {
  const keys: string[] = [];
  for (const line of EXAMPLE.split('\n')) {
    const m = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (m?.[1]) keys.push(m[1]);
  }
  return keys;
}

/** Only the ACTIVE assignments — what an operator gets by copying the file unedited. */
function activeAssignments(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of EXAMPLE.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m?.[1] !== undefined) out[m[1]] = m[2] ?? '';
  }
  return out;
}

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  // The ambient environment (a developer's real .env) must not leak into the example's config.
  for (const k of mentionedKeys()) delete process.env[k];
  Object.assign(process.env, activeAssignments());
  vi.resetModules();
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  vi.resetModules();
});

describe('.env.example', () => {
  // `cp .env.example .env` is the documented starting point, so the file has to BE dotenv — the
  // helpers above tolerate junk by ignoring anything they don't recognise, which is how a markdown
  // ```dotenv fence sat around the whole file unnoticed. Check the lines, then check the values
  // actually landed: both halves are needed, since a file of pure comments passes either alone.
  it('is valid dotenv, and its values really do reach the config', async () => {
    const unparseable = EXAMPLE.split('\n')
      .map((line, i) => ({ line: i + 1, text: line.trim() }))
      .filter(({ text }) => text !== '' && !text.startsWith('#') && !/^[A-Z][A-Z0-9_]*=/.test(text));
    expect(unparseable).toEqual([]);

    const { config } = await import('./env.js');
    // Both differ from env.ts's own fallback, so they can only have come from the file.
    expect(config.odooApiDatabase).toBe('jadegarden1');
    expect(config.llmApiKey).toBe('ollama');
  });

  it('leaves the intent classifier on the main LLM quota, so both adapters share ONE limiter', async () => {
    // A classifier pointed at its own model is a SECOND limiter, and every INTENT_LLM_* rate var
    // falls back to its LLM_* twin BY VALUE — so an example that ships a different model hands the
    // classifier a full copy of LLM_RPM/LLM_TPM and shapes against twice the budget bought. No
    // conflict is reported, because the two limiters are genuinely distinct quotas.
    const { rateLimiters } = await import('../ratelimit/registry.js');
    const { createLlmProvider, createIntentLlmProvider } = await import('../llm/llm-client.js');
    rateLimiters.reset();
    try {
      createLlmProvider();
      createIntentLlmProvider();

      const rows = rateLimiters.describe();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.callSites).toEqual(['llm', 'intent-llm']);
    } finally {
      rateLimiters.reset();
    }
  });

  it('ships every quota unset, so rate limiting is off until an operator turns it on', async () => {
    const { config } = await import('./env.js');
    expect([
      config.llmRpm,
      config.llmTpm,
      config.llmMaxConcurrent,
      config.intentLlmRpm,
      config.intentLlmTpm,
      config.ttsMaxConcurrent,
      config.sttSessionsPerMin,
      config.sttMaxConcurrentSessions,
      config.embeddingRpm,
      config.embeddingTpm,
    ]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});
