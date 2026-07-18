import OpenAI from 'openai';
import type {
  AgentMessage,
  ChatResult,
  LlmPrompt,
  LlmProvider,
  ToolCall,
  ToolSpec,
} from './llm-provider.js';
import { logger } from '../config/logger.js';
import { LIMITS } from '../config/constants.js';
import { messageOf } from '../shared/errors.js';
import { cacheHitRate, type LlmUsage } from './usage.js';

/** Connection settings for one OpenAI-compatible endpoint. Each caller (the parser, the intent
 *  classifier) supplies its own so they can use separate providers/creds. */
export interface LlmClientConfig {
  readonly name: string; // provider label, e.g. 'openai' / 'ollama'
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
}

/**
 * LLM backed by any OpenAI-compatible chat endpoint — Ollama (default,
 * http://localhost:11434/v1), OpenAI, Groq, etc. Connection settings are injected via
 * {@link LlmClientConfig} so distinct callers (parser vs. intent classifier) can point at
 * different providers/creds. Using the OpenAI SDK keeps one client usable across providers
 * (design §8/§14).
 *
 * Forces `response_format: json_object` so the model returns the strict JSON the
 * parser expects; the SDK handles transient retries (429/5xx/network) internally.
 */
export class OpenAiCompatibleLlmProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;
  private readonly client: OpenAI;

  constructor(cfg: LlmClientConfig) {
    this.name = cfg.name;
    this.model = cfg.model;
    if (!cfg.apiKey) {
      // Ollama ignores the key but the SDK requires a non-empty string, so it's
      // mandatory for every provider (use any non-empty value for Ollama).
      throw new Error(`${cfg.name}: API key is required (use any non-empty value for Ollama)`);
    }
    this.client = new OpenAI({
      baseURL: cfg.baseUrl,
      apiKey: cfg.apiKey,
      timeout: cfg.timeoutMs,
      maxRetries: LIMITS.llmTransportMaxRetries,
    });
  }

  async complete(prompt: LlmPrompt): Promise<string> {
    const started = Date.now();
    let res;
    try {
      res = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
      });
    } catch (error) {
      this.logCallFailed('complete', Date.now() - started, error);
      throw error;
    }

    this.logUsage('complete', usageOf(res.usage), Date.now() - started);
    const content = res.choices[0]?.message?.content ?? '';
    if (!content) {
      logger.warn('llm.openai_compatible.empty_content', { provider: this.name, model: this.model });
    }
    return content;
  }

  /**
   * Tool-calling turn (docs/agent-tools.md §4). Maps our transport-independent {@link AgentMessage}
   * transcript and {@link ToolSpec} list onto the OpenAI `tools` API, and parses the response's
   * `tool_calls` back into {@link ToolCall}s (arguments JSON-decoded to objects). `temperature: 0`
   * for determinism; no `response_format` — tool mode governs the output shape.
   */
  async chat(messages: AgentMessage[], tools: ToolSpec[]): Promise<ChatResult> {
    const started = Date.now();
    let res;
    try {
      res = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        messages: messages.map(toOpenAiMessage),
        tools: tools.map((t) => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      });
    } catch (error) {
      this.logCallFailed('chat', Date.now() - started, error);
      throw error;
    }

    const usage = usageOf(res.usage);
    this.logUsage('chat', usage, Date.now() - started);
    const message = res.choices[0]?.message;
    const toolCalls = (message?.tool_calls ?? [])
      .filter((tc) => tc.type === 'function')
      .map((tc) => this.parseToolCall(tc));
    if (!message?.content && toolCalls.length === 0) {
      logger.warn('llm.openai_compatible.empty_chat', { provider: this.name, model: this.model });
    }
    return {
      ...(message?.content ? { text: message.content } : {}),
      toolCalls,
      ...(usage ? { usage } : {}),
    };
  }

  /** Emit one `llm.usage` line for a call. `elapsedMs` is the wall-clock time of the whole
   *  `create()` await, so it INCLUDES any SDK retry/backoff (429/5xx) — a call that looks trivial by
   *  token count but slow here was rate-limited or cold, not busy. Always logged (even when the
   *  provider omits its `usage` block) so latency is never lost; token/cache fields are OMITTED when
   *  absent (so absent stays distinct from a genuine 0% — see {@link LlmUsage}). */
  private logUsage(kind: 'complete' | 'chat', usage: LlmUsage | undefined, elapsedMs: number): void {
    const rate =
      usage?.cachedTokens !== undefined ? cacheHitRate(usage.promptTokens, usage.cachedTokens) : null;
    logger.info('llm.usage', {
      kind,
      provider: this.name,
      model: this.model,
      elapsed_ms: elapsedMs,
      ...(usage
        ? {
            prompt_tokens: usage.promptTokens,
            completion_tokens: usage.completionTokens,
            total_tokens: usage.totalTokens,
          }
        : {}),
      ...(usage?.cachedTokens !== undefined ? { cached_tokens: usage.cachedTokens } : {}),
      ...(rate !== null ? { cache_hit_rate: rate } : {}),
    });
  }

  /** Emit one `llm.call_failed` WARN line when `create()` throws after the SDK's retries are
   *  exhausted. `elapsedMs` (whole await, retries included) is the whole point — it makes a call
   *  that timed out or gave up after backoff show its cost, which the success-only `llm.usage` line
   *  can't. The error still propagates; this only records the timing before rethrow. */
  private logCallFailed(kind: 'complete' | 'chat', elapsedMs: number, error: unknown): void {
    logger.warn('llm.call_failed', {
      kind,
      provider: this.name,
      model: this.model,
      elapsed_ms: elapsedMs,
      reason: messageOf(error),
    });
  }

  /** Decode one OpenAI tool call. The API returns `arguments` as a JSON string; we parse it to an
   *  object here so callers validate a real value, not text. Malformed JSON surfaces `{}` (the tool
   *  handler's zod validation then rejects it as a normal tool error). */
  private parseToolCall(tc: OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall): ToolCall {
    let args: unknown = {};
    try {
      args = JSON.parse(tc.function.arguments || '{}');
    } catch {
      logger.warn('llm.openai_compatible.tool_args_parse_failed', {
        provider: this.name,
        model: this.model,
        tool: tc.function.name,
      });
    }
    // Keep the SDK's original tool call so it can be replayed verbatim (preserves provider-specific
    // fields like Gemini's thought_signature, which the follow-up request requires — see ToolCall.raw).
    return { id: tc.id, name: tc.function.name, arguments: args, raw: tc };
  }
}

