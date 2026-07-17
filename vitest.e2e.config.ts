import { defineConfig } from 'vitest/config';

/**
 * Config for the e2e suite (`npm run test:e2e`). Kept separate from vitest.config.ts so the e2e
 * never runs with the unit tests: the default config only includes `*.test.ts`, and these files
 * are named `*.e2e.ts`.
 *
 * The suite loads `.env` and passes the provider settings straight through — whatever the app
 * runs in production is what these tests use. Production runs the LLM as Gemini via the
 * OpenAI-compatible endpoint (LLM_PROVIDER=openai, LLM_BASE_URL=.../v1beta/openai/), so that is
 * the model exercised here. The two suites differ in how much of the stack is live:
 *   - `llm_pipeline.e2e.ts` — REAL LLM only; the DB is mocked (in-memory cart cache + fake menu),
 *     so it runs independently of Postgres/Redis/Jina. Self-skips if no LLM is configured.
 *   - `embedding.e2e.ts`    — full live stack: Postgres/pgvector + Jina query embeddings + LLM.
 *     Self-skips if that stack is unreachable. It is why the DB/embedding env below is retained.
 *
 * LLM fallbacks are empty (not a local Ollama): with no `.env`, the provider resolves to `stub`
 * and the LLM suites self-skip rather than dialing a model that isn't there.
 */
try {
  process.loadEnvFile('.env');
} catch {
  // No .env (e.g. CI) — rely on real process.env; the suites self-skip when their deps are absent.
}

const pick = (name: string, fallback: string) => process.env[name] || fallback;

const env = {
  REDIS_URL: pick('REDIS_URL', 'redis://localhost:6379'),
  // Menu backend (embedding.e2e.ts). Password (if any) comes from .env; the db binds localhost:5432.
  ODOO_DATABASE_URL: pick('ODOO_DATABASE_URL', 'postgres://odoo@localhost:5432/postgres'),
  // Main proposer/agent LLM — passed through from .env (production = Gemini, OpenAI-compatible).
  LLM_PROVIDER: pick('LLM_PROVIDER', ''),
  LLM_MODEL: pick('LLM_MODEL', ''),
  LLM_BASE_URL: pick('LLM_BASE_URL', ''),
  LLM_API_KEY: pick('LLM_API_KEY', ''),
  LLM_TIMEOUT_MS: pick('LLM_TIMEOUT_MS', '120000'),
  // Intent classifier's own creds (fall back to LLM_* in config if unset) — also passed through.
  INTENT_LLM_PROVIDER: pick('INTENT_LLM_PROVIDER', ''),
  INTENT_LLM_MODEL: pick('INTENT_LLM_MODEL', ''),
  INTENT_LLM_BASE_URL: pick('INTENT_LLM_BASE_URL', ''),
  INTENT_LLM_API_KEY: pick('INTENT_LLM_API_KEY', ''),
  // Embedding stack (embedding.e2e.ts only).
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
    // Gemini turns are quick, but a live-stack embedding run (or a slow local model) needs
    // headroom; keep a generous per-test ceiling.
    testTimeout: 120_000,
    hookTimeout: 30_000,
    env,
    // Serialize: shared LLM, and each turn is heavy.
    fileParallelism: false,
  },
});
