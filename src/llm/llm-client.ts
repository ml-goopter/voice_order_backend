import type {
  AgentMessage,
  ChatResult,
  LlmPrompt,
  LlmProvider,
  ToolSpec,
} from './llm-provider.js';
import { OpenAiCompatibleLlmProvider } from './openai-compatible-provider.js';
import type { LlmClientConfig } from './openai-compatible-provider.js';
import { rateLimiters } from '../ratelimit/registry.js';
import type { RateLimiter } from '../ratelimit/rate-limiter.js';
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

/** Quota namespace shared by BOTH LLM adapters. Constant, not `config.llmProvider`: the parser and
 *  the classifier must still collapse onto one limiter when they point at the same endpoint, key
 *  and model, which is the default. It exists only to keep an LLM quota from colliding with an
 *  STT/TTS/embedding one that happens to carry the same api key string. */
const LLM_QUOTA_PROVIDER = 'openai-compatible';

/** Build a provider for one cred set (mirrors createEmbeddingService). Non-cloud providers fall
 *  through to the stub — for the classifier the stub's non-intent JSON degrades to `order`. */
function selectProvider(provider: string, cfg: LlmClientConfig, limiter: RateLimiter): LlmProvider {
  switch (provider) {
    // Ollama, OpenAI, Groq, etc. all speak the OpenAI chat API — one client, env-driven.
    case 'ollama':
    case 'openai':
      return new OpenAiCompatibleLlmProvider(cfg, limiter);
    default:
      return new StubLlmProvider();
  }
}

/** The main proposer/parser LLM (LLM_* env). */
export function createLlmProvider(): LlmProvider {
  const cfg: LlmClientConfig = {
    name: config.llmProvider,
    model: config.llmModel,
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    timeoutMs: config.llmTimeoutMs,
    maxOutputTokensEst: config.llmMaxOutputTokensEst,
    rateLimitWaitMs: config.llmRateLimitWaitMs,
  };
  // Keyed on quota identity, not on the adapter: the provider meters per account/model/endpoint,
  // and the INTENT_LLM_* fallbacks make the two adapters the SAME pool by default. The wait budget
  // is deliberately NOT part of that identity — it rides each acquire (see LlmClientConfig).
  return selectProvider(
    config.llmProvider,
    cfg,
    rateLimiters.get(
      { name: 'llm', provider: LLM_QUOTA_PROVIDER, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model },
      { rpm: config.llmRpm, tpm: config.llmTpm, maxConcurrent: config.llmMaxConcurrent },
    ),
  );
}

/** The intent classifier's own LLM (INTENT_LLM_* env, falling back to LLM_*), so the cheap
 *  first-hop call can use separate creds/model from the parser (design §6). */
export function createIntentLlmProvider(): LlmProvider {
  const cfg: LlmClientConfig = {
    name: config.intentLlmProvider,
    model: config.intentLlmModel,
    baseUrl: config.intentLlmBaseUrl,
    apiKey: config.intentLlmApiKey,
    timeoutMs: config.intentLlmTimeoutMs,
    // The classifier's own estimate, not the parser's: its entire output is `{"intent":"service"}`.
    // Reserving the agent's 800-token reply budget for it over-books a bucket the two adapters
    // share by default (see AppConfig.intentLlmMaxOutputTokensEst).
    maxOutputTokensEst: config.intentLlmMaxOutputTokensEst,
    rateLimitWaitMs: config.intentLlmRateLimitWaitMs,
  };
  return selectProvider(
    config.intentLlmProvider,
    cfg,
    rateLimiters.get(
      { name: 'intent-llm', provider: LLM_QUOTA_PROVIDER, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model },
      { rpm: config.intentLlmRpm, tpm: config.intentLlmTpm, maxConcurrent: config.intentLlmMaxConcurrent },
    ),
  );
}