/** Map the OpenAI SDK's `usage` block onto our transport-independent {@link LlmUsage}. Returns
 *  `undefined` when the response carried no usage at all (some compat endpoints omit it). Cache
 *  detail lives in `prompt_tokens_details.cached_tokens`, itself optional — the key is spread in
 *  ONLY when present so "no cache reporting" stays distinct from "0 cached". */
function usageOf(u: OpenAI.CompletionUsage | undefined): LlmUsage | undefined {
  if (!u) return undefined;
  // Cache detail lives in different places across OpenAI-compatible providers: OpenAI/Groq nest it
  // under `prompt_tokens_details.cached_tokens`; some endpoints report a flat `total_cached_tokens`
  // instead (not in the SDK's typed shape — read defensively). Prefer the standard nested field,
  // fall back to the flat one; both absent → cache reporting stays absent (distinct from 0).
  const flatRaw = (u as { total_cached_tokens?: unknown }).total_cached_tokens;
  const flatCached = typeof flatRaw === 'number' ? flatRaw : undefined;
  const cached = u.prompt_tokens_details?.cached_tokens ?? flatCached;
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
    totalTokens: u.total_tokens ?? 0,
    ...(cached !== undefined ? { cachedTokens: cached } : {}),
  };
}

/** Map our {@link AgentMessage} onto the OpenAI SDK's message shape (assistant tool_calls are
 *  re-serialized: arguments back to a JSON string, wrapped in the `function` envelope). */
function toOpenAiMessage(
  m: AgentMessage,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  switch (m.role) {
    case 'system':
      return { role: 'system', content: m.content };
    case 'user':
      return { role: 'user', content: m.content };
    case 'tool':
      return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
    case 'assistant':
      // Omit `content` when the turn was tool-calls-only (a null content alongside tool_calls is
      // rejected by some OpenAI-compatible endpoints). Replay each tool call from its opaque `raw`
      // payload when present — rebuilding it from id/name/arguments drops provider fields (e.g.
      // Gemini's thought_signature) that the follow-up request requires (see ToolCall.raw).
      return {
        role: 'assistant',
        ...(m.content !== undefined && m.content !== null ? { content: m.content } : {}),
        ...(m.tool_calls && m.tool_calls.length > 0
          ? {
              tool_calls: m.tool_calls.map((tc) =>
                tc.raw !== undefined
                  ? (tc.raw as OpenAI.Chat.Completions.ChatCompletionMessageToolCall)
                  : {
                      id: tc.id,
                      type: 'function' as const,
                      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                    },
              ),
            }
          : {}),
      };
  }
}
