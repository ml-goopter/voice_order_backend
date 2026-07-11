import OpenAI from 'openai';
import type { LlmPrompt, LlmProvider } from './llm-provider.js';
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
}
