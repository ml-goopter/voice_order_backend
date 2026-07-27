import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RateLimiter } from '../ratelimit/rate-limiter.js';

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
// Aliased: `RateLimiter` is already bound above as a type-only import.
const { RateLimiter: Limiter, RateLimitTimeoutError } = await import('../ratelimit/rate-limiter.js');
type TokenBucket = import('../ratelimit/token-bucket.js').TokenBucket;

const CFG = {
  name: 'openai',
  model: 'test-model',
  baseUrl: 'https://example.test/v1',
  apiKey: 'test-key',
  timeoutMs: 12345,
};
const PROMPT = { system: 'SYS', user: 'USR' };

describe('OpenAiCompatibleLlmProvider', () => {
  beforeEach(() => {
    createMock.mockReset();
    ctorMock.mockClear();
    createMock.mockResolvedValue({ choices: [{ message: { content: '{"ok":true}' } }] });
  });

  it('constructs the OpenAI client with base URL, key, timeout, and max retries', () => {
    new OpenAiCompatibleLlmProvider(CFG);
    expect(ctorMock).toHaveBeenCalledWith({
      baseURL: 'https://example.test/v1',
      apiKey: 'test-key',
      timeout: 12345,
      maxRetries: LIMITS.llmTransportMaxRetries,
    });
  });

  it('exposes name from the injected config', () => {
    expect(new OpenAiCompatibleLlmProvider(CFG).name).toBe('openai');
  });

  it('sends model, temperature 0, json_object, and system/user messages', async () => {
    const out = await new OpenAiCompatibleLlmProvider(CFG).complete(PROMPT);
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
    const out = await new OpenAiCompatibleLlmProvider(CFG).complete(PROMPT);
    expect(out).toBe('');
    expect(warnSpy).toHaveBeenCalledWith('llm.openai_compatible.empty_content', {
      provider: 'openai',
      model: 'test-model',
    });
    warnSpy.mockRestore();
  });

  it('returns empty string when choices are missing (no throw)', async () => {
    createMock.mockResolvedValue({ choices: [] });
    expect(await new OpenAiCompatibleLlmProvider(CFG).complete(PROMPT)).toBe('');
  });

  it('propagates a rejection from the SDK', async () => {
    createMock.mockRejectedValue(new Error('429 rate limited'));
    await expect(new OpenAiCompatibleLlmProvider(CFG).complete(PROMPT)).rejects.toThrow(
      '429 rate limited',
    );
  });

  it('throws when the API key is missing', () => {
    expect(() => new OpenAiCompatibleLlmProvider({ ...CFG, apiKey: '' })).toThrow(
      /API key is required/,
    );
  });

  it('exposes model from the injected config', () => {
    expect(new OpenAiCompatibleLlmProvider(CFG).model).toBe('test-model');
  });

  describe('rate limiting', () => {
    // The parser and the intent classifier share ONE limiter whenever their creds match (the
    // INTENT_LLM_* fallbacks), so the wait budget must ride each acquire — otherwise one of the
    // two operator-set *_RATE_LIMIT_WAIT_MS values is silently lost.
    function fakeLimiter(): { limiter: RateLimiter; acquire: ReturnType<typeof vi.fn> } {
      const acquire = vi.fn().mockResolvedValue({ settle: vi.fn(), abandon: vi.fn(), waitedMs: 0 });
      return { limiter: { acquire, nowMs: () => 0, penalize: vi.fn() } as unknown as RateLimiter, acquire };
    }

    it('passes its own wait budget to acquire on complete', async () => {
      const { limiter, acquire } = fakeLimiter();
      await new OpenAiCompatibleLlmProvider({ ...CFG, rateLimitWaitMs: 1_500 }, limiter).complete(PROMPT);
      expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ deadlineMs: 1_500 }));
    });

    it('passes its own wait budget to acquire on chat', async () => {
      const { limiter, acquire } = fakeLimiter();
      await new OpenAiCompatibleLlmProvider({ ...CFG, rateLimitWaitMs: 400 }, limiter).chat(
        [{ role: 'user', content: 'hi' }],
        [],
      );
      expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ deadlineMs: 400 }));
    });

    // The TPM reservation is only observable through the private bucket, so these reach in rather
    // than widening the limiter's surface. A frozen clock keeps refill out of the arithmetic.
    const tpmOf = (l: RateLimiter): TokenBucket => (l as unknown as { tpm: TokenBucket }).tpm;
    const frozen = (tpm: number) => new Limiter('llm', { tpm }, () => 0);

    // The system/user prompt is 'SYS'/'USR': 3 envelope + ceil(3/4) content tokens each.
    const PROMPT_ESTIMATE = 8;

    it('reserves the estimate BEFORE create(), then settles with the reported total_tokens', async () => {
      createMock.mockResolvedValue({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      const settle = vi.fn();
      let createCallsWhenReserved = -1;
      const acquire = vi.fn().mockImplementation(() => {
        createCallsWhenReserved = createMock.mock.calls.length;
        return Promise.resolve({ settle, abandon: vi.fn(), waitedMs: 0 });
      });
      const limiter = { acquire, nowMs: () => 0, penalize: vi.fn() } as unknown as RateLimiter;

      await new OpenAiCompatibleLlmProvider(CFG, limiter).complete(PROMPT);

      // Reserving after the call would let a whole minute's traffic through before the first
      // request was ever accounted for.
      expect(createCallsWhenReserved).toBe(0);
      expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ cost: PROMPT_ESTIMATE }));
      expect(settle).toHaveBeenCalledWith(15);
    });

    it('reserves the input estimate PLUS the assumed output, not the larger of the two', async () => {
      // A completion's charge is prompt + completion; they are summed, never alternatives. With
      // `max(...)` a prompt-dominated call (every agent step here is ~4.3k prompt tokens) reserves
      // nothing at all for its reply, and the whole output is unaccounted for until the response
      // lands — which is precisely the window in which a concurrent call trips the 429.
      createMock.mockResolvedValue({ choices: [{ message: { content: '{"ok":true}' } }] });
      const acquire = vi.fn().mockResolvedValue({ settle: vi.fn(), abandon: vi.fn(), waitedMs: 0 });
      const limiter = { acquire, nowMs: () => 0, penalize: vi.fn() } as unknown as RateLimiter;

      await new OpenAiCompatibleLlmProvider({ ...CFG, maxOutputTokensEst: 800 }, limiter).complete(PROMPT);

      expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ cost: PROMPT_ESTIMATE + 800 }));
    });

    it('does NOT refund an over-estimate (the reservation basis never shrinks)', async () => {
      // Providers assess the estimate before generation and issue no refund when the response
      // comes in short; a limiter that refunded locally would be more permissive than the provider
      // it protects and would manufacture the 429s it exists to prevent.
      createMock.mockResolvedValue({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      const limiter = frozen(100_000);
      await new OpenAiCompatibleLlmProvider({ ...CFG, maxOutputTokensEst: 800 }, limiter).complete(PROMPT);

      expect(tpmOf(limiter).available).toBe(100_000 - (PROMPT_ESTIMATE + 800));
    });

    it('force-takes the delta when the call cost more than the estimate', async () => {
      createMock.mockResolvedValue({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 4_000, completion_tokens: 1_000, total_tokens: 5_000 },
      });
      const limiter = frozen(100_000);
      await new OpenAiCompatibleLlmProvider({ ...CFG, maxOutputTokensEst: 800 }, limiter).complete(PROMPT);

      // 808 reserved + 4_192 reconciled: the overshoot is charged, never absorbed.
      expect(tpmOf(limiter).available).toBe(100_000 - 5_000);
    });

    it('keeps the charge for a post-send timeout, still logging llm.call_failed', async () => {
      // The SDK raises APIConnectionTimeoutError once the request deadline expires, which for a
      // multi-second budget is almost always AFTER the body went out — the provider read it and
      // billed it. Refunding it because it "failed" shapes against calls that really happened.
      createMock.mockRejectedValue(Object.assign(new Error('deadline exceeded'), { name: 'APIConnectionTimeoutError' }));
      const limiter = frozen(100_000);
      const penalizeSpy = vi.spyOn(limiter, 'penalize');
      const warnSpy = vi.spyOn(logger, 'warn');

      await expect(
        new OpenAiCompatibleLlmProvider({ ...CFG, maxOutputTokensEst: 800 }, limiter).complete(PROMPT),
      ).rejects.toThrow('deadline exceeded');

      expect(tpmOf(limiter).available).toBe(100_000 - (PROMPT_ESTIMATE + 800));
      expect(penalizeSpy).not.toHaveBeenCalled(); // a timeout says nothing about quota
      expect(warnSpy).toHaveBeenCalledWith('llm.call_failed', {
        kind: 'complete',
        provider: 'openai',
        model: 'test-model',
        elapsed_ms: expect.any(Number),
        reason: 'deadline exceeded',
      });
      warnSpy.mockRestore();
    });

    it('refunds a connection that was never established', async () => {
      createMock.mockRejectedValue(
        Object.assign(new Error('Connection error.'), {
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        }),
      );
      const limiter = frozen(100_000);

      await expect(
        new OpenAiCompatibleLlmProvider({ ...CFG, maxOutputTokensEst: 800 }, limiter).complete(PROMPT),
      ).rejects.toThrow('Connection error.');

      expect(tpmOf(limiter).available).toBe(100_000);
    });

    it('penalizes with the parsed Retry-After on a 429 and SETTLES the lease', async () => {
      createMock.mockRejectedValue(
        Object.assign(new Error('rate limited'), { status: 429, headers: { 'retry-after': '3' } }),
      );
      const abandon = vi.fn();
      const settle = vi.fn();
      const penalize = vi.fn();
      const limiter = {
        acquire: vi.fn().mockResolvedValue({ settle, abandon, waitedMs: 0 }),
        nowMs: () => 1_000,
        penalize,
      } as unknown as RateLimiter;

      await expect(new OpenAiCompatibleLlmProvider(CFG, limiter).complete(PROMPT)).rejects.toThrow(
        'rate limited',
      );

      expect(penalize).toHaveBeenCalledWith(1_000 + 3_000, 'llm_429');
      // A 429 is a request the provider RECEIVED and counted, so the reservation is not refunded.
      expect(settle).toHaveBeenCalledTimes(1);
      expect(abandon).not.toHaveBeenCalled();
    });

    it('leaves the RPM token and the TPM reservation spent after a 429', async () => {
      // Observed on a real limiter rather than a spy: a refund here would make this limiter more
      // permissive than the quota it protects, exactly while that quota is saying stop.
      createMock.mockRejectedValue(Object.assign(new Error('rate limited'), { status: 429 }));
      const limiter = new Limiter('llm', { rpm: 60, tpm: 100_000 }, () => 0);
      const rpmOf = (l: RateLimiter): TokenBucket => (l as unknown as { rpm: TokenBucket }).rpm;

      await expect(
        new OpenAiCompatibleLlmProvider({ ...CFG, maxOutputTokensEst: 800 }, limiter).complete(PROMPT),
      ).rejects.toThrow('rate limited');

      expect(rpmOf(limiter).available).toBe(59);
      expect(tpmOf(limiter).available).toBe(100_000 - (PROMPT_ESTIMATE + 800));
    });

    it('never calls create() when the limiter rejects, and logs no llm.usage for a call that never happened', async () => {
      const limiter = {
        acquire: vi.fn().mockRejectedValue(new RateLimitTimeoutError('deadline', 'llm: timed out')),
        nowMs: () => 0,
        penalize: vi.fn(),
      } as unknown as RateLimiter;
      const infoSpy = vi.spyOn(logger, 'info');

      await expect(new OpenAiCompatibleLlmProvider(CFG, limiter).complete(PROMPT)).rejects.toBeInstanceOf(
        RateLimitTimeoutError,
      );

      expect(createMock).not.toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalledWith('llm.usage', expect.anything());
      infoSpy.mockRestore();
    });

    it('carries rate_limit_wait_ms and estimated_tokens on llm.usage', async () => {
      createMock.mockResolvedValue({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
      });
      const limiter = {
        acquire: vi.fn().mockResolvedValue({ settle: vi.fn(), abandon: vi.fn(), waitedMs: 250 }),
        nowMs: () => 0,
        penalize: vi.fn(),
      } as unknown as RateLimiter;
      const infoSpy = vi.spyOn(logger, 'info');

      await new OpenAiCompatibleLlmProvider(CFG, limiter).complete(PROMPT);

      // Reconciliation rides the existing line: estimated_tokens is directly queryable against
      // total_tokens on the same row.
      expect(infoSpy).toHaveBeenCalledWith('llm.usage', {
        kind: 'complete',
        provider: 'openai',
        model: 'test-model',
        elapsed_ms: expect.any(Number),
        rate_limit_wait_ms: 250,
        estimated_tokens: PROMPT_ESTIMATE,
        prompt_tokens: 30,
        completion_tokens: 5,
        total_tokens: 35,
      });
      infoSpy.mockRestore();
    });
  });

  describe('usage logging', () => {
    it('logs llm.usage with token counts and cache_hit_rate from prompt_tokens_details', async () => {
      createMock.mockResolvedValue({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 20,
          total_tokens: 1020,
          prompt_tokens_details: { cached_tokens: 875 },
        },
      });
      const infoSpy = vi.spyOn(logger, 'info');
      await new OpenAiCompatibleLlmProvider(CFG).complete(PROMPT);
      expect(infoSpy).toHaveBeenCalledWith('llm.usage', {
        kind: 'complete',
        provider: 'openai',
        model: 'test-model',
        elapsed_ms: expect.any(Number),
        prompt_tokens: 1000,
        completion_tokens: 20,
        total_tokens: 1020,
        cached_tokens: 875,
        cache_hit_rate: 0.875,
      });
      infoSpy.mockRestore();
    });

    it('omits cache fields when the provider reports no prompt_tokens_details (Ollama-style)', async () => {
      createMock.mockResolvedValue({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
      });
      const infoSpy = vi.spyOn(logger, 'info');
      await new OpenAiCompatibleLlmProvider(CFG).complete(PROMPT);
      expect(infoSpy).toHaveBeenCalledWith('llm.usage', {
        kind: 'complete',
        provider: 'openai',
        model: 'test-model',
        elapsed_ms: expect.any(Number),
        prompt_tokens: 30,
        completion_tokens: 5,
        total_tokens: 35,
      });
      infoSpy.mockRestore();
    });

    it('reads cache from a flat total_cached_tokens when prompt_tokens_details is absent', async () => {
      createMock.mockResolvedValue({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 1000, completion_tokens: 8, total_tokens: 1008, total_cached_tokens: 600 },
      });
      const infoSpy = vi.spyOn(logger, 'info');
      await new OpenAiCompatibleLlmProvider(CFG).complete(PROMPT);
      expect(infoSpy).toHaveBeenCalledWith('llm.usage', {
        kind: 'complete',
        provider: 'openai',
        model: 'test-model',
        elapsed_ms: expect.any(Number),
        prompt_tokens: 1000,
        completion_tokens: 8,
        total_tokens: 1008,
        cached_tokens: 600,
        cache_hit_rate: 0.6,
      });
      infoSpy.mockRestore();
    });

    it('prefers nested prompt_tokens_details.cached_tokens over a flat total_cached_tokens', async () => {
      createMock.mockResolvedValue({
        choices: [{ message: { content: 'done' } }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 8,
          total_tokens: 1008,
          prompt_tokens_details: { cached_tokens: 250 },
          total_cached_tokens: 600,
        },
      });
      const out = await new OpenAiCompatibleLlmProvider(CFG).chat([{ role: 'user', content: 'hi' }], []);
      expect(out.usage?.cachedTokens).toBe(250);
    });

    it('still logs llm.usage latency when the response carries no usage block, omitting token fields', async () => {
      createMock.mockResolvedValue({ choices: [{ message: { content: '{"ok":true}' } }] });
      const infoSpy = vi.spyOn(logger, 'info');
      await new OpenAiCompatibleLlmProvider(CFG).complete(PROMPT);
      expect(infoSpy).toHaveBeenCalledWith('llm.usage', {
        kind: 'complete',
        provider: 'openai',
        model: 'test-model',
        elapsed_ms: expect.any(Number),
      });
      infoSpy.mockRestore();
    });
  });

  describe('failure logging', () => {
    it('logs llm.call_failed with elapsed_ms and reason, then rethrows, when complete() throws', async () => {
      createMock.mockRejectedValue(new Error('429 rate limit exceeded'));
      const warnSpy = vi.spyOn(logger, 'warn');
      await expect(new OpenAiCompatibleLlmProvider(CFG).complete(PROMPT)).rejects.toThrow(
        '429 rate limit exceeded',
      );
      expect(warnSpy).toHaveBeenCalledWith('llm.call_failed', {
        kind: 'complete',
        provider: 'openai',
        model: 'test-model',
        elapsed_ms: expect.any(Number),
        reason: '429 rate limit exceeded',
      });
      warnSpy.mockRestore();
    });

    it('logs llm.call_failed with kind "chat" and rethrows when chat() throws', async () => {
      createMock.mockRejectedValue(new Error('deadline exceeded'));
      const warnSpy = vi.spyOn(logger, 'warn');
      await expect(
        new OpenAiCompatibleLlmProvider(CFG).chat([{ role: 'user', content: 'hi' }], []),
      ).rejects.toThrow('deadline exceeded');
      expect(warnSpy).toHaveBeenCalledWith('llm.call_failed', {
        kind: 'chat',
        provider: 'openai',
        model: 'test-model',
        elapsed_ms: expect.any(Number),
        reason: 'deadline exceeded',
      });
      warnSpy.mockRestore();
    });
  });

  describe('chat', () => {
    const TOOLS = [
      { name: 'search_menu_semantic', description: 'search', parameters: { type: 'object' } },
    ];

    it('sends model, temperature 0, mapped messages, and tool specs', async () => {
      createMock.mockResolvedValue({ choices: [{ message: { content: null, tool_calls: [] } }] });
      await new OpenAiCompatibleLlmProvider(CFG).chat(
        [
          { role: 'system', content: 'SYS' },
          { role: 'user', content: 'a burger' },
          { role: 'assistant', tool_calls: [{ id: 'c1', name: 'search_menu_semantic', arguments: { q: 'burger' } }] },
          { role: 'tool', tool_call_id: 'c1', content: '[{"name":"Burger"}]' },
        ],
        TOOLS,
      );
      expect(createMock).toHaveBeenCalledWith({
        model: 'test-model',
        temperature: 0,
        messages: [
          { role: 'system', content: 'SYS' },
          { role: 'user', content: 'a burger' },
          {
            role: 'assistant',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'search_menu_semantic', arguments: '{"q":"burger"}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'c1', content: '[{"name":"Burger"}]' },
        ],
        tools: [
          { type: 'function', function: { name: 'search_menu_semantic', description: 'search', parameters: { type: 'object' } } },
        ],
      });
    });

    it('parses tool_calls with JSON-decoded arguments', async () => {
      createMock.mockResolvedValue({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: 'x1', type: 'function', function: { name: 'search_menu_semantic', arguments: '{"query":"fries"}' } },
              ],
            },
          },
        ],
      });
      const out = await new OpenAiCompatibleLlmProvider(CFG).chat([{ role: 'user', content: 'fries' }], TOOLS);
      expect(out).toEqual({
        toolCalls: [
          {
            id: 'x1',
            name: 'search_menu_semantic',
            arguments: { query: 'fries' },
            raw: { id: 'x1', type: 'function', function: { name: 'search_menu_semantic', arguments: '{"query":"fries"}' } },
          },
        ],
      });
    });

    it('preserves the raw tool call and replays it verbatim (keeps provider fields like a thought_signature)', async () => {
      const rawToolCall = {
        id: 'g1',
        type: 'function',
        function: { name: 'search_menu_semantic', arguments: '{"query":"coke"}' },
        extra_content: { google: { thought_signature: 'SIG123' } },
      };
      createMock.mockResolvedValue({ choices: [{ message: { content: null, tool_calls: [rawToolCall] } }] });

      // First turn: the provider parses the call and stashes the raw payload.
      const first = await new OpenAiCompatibleLlmProvider(CFG).chat([{ role: 'user', content: 'a coke' }], TOOLS);
      expect(first.toolCalls[0]?.raw).toEqual(rawToolCall);

      // Second turn: replaying that assistant message must send the tool call back UNCHANGED,
      // signature and all — not a rebuilt {id,type,function} that would drop extra_content.
      createMock.mockResolvedValue({ choices: [{ message: { content: 'done' } }] });
      await new OpenAiCompatibleLlmProvider(CFG).chat(
        [
          { role: 'user', content: 'a coke' },
          { role: 'assistant', tool_calls: first.toolCalls },
          { role: 'tool', tool_call_id: 'g1', content: '[{"name":"Coke"}]' },
        ],
        TOOLS,
      );
      const sent = createMock.mock.calls.at(-1)![0].messages[1];
      expect(sent).toEqual({ role: 'assistant', tool_calls: [rawToolCall] });
    });

    it('returns assistant text when the model replies with prose', async () => {
      createMock.mockResolvedValue({ choices: [{ message: { content: 'anything else?' } }] });
      const out = await new OpenAiCompatibleLlmProvider(CFG).chat([{ role: 'user', content: 'hi' }], TOOLS);
      expect(out).toEqual({ text: 'anything else?', toolCalls: [] });
    });

    it('attaches mapped usage to the ChatResult when the response reports it', async () => {
      createMock.mockResolvedValue({
        choices: [{ message: { content: 'done' } }],
        usage: {
          prompt_tokens: 500,
          completion_tokens: 12,
          total_tokens: 512,
          prompt_tokens_details: { cached_tokens: 450 },
        },
      });
      const out = await new OpenAiCompatibleLlmProvider(CFG).chat([{ role: 'user', content: 'hi' }], TOOLS);
      expect(out.usage).toEqual({ promptTokens: 500, completionTokens: 12, totalTokens: 512, cachedTokens: 450 });
    });

    it('omits usage from the ChatResult when the response carries none', async () => {
      createMock.mockResolvedValue({ choices: [{ message: { content: 'done' } }] });
      const out = await new OpenAiCompatibleLlmProvider(CFG).chat([{ role: 'user', content: 'hi' }], TOOLS);
      expect(out.usage).toBeUndefined();
    });

    it('warns and returns empty when there is neither text nor tool calls', async () => {
      createMock.mockResolvedValue({ choices: [{ message: { content: '' } }] });
      const warnSpy = vi.spyOn(logger, 'warn');
      const out = await new OpenAiCompatibleLlmProvider(CFG).chat([{ role: 'user', content: 'hi' }], TOOLS);
      expect(out).toEqual({ toolCalls: [] });
      expect(warnSpy).toHaveBeenCalledWith('llm.openai_compatible.empty_chat', {
        provider: 'openai',
        model: 'test-model',
      });
      warnSpy.mockRestore();
    });

    it('degrades malformed tool arguments to {} instead of throwing', async () => {
      createMock.mockResolvedValue({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: 'b1', type: 'function', function: { name: 'search_menu_semantic', arguments: '{bad' } }],
            },
          },
        ],
      });
      const out = await new OpenAiCompatibleLlmProvider(CFG).chat([{ role: 'user', content: 'x' }], TOOLS);
      expect(out).toEqual({
        toolCalls: [
          {
            id: 'b1',
            name: 'search_menu_semantic',
            arguments: {},
            raw: { id: 'b1', type: 'function', function: { name: 'search_menu_semantic', arguments: '{bad' } },
          },
        ],
      });
    });
  });
});
