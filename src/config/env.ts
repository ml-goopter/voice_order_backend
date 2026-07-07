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
  readonly databaseUrl: string;

  readonly sttProvider: string; // 'assemblyai' | 'deepgram' | ...
  readonly llmProvider: string; // 'groq' | 'openai' | 'gemini' | ...
  readonly embeddingModel: string;
}

export const config: AppConfig = {
  nodeEnv: str('NODE_ENV', 'development'),
  port: int('PORT', 3000),
  logLevel: str('LOG_LEVEL', 'info'),

  redisUrl: str('REDIS_URL', 'redis://localhost:6379'),
  databaseUrl: str('DATABASE_URL', 'postgres://localhost:5432/voice_ordering'),

  sttProvider: str('STT_PROVIDER', 'assemblyai'),
  llmProvider: str('LLM_PROVIDER', 'groq'),
  embeddingModel: str('EMBEDDING_MODEL', 'text-embedding-3-small'),
};
