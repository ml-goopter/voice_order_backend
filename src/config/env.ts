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

  readonly sttProvider: string; // 'assemblyai' | 'deepgram' | ...
  readonly llmProvider: string; // 'groq' | 'openai' | 'gemini' | ...
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

  sttProvider: str('STT_PROVIDER', 'assemblyai'),
  llmProvider: str('LLM_PROVIDER', 'groq'),
  embeddingProvider: str('EMBEDDING_PROVIDER', 'stub'),
  embeddingModel: str('EMBEDDING_MODEL', 'jina-embeddings-v3'),
  embeddingDimensions: int('EMBEDDING_DIMENSIONS', 1024),
  jinaApiKey: str('JINA_API_KEY', ''),
  jinaBaseUrl: str('JINA_BASE_URL', 'https://api.jina.ai/v1/embeddings'),
};
