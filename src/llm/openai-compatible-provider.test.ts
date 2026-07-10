import { describe, it, expect, vi, beforeEach } from 'vitest';

// The provider binds config at import time; set env before importing it.
process.env.LLM_PROVIDER = 'openai';
process.env.LLM_MODEL = 'test-model';
process.env.LLM_BASE_URL = 'https://example.test/v1';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_TIMEOUT_MS = '12345';

// Records constructor opts and lets each test drive chat.completions.create.
const createMock = vi.fn();
const ctorMock = vi.fn();

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } };
    constructor(opts: unknown) {
      ctorMock(opts);
    }
  },
}));

const { OpenAiCompatibleLlmProvider } = await import('./openai-compatible-provider.js');
const { LIMITS } = await import('../config/constants.js');
const { logger } = await import('../config/logger.js');

const PROMPT = { system: 'SYS', user: 'USR' };

describe('OpenAiCompatibleLlmProvider', () => {
  beforeEach(() => {
    createMock.mockReset();
    ctorMock.mockClear();
    createMock.mockResolvedValue({ choices: [{ message: { content: '{"ok":true}' } }] });
  });

  it('constructs the OpenAI client with base URL, key, timeout, and max retries', () => {
    new OpenAiCompatibleLlmProvider();
    expect(ctorMock).toHaveBeenCalledWith({
      baseURL: 'https://example.test/v1',
      apiKey: 'test-key',
      timeout: 12345,
      maxRetries: LIMITS.llmTransportMaxRetries,
    });
  });

  it('exposes name from config.llmProvider', () => {
    expect(new OpenAiCompatibleLlmProvider().name).toBe('openai');
  });

  it('sends model, temperature 0, json_object, and system/user messages', async () => {
    const out = await new OpenAiCompatibleLlmProvider().complete(PROMPT);
    expect(out).toBe('{"ok":true}');
    expect(createMock).toHaveBeenCalledWith({
      model: 'test-model',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'USR' },
      ],
    });
  });

  it('warns and returns empty string when the content is empty', async () => {
    createMock.mockResolvedValue({ choices: [{ message: { content: '' } }] });
    const warnSpy = vi.spyOn(logger, 'warn');
    const out = await new OpenAiCompatibleLlmProvider().complete(PROMPT);
    expect(out).toBe('');
    expect(warnSpy).toHaveBeenCalledWith('llm.openai_compatible.empty_content', {
      provider: 'openai',
      model: 'test-model',
    });
    warnSpy.mockRestore();
  });

  it('returns empty string when choices are missing (no throw)', async () => {
    createMock.mockResolvedValue({ choices: [] });
    expect(await new OpenAiCompatibleLlmProvider().complete(PROMPT)).toBe('');
  });

  it('propagates a rejection from the SDK', async () => {
    createMock.mockRejectedValue(new Error('429 rate limited'));
    await expect(new OpenAiCompatibleLlmProvider().complete(PROMPT)).rejects.toThrow(
      '429 rate limited',
    );
  });

  it('throws when LLM_API_KEY is missing', async () => {
    vi.resetModules();
    delete process.env.LLM_API_KEY;
    const mod = await import('./openai-compatible-provider.js');
    expect(() => new mod.OpenAiCompatibleLlmProvider()).toThrow(/LLM_API_KEY is required/);
    process.env.LLM_API_KEY = 'test-key';
  });
});
