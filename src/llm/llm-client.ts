import type { LlmPrompt, LlmProvider } from './llm-provider.js';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Placeholder LLM that returns a valid, empty proposal so the ordering pipeline
 * runs end-to-end without a provider key.
 * TODO: implement Groq/OpenAI/Gemini clients (design §8/§14) with retry + repair
 * prompt + schema-validated output (design §11.3).
 */
class StubLlmProvider implements LlmProvider {
  readonly name = 'stub';

  async complete(_prompt: LlmPrompt): Promise<string> {
    logger.warn('llm.stub_provider_in_use');
    return JSON.stringify({ operations: [], needs_clarification: false, clarification_question: null });
  }
}

export function createLlmProvider(): LlmProvider {
  switch (config.llmProvider) {
    // case 'groq':   return new GroqProvider();
    // case 'openai': return new OpenAiProvider();
    default:
      return new StubLlmProvider();
  }
}
