import type { LlmPrompt, LlmProvider } from './llm-provider.js';
import { OpenAiCompatibleLlmProvider } from './openai-compatible-provider.js';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Placeholder LLM that returns a valid, empty proposal so the ordering pipeline
 * runs end-to-end without a provider key.
 */
class StubLlmProvider implements LlmProvider {
  readonly name = 'stub';

  async complete(_prompt: LlmPrompt): Promise<string> {
    logger.warn('llm.stub_provider_in_use');
    return JSON.stringify({ operations: [], needs_clarification: false, clarification_question: null });
  }
}

/** Single swap point: select the LLM provider by config (mirrors createEmbeddingService). */
export function createLlmProvider(): LlmProvider {
  switch (config.llmProvider) {
    // Ollama, OpenAI, Groq, etc. all speak the OpenAI chat API — one client, env-driven.
    case 'ollama':
    case 'openai':
      return new OpenAiCompatibleLlmProvider();
    default:
      return new StubLlmProvider();
  }
}
