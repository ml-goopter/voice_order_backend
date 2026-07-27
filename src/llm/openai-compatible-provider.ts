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
import { LIMITS, RATE_LIMIT } from '../config/constants.js';
import { messageOf } from '../shared/errors.js';
import { estimateTokens } from '../ratelimit/estimate-tokens.js';
import { NO_LIMIT, type Lease, type RateLimiter } from '../ratelimit/rate-limiter.js';
import { reachedProvider } from '../ratelimit/arrival.js';
import { is429, retryAfterMs } from '../ratelimit/retry-after.js';
import { cacheHitRate, type LlmUsage } from './usage.js';

/** Connection settings for one OpenAI-compatible endpoint. Each caller (the parser, the intent
 *  classifier) supplies its own so they can use separate providers/creds. */
export interface LlmClientConfig {
  readonly name: string; // provider label, e.g. 'openai' / 'ollama'
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  /** Assumed output size for the TPM reservation, in tokens (`LLM_MAX_OUTPUT_TOKENS_EST`).
   *  Omitted/0 → the reservation is the input estimate alone. */
  readonly maxOutputTokensEst?: number;
  /** Wait budget for one rate-limited acquire (`LLM_RATE_LIMIT_WAIT_MS`). Per caller, not per
   *  limiter: the parser and the classifier share one quota by default but may want different
   *  latency budgets. */
  readonly rateLimitWaitMs?: number;
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
 *
 * Rate shaping is PROACTIVE only: the injected {@link RateLimiter} reserves capacity once per
 * LOGICAL call, outside the SDK's retry loop, so a retried request is never double-counted and the
 * SDK stays the sole reactive 429 handler. Unconfigured deployments get `NO_LIMIT` and pay nothing
 * — not even the token estimate.
 */
export class OpenAiCompatibleLlmProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;
  private readonly client: OpenAI;
  private readonly maxOutputTokensEst: number;
  private readonly waitMs: number;
  /** False for the shared passthrough: skip estimating and keep `llm.usage` byte-identical to
   *  what an unlimited deployment has always logged. */
  private readonly shaped: boolean;

  constructor(
    cfg: LlmClientConfig,
    private readonly limiter: RateLimiter = NO_LIMIT,
  ) {
    this.name = cfg.name;
    this.model = cfg.model;
    this.maxOutputTokensEst = cfg.maxOutputTokensEst ?? 0;
    this.waitMs = cfg.rateLimitWaitMs ?? RATE_LIMIT.defaultWaitMs;
    this.shaped = limiter !== NO_LIMIT;
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
    const estimate = this.reserve([
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ]);
    // Outside the try: a limiter rejection means the call never happened, so it is neither an
    // `llm.call_failed` nor an `llm.usage`. The limiter already logged `ratelimit.rejected`.
    const lease = await this.limiter.acquire({ cost: estimate, deadlineMs: this.waitMs });
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
      this.onCallFailed(error, lease);
      this.logCallFailed('complete', Date.now() - started, error);
      throw error;
    }

    const usage = usageOf(res.usage);
    lease.settle(usage?.totalTokens);
    this.logUsage('complete', usage, Date.now() - started, lease.waitedMs, estimate);
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
    const estimate = this.reserve(messages, tools);
    const lease = await this.limiter.acquire({ cost: estimate, deadlineMs: this.waitMs });
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
      this.onCallFailed(error, lease);
      this.logCallFailed('chat', Date.now() - started, error);
      throw error;
    }

    const usage = usageOf(res.usage);
    lease.settle(usage?.totalTokens);
    this.logUsage('chat', usage, Date.now() - started, lease.waitedMs, estimate);
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

  /**
   * TPM tokens to reserve for one call: `input estimate + maxOutputTokensEst`, reconciled UPWARDS
   * from `usage` afterwards. Returns 0 for an unshaped provider so an unconfigured deployment does
   * not even pay for the estimate.
   *
   * ADDITIVE, not `max(...)`. A completion's real charge is prompt + completion — the two are
   * summed, never alternatives — so `max` under-reserves by the whole output whenever the prompt
   * dominates, which is every agent step here (~4.3k prompt tokens against an 800-token reply).
   * Reconciliation does repair the arithmetic, but only once the response is back; every call that
   * started in the meantime was admitted against capacity that was already spoken for, and that
   * window is exactly when a 429 happens.
   *
   * `LLM_MAX_OUTPUT_TOKENS_EST` is a MODELLED ceiling, not a parameter we send: `max_tokens` is
   * deliberately left off the request (it defaults to 800 here, and silently truncating a reply
   * that ran long is a worse failure than over-reserving). Since the reservation basis never
   * shrinks, an oversized value burns local throughput on every call — set it near the expected
   * reply size.
   */
  private reserve(messages: readonly AgentMessage[], tools: readonly ToolSpec[] = []): number {
    if (!this.shaped) return 0;
    const input = estimateTokens(messages) + (tools.length > 0 ? estimateTokens(tools) : 0);
    return input + this.maxOutputTokensEst;
  }

  /**
   * Close out the reservation for a call that threw, and adapt to a 429.
   *
   * A terminal 429 is proof the local estimate was wrong: floor the next grant so the following
   * caller waits (and most likely degrades) instead of piling more rejected requests on a provider
   * that is already saying stop. Only a 429 penalizes — a 500 or a timeout says nothing about
   * capacity.
   *
   * Whether the lease is SETTLED or abandoned is a different question, and a broader one: the
   * charge stands for anything that reached the provider, because failed requests still count
   * against the quota. That covers a 429, but equally a 5xx and an `APIConnectionTimeoutError`
   * raised after the body went out. See {@link reachedProvider} for the rule and its asymmetry.
   */
  private onCallFailed(error: unknown, lease: Lease): void {
    if (is429(error)) {
      this.limiter.penalize(this.limiter.nowMs() + retryAfterMs(error), 'llm_429');
    }
    if (reachedProvider(error)) lease.settle();
    else lease.abandon();
  }

  /** Emit one `llm.usage` line for a call. `elapsedMs` is the wall-clock time of the whole
   *  `create()` await, so it INCLUDES any SDK retry/backoff (429/5xx) — a call that looks trivial by
   *  token count but slow here was rate-limited or cold, not busy. Always logged (even when the
   *  provider omits its `usage` block) so latency is never lost; token/cache fields are OMITTED when
   *  absent (so absent stays distinct from a genuine 0% — see {@link LlmUsage}). Reconciliation rides
   *  this line rather than a second one: `estimated_tokens` is directly queryable against
   *  `total_tokens` on the same row. Both limiter fields are omitted when nothing is configured. */
  private logUsage(
    kind: 'complete' | 'chat',
    usage: LlmUsage | undefined,
    elapsedMs: number,
    waitedMs: number,
    estimatedTokens: number,
  ): void {
    const rate =
      usage?.cachedTokens !== undefined ? cacheHitRate(usage.promptTokens, usage.cachedTokens) : null;
    logger.info('llm.usage', {
      kind,
      provider: this.name,
      model: this.model,
      elapsed_ms: elapsedMs,
      ...(this.shaped ? { rate_limit_wait_ms: waitedMs, estimated_tokens: estimatedTokens } : {}),
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
