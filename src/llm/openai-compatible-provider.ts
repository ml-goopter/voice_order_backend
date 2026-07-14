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
  private readonly client: OpenAI;
  private readonly model: string;

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
    const res = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
    });

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
    const res = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      messages: messages.map(toOpenAiMessage),
      tools: tools.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
    });

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
    };
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
