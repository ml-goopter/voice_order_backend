import { defineConfig } from 'vitest/config';

/**
 * Config for the real-stack e2e suite (`npm run test:e2e`). Kept separate from
 * vitest.config.ts so the e2e never runs with the unit tests: the default config
 * only includes `*.test.ts`, and these files are named `*.e2e.ts`.
 *
 * The suite drives the final-transcript pipeline against a LIVE Postgres/pgvector
 * (the menu backend), a LIVE Redis (cart cache), and a LIVE Ollama LLM, with real
 * Jina query embeddings so retrieval uses the vector KNN path (the whole point of
 * the real stack).
 *
 * .env supplies JINA_API_KEY + provider settings; we load it here and then FORCE
 * the LLM to Ollama (the .env ships LLM_PROVIDER=stub from .env.example, which would
 * bypass the real model this suite exists to exercise) and raise the per-request LLM
 * timeout (qwen3:14b thinks for tens of seconds — well past the 30s default).
 */
try {
  process.loadEnvFile('.env');
} catch {
  // No .env (e.g. CI) — rely on real process.env; the suite self-skips if the
  // live stack isn't reachable.
}

const pick = (name: string, fallback: string) => process.env[name] || fallback;

const env = {
  REDIS_URL: pick('REDIS_URL', 'redis://localhost:6379'),
  // Menu backend. Password (if any) comes from .env; the db service binds localhost:5432.
  ODOO_DATABASE_URL: pick('ODOO_DATABASE_URL', 'postgres://odoo@localhost:5432/postgres'),
  LLM_PROVIDER: pick('LLM_PROVIDER', 'openai'),
  LLM_MODEL: pick('LLM_MODEL', 'qwen3:14b'),
  LLM_BASE_URL: pick('LLM_BASE_URL', 'http://localhost:11434/v1'),
  LLM_API_KEY: pick('LLM_API_KEY', 'ollama'),
  LLM_TIMEOUT_MS: pick('LLM_TIMEOUT_MS', '120000'),
  EMBEDDING_PROVIDER: pick('EMBEDDING_PROVIDER', 'jina'),
  EMBEDDING_MODEL: pick('EMBEDDING_MODEL', 'jina-embeddings-v3'),
  EMBEDDING_DIMENSIONS: pick('EMBEDDING_DIMENSIONS', '1024'),
  JINA_API_KEY: pick('JINA_API_KEY', ''),
  JINA_BASE_URL: pick('JINA_BASE_URL', 'https://api.jina.ai/v1/embeddings'),
  LOG_LEVEL: pick('LOG_LEVEL', 'warn'),
};

export default defineConfig({
  test: {
    include: ['E2E/*.e2e.ts'],
    environment: 'node',
    // A real qwen3 turn takes ~45-60s; the clarify→resume test does two, and the
    // clarify→timeout test waits out TIMEOUTS.clarificationMs (30s) on top.
    testTimeout: 240_000,
    hookTimeout: 30_000,
    env,
    // Serialize: shared LLM/Redis, and each turn is heavy.
    fileParallelism: false,
  },
});
