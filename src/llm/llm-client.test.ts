import { describe, it, expect, vi } from 'vitest';

// createLlmProvider reads config.llmProvider at import time, and the openai/ollama
// branches construct a real OpenAI client — mock the SDK and reload the module per
// case with the env that branch needs.
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: vi.fn() } };
  },
}));

async function loadFactory(env: Record<string, string>) {
  vi.resetModules();
  Object.assign(process.env, env);
  return import('./llm-client.js');
}

describe('createLlmProvider', () => {
  it('returns the stub provider for an unset/unknown provider', async () => {
    const { createLlmProvider } = await loadFactory({ LLM_PROVIDER: 'stub' });
    expect(createLlmProvider().name).toBe('stub');
  });

  it('returns an OpenAI-compatible provider for openai', async () => {
    const { createLlmProvider } = await loadFactory({ LLM_PROVIDER: 'openai', LLM_API_KEY: 'k' });
    const { OpenAiCompatibleLlmProvider } = await import('./openai-compatible-provider.js');
    expect(createLlmProvider()).toBeInstanceOf(OpenAiCompatibleLlmProvider);
  });

  it('returns an OpenAI-compatible provider for ollama', async () => {
    const { createLlmProvider } = await loadFactory({ LLM_PROVIDER: 'ollama', LLM_API_KEY: 'k' });
    const { OpenAiCompatibleLlmProvider } = await import('./openai-compatible-provider.js');
    expect(createLlmProvider()).toBeInstanceOf(OpenAiCompatibleLlmProvider);
  });
});

describe('createIntentLlmProvider', () => {
  it('uses its own INTENT_LLM_* creds when set', async () => {
    const { createIntentLlmProvider } = await loadFactory({
      INTENT_LLM_PROVIDER: 'openai',
      INTENT_LLM_API_KEY: 'k',
    });
    expect(createIntentLlmProvider().name).toBe('openai');
  });

  it('falls back to LLM_PROVIDER when INTENT_LLM_PROVIDER is unset', async () => {
    delete process.env.INTENT_LLM_PROVIDER;
    const { createIntentLlmProvider } = await loadFactory({ LLM_PROVIDER: 'stub' });
    expect(createIntentLlmProvider().name).toBe('stub');
  });
});

describe('StubLlmProvider', () => {
  it('returns a valid empty proposal and warns that the stub is in use', async () => {
    const { createLlmProvider } = await loadFactory({ LLM_PROVIDER: 'stub' });
    const { logger } = await import('../config/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn');

    const out = await createLlmProvider().complete({ system: 's', user: 'u' });

    expect(JSON.parse(out)).toEqual({
      operations: [],
      needs_clarification: false,
      clarification_question: null,
    });
    expect(warnSpy).toHaveBeenCalledWith('llm.stub_provider_in_use');
    warnSpy.mockRestore();
  });
});
