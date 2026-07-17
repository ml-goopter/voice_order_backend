import type {
  AgentMessage,
  ChatResult,
  LlmPrompt,
  LlmProvider,
  ToolSpec,
} from './llm-provider.js';
import { OpenAiCompatibleLlmProvider } from './openai-compatible-provider.js';
import type { LlmClientConfig } from './openai-compatible-provider.js';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Placeholder LLM that returns a valid, empty proposal so the ordering pipeline
 * runs end-to-end without a provider key. `chat` replays an optional scripted
 * sequence of {@link ChatResult}s (one per call) so agent-loop tests stay
 * deterministic; with no script it returns no tool calls (a degenerate fallback —
 * production must run a tool-capable model, see docs/agent-tools.md §4).
 */
class StubLlmProvider implements LlmProvider {
  readonly name = 'stub';
  readonly model = 'stub';
  private chatCalls = 0;

  constructor(private readonly chatScript: ChatResult[] = []) {}

  async complete(_prompt: LlmPrompt): Promise<string> {
    logger.warn('llm.stub_provider_in_use');
    return JSON.stringify({ operations: [], needs_clarification: false, clarification_question: null });
  }

  async chat(_messages: AgentMessage[], _tools: ToolSpec[]): Promise<ChatResult> {
    logger.warn('llm.stub_provider_in_use');
    const scripted = this.chatScript[this.chatCalls++];
    return scripted ?? { toolCalls: [] };
  }
}

/** Build a provider for one cred set (mirrors createEmbeddingService). Non-cloud providers fall
 *  through to the stub — for the classifier the stub's non-intent JSON degrades to `order`. */
function selectProvider(provider: string, cfg: LlmClientConfig): LlmProvider {
  switch (provider) {
    // Ollama, OpenAI, Groq, etc. all speak the OpenAI chat API — one client, env-driven.
    case 'ollama':
    case 'openai':
      return new OpenAiCompatibleLlmProvider(cfg);
    default:
      return new StubLlmProvider();
  }
}

/** The main proposer/parser LLM (LLM_* env). */
export function createLlmProvider(): LlmProvider {
  return selectProvider(config.llmProvider, {
    name: config.llmProvider,
    model: config.llmModel,
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    timeoutMs: config.llmTimeoutMs,
  });
}

/** The intent classifier's own LLM (INTENT_LLM_* env, falling back to LLM_*), so the cheap
 *  first-hop call can use separate creds/model from the parser (design §6). */
export function createIntentLlmProvider(): LlmProvider {
  return selectProvider(config.intentLlmProvider, {
    name: config.intentLlmProvider,
    model: config.intentLlmModel,
    baseUrl: config.intentLlmBaseUrl,
    apiKey: config.intentLlmApiKey,
    timeoutMs: config.intentLlmTimeoutMs,
  });
}
