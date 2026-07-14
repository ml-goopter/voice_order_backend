/**
 * Environment configuration. Reads process.env with safe defaults so the scaffold
 * boots without a full .env. Replace/extend as real providers are wired in.
 */

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

export interface AppConfig {
  readonly nodeEnv: string;
  readonly port: number;
  readonly logLevel: string;

  readonly redisUrl: string;
  readonly odooDatabaseUrl: string; // Postgres (Odoo POS DB) that also holds our `item_vector` table
  readonly cartIdempotencyTtlSeconds: number; // TTL on the cart idempotency ledger (design §9)

  readonly sttProvider: string; // 'assemblyai' | ...
  readonly sttSampleRate: number; // Hz of the client PCM16 stream (design §5)
  readonly assemblyAiApiKey: string;
  readonly ttsProvider: string; // 'cartesia' | 'noop'
  readonly cartesiaApiKey: string;
  readonly ttsModel: string; // Cartesia Sonic model, e.g. 'sonic-3.5' (multilingual)
  readonly ttsVoiceId: string; // Cartesia voice UUID (a multi-locale voice speaks all languages)
  readonly ttsLanguage: string; // ISO-639-1 fallback language when the turn detected none (e.g. 'en')
  readonly ttsEncoding: string; // audio encoding streamed to the client ('mp3' default; 'linear16' etc.)
  readonly ttsSampleRate: number; // Hz of the emitted audio; mp3 container also requires it (Cartesia)
  readonly ttsBitRate: number; // mp3 bit rate for the Cartesia mp3 container (bps)
  readonly llmProvider: string; // 'stub' | 'ollama' | 'openai' | ...
  readonly llmModel: string;
  readonly llmBaseUrl: string; // OpenAI-compatible base URL (Ollama by default)
  readonly llmApiKey: string;
  readonly llmTimeoutMs: number; // per-request timeout; raise for slow local models
  // Intent classifier: its OWN provider/creds (design §6, the cheap first-hop call). Each
  // INTENT_LLM_* var falls back to the matching LLM_* so it's opt-in — leave them unset to
  // reuse the main provider, or point the classifier at a cheaper/separate model + key.
  readonly intentLlmProvider: string;
  readonly intentLlmModel: string;
  readonly intentLlmBaseUrl: string;
  readonly intentLlmApiKey: string;
  readonly intentLlmTimeoutMs: number;
  readonly embeddingProvider: string; // 'stub' | 'jina' | ...
  readonly embeddingModel: string;
  readonly embeddingDimensions: number;
  readonly jinaApiKey: string;
  readonly jinaBaseUrl: string;
}

export const config: AppConfig = {
  nodeEnv: str('NODE_ENV', 'development'),
  port: int('PORT', 3000),
  logLevel: str('LOG_LEVEL', 'info'),

  redisUrl: str('REDIS_URL', 'redis://localhost:6379'),
  odooDatabaseUrl: str('ODOO_DATABASE_URL', 'postgres://localhost:5432/odoo'),
  cartIdempotencyTtlSeconds: int('CART_IDEMPOTENCY_TTL_SECONDS', 86_400),

  sttProvider: str('STT_PROVIDER', 'assemblyai'),
  sttSampleRate: int('STT_SAMPLE_RATE', 16_000),
  assemblyAiApiKey: str('ASSEMBLYAI_API_KEY', ''),
  ttsProvider: str('TTS_PROVIDER', 'cartesia'),
  cartesiaApiKey: str('CARTESIA_API_KEY', ''),
  ttsModel: str('TTS_MODEL', 'sonic-3.5'),
  ttsVoiceId: str('TTS_VOICE_ID', '694f9389-aac1-45b6-b726-9d9369183238'),
  ttsLanguage: str('TTS_LANGUAGE', 'en'),
  ttsEncoding: str('TTS_ENCODING', 'mp3'),
  ttsSampleRate: int('TTS_SAMPLE_RATE', 24_000),
  ttsBitRate: int('TTS_BIT_RATE', 128_000),
  llmProvider: str('LLM_PROVIDER', 'stub'),
  llmModel: str('LLM_MODEL', 'llama3.1'),
  llmBaseUrl: str('LLM_BASE_URL', 'http://localhost:11434/v1'),
  llmApiKey: str('LLM_API_KEY', ''),
  llmTimeoutMs: int('LLM_TIMEOUT_MS', 30_000),
  // Each falls back to the matching LLM_* value so the classifier reuses the main provider
  // unless its own INTENT_LLM_* var is set.
  intentLlmProvider: str('INTENT_LLM_PROVIDER', str('LLM_PROVIDER', 'stub')),
  intentLlmModel: str('INTENT_LLM_MODEL', str('LLM_MODEL', 'llama3.1')),
  intentLlmBaseUrl: str('INTENT_LLM_BASE_URL', str('LLM_BASE_URL', 'http://localhost:11434/v1')),
  intentLlmApiKey: str('INTENT_LLM_API_KEY', str('LLM_API_KEY', '')),
  intentLlmTimeoutMs: int('INTENT_LLM_TIMEOUT_MS', int('LLM_TIMEOUT_MS', 30_000)),
  embeddingProvider: str('EMBEDDING_PROVIDER', 'stub'),
  embeddingModel: str('EMBEDDING_MODEL', 'jina-embeddings-v3'),
  embeddingDimensions: int('EMBEDDING_DIMENSIONS', 1024),
  jinaApiKey: str('JINA_API_KEY', ''),
  jinaBaseUrl: str('JINA_BASE_URL', 'https://api.jina.ai/v1/embeddings'),
};
