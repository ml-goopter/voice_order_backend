import OpenAI from 'openai';
import type { LlmPrompt, LlmProvider } from './llm-provider.js';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { LIMITS } from '../config/constants.js';

/**
 * LLM backed by any OpenAI-compatible chat endpoint — Ollama (default,
 * http://localhost:11434/v1), OpenAI, Groq, etc. The single swap point is env:
 * LLM_BASE_URL / LLM_API_KEY / LLM_MODEL. Using the OpenAI SDK keeps one client
 * usable across providers (design §8/§14).
 *
 * Forces `response_format: json_object` so the model returns the strict JSON the
 * parser expects; the SDK handles transient retries (429/5xx/network) internally.
 */
export class OpenAiCompatibleLlmProvider implements LlmProvider {
  readonly name = config.llmProvider;
  private readonly client: OpenAI;
  private readonly model = config.llmModel;

  constructor() {
    if (!config.llmApiKey) {
      // Ollama ignores the key but the SDK requires a non-empty string, so it's
      // mandatory for every provider (use any non-empty value for Ollama).
      throw new Error('LLM_API_KEY is required (use any non-empty value for Ollama)');
    }
    this.client = new OpenAI({
      baseURL: config.llmBaseUrl,
      apiKey: config.llmApiKey,
      timeout: config.llmTimeoutMs,
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
