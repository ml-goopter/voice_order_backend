import { describe, it, expect, vi, beforeEach } from 'vitest';

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
