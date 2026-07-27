/**
 * Environment configuration. Reads process.env with safe defaults so the scaffold
 * boots without a full .env. Replace/extend as real providers are wired in.
 */

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

/**
 * A non-negative integer, or the fallback plus a complaint.
 *
 * Deliberately NOT `parseInt`: it truncates silently, so `LLM_RPM=0.9` became `0` — which in this
 * config means *unlimited*, the exact opposite of what the operator asked for — and `LLM_RPM=-5`
 * became a negative capacity that disables shaping just as quietly. Every int here is a count, a
 * port or a duration, so a negative or fractional value is always a typo. It is reported and
 * dropped rather than obeyed.
 *
 * The accepted syntax is plain decimal digits, nothing else. `Number` on its own is far wider than
 * dotenv values ever are: it reads `0x10` as 16, `1e3` as 1000 and `' 5 '` as 5, so a typo'd quota
 * would be silently obeyed as a number the operator never wrote.
 *
 * `console.warn`, not `logger`: `logger.ts` reads `config` at module scope, so importing it here
 * would be a cycle that leaves the logger looking at an uninitialised binding.
 */
const DECIMAL_INT = /^\d+$/;

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = DECIMAL_INT.test(v) ? Number(v) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 0) {
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'config.invalid_int',
        name,
        value: v,
        using: fallback,
        expected: 'a non-negative decimal integer (digits only)',
      }),
    );
    return fallback;
  }
  return n;
}

/** Comma-separated list, e.g. "CUSTOMER TYPE,Charges". Blank entries dropped. */
function list(name: string): string[] {
  return str(name, '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface AppConfig {
  readonly nodeEnv: string;
  readonly port: number;
  readonly logLevel: string;

  readonly redisUrl: string;
  readonly odooDatabaseUrl: string; // Postgres (Odoo POS DB) that also holds our `item_vector` table
  readonly odooApiUrl: string; // base URL of the Odoo instance serving goopter_cart_api (NOT the DB above)
  readonly odooApiKey: string; // Odoo API key of the integration user (bearer auth)
  readonly odooApiDatabase: string; // Odoo database name; '' when the instance resolves one itself
  readonly cartIdempotencyTtlSeconds: number; // TTL on the cart idempotency ledger (design §9)
  readonly deviceIndexTtlSeconds: number; // TTL on the device:/table: cart traceability indexes

  readonly sttProvider: string; // 'assemblyai' | ...
  readonly sttSampleRate: number; // Hz of the client PCM16 stream (design §5)
  // End-of-turn endpointing: how long AssemblyAI waits in silence before ending a turn.
  // Raised above provider defaults so natural mid-order pauses ("uhh… and a coke") ride
  // through as one turn instead of splitting into several finals (one request each).
  readonly sttMinTurnSilenceMs: number; // silence to end a turn when confident
  readonly sttMaxTurnSilenceMs: number; // hard ceiling: end the turn regardless of confidence
  readonly assemblyAiApiKey: string;
  // Rate limiting. EVERY quota below defaults to 0 = unlimited, so the limiter ships dark and is
  // switched on per deployment; the wait deadlines are the only non-zero defaults. AssemblyAI
  // meters new sessions PER MINUTE, not concurrent streams — the concurrency cap is a cost guard
  // (it bills on socket-open time), not a quota guard. See docs/plans/rate-limiting-policy.md.
  readonly sttSessionsPerMin: number;
  readonly sttMaxConcurrentSessions: number;
  readonly sttRateLimitWaitMs: number; // once per session, not per turn — a longer budget is fine
  readonly ttsProvider: string; // 'cartesia' | 'noop'
  readonly cartesiaApiKey: string;
  readonly ttsModel: string; // Cartesia Sonic model, e.g. 'sonic-3.5' (multilingual)
  readonly ttsVoiceId: string; // Cartesia voice UUID (a multi-locale voice speaks all languages)
  readonly ttsLanguage: string; // ISO-639-1 fallback when the agent declared no reply language (e.g. 'en')
  readonly ttsEncoding: string; // audio encoding streamed to the client ('mp3' default; 'linear16' etc.)
  readonly ttsSampleRate: number; // Hz of the emitted audio; mp3 container also requires it (Cartesia)
  readonly ttsBitRate: number; // mp3 bit rate for the Cartesia mp3 container (bps)
  // Cartesia meters CONCURRENT CONTEXTS only; there is no published request-rate limit, so there
  // is deliberately no TTS_RPM. Mid-reply, so the wait budget is the tightest of the four.
  readonly ttsMaxConcurrent: number;
  readonly ttsRateLimitWaitMs: number;
  readonly llmProvider: string; // 'stub' | 'ollama' | 'openai' | ...
  readonly llmModel: string;
  readonly llmBaseUrl: string; // OpenAI-compatible base URL (Ollama by default)
  readonly llmApiKey: string;
  readonly llmTimeoutMs: number; // per-request timeout; raise for slow local models
  readonly llmRpm: number;
  readonly llmTpm: number;
  readonly llmMaxConcurrent: number;
  readonly llmRateLimitWaitMs: number;
  // Floor for the per-call TPM reservation: providers charge max(max_tokens, input estimate)
  // BEFORE generation and issue no refund, so the reservation must assume the output too.
  readonly llmMaxOutputTokensEst: number;
  // Intent classifier: its OWN provider/creds (design §6, the cheap first-hop call). Each
  // INTENT_LLM_* var falls back to the matching LLM_* so it's opt-in — leave them unset to
  // reuse the main provider, or point the classifier at a cheaper/separate model + key.
  readonly intentLlmProvider: string;
  readonly intentLlmModel: string;
  readonly intentLlmBaseUrl: string;
  readonly intentLlmApiKey: string;
  readonly intentLlmTimeoutMs: number;
  readonly intentLlmRpm: number;
  readonly intentLlmTpm: number;
  readonly intentLlmMaxConcurrent: number;
  readonly intentLlmRateLimitWaitMs: number;
  // Deliberately NOT falling back to LLM_MAX_OUTPUT_TOKENS_EST: that number sizes an agent reply,
  // while the classifier's whole output is `{"intent":"service"}` (~10 tokens). Inheriting 800
  // would reserve ~80× the real cost on a bucket the classifier shares with the parser by default,
  // throttling the parser against tokens the classifier never spends.
  readonly intentLlmMaxOutputTokensEst: number;
  readonly embeddingProvider: string; // 'stub' | 'jina' | ...
  readonly embeddingModel: string;
  readonly embeddingDimensions: number;
  readonly jinaApiKey: string;
  readonly jinaBaseUrl: string;
  // Jina meters RPM and TPM, whichever trips first, across ALL Jina products on one key.
  readonly embeddingRpm: number;
  readonly embeddingTpm: number;
  readonly embeddingMaxConcurrent: number;
  readonly embeddingRateLimitWaitMs: number;
  /**
   * POS category names whose products are not dishes (e.g. "CUSTOMER TYPE" — cover
   * charges, the negative-price Discount product). The seed skips them, so they never
   * enter `item_vector` and are neither searchable nor proposable. Excluded by category
   * name rather than template id: one legible entry an operator can find in the POS UI
   * covers every member, including ones added later. Odoo's own service products
   * (pos_config tip/down-payment/refund) are excluded automatically and need no entry
   * here. See docs/plans/agent-search-extension.md §5.3.
   */
  readonly menuExcludedCategories: string[];
}

export const config: AppConfig = {
  nodeEnv: str('NODE_ENV', 'development'),
  port: int('PORT', 3000),
  logLevel: str('LOG_LEVEL', 'info'),

  redisUrl: str('REDIS_URL', 'redis://localhost:6379'),
  odooDatabaseUrl: str('ODOO_DATABASE_URL', 'postgres://localhost:5432/odoo'),
  odooApiUrl: str('ODOO_API_URL', 'http://localhost:8069'),
  odooApiKey: str('ODOO_API_KEY', ''),
  odooApiDatabase: str('ODOO_API_DATABASE', ''),
  cartIdempotencyTtlSeconds: int('CART_IDEMPOTENCY_TTL_SECONDS', 86_400),
  deviceIndexTtlSeconds: int('DEVICE_INDEX_TTL_SECONDS', 86_400),

  sttProvider: str('STT_PROVIDER', 'assemblyai'),
  sttSampleRate: int('STT_SAMPLE_RATE', 16_000),
  sttMinTurnSilenceMs: int('STT_MIN_TURN_SILENCE_MS', 1_600),
  sttMaxTurnSilenceMs: int('STT_MAX_TURN_SILENCE_MS', 3_600),
  assemblyAiApiKey: str('ASSEMBLYAI_API_KEY', ''),
  sttSessionsPerMin: int('STT_SESSIONS_PER_MIN', 0),
  sttMaxConcurrentSessions: int('STT_MAX_CONCURRENT_SESSIONS', 0),
  sttRateLimitWaitMs: int('STT_RATE_LIMIT_WAIT_MS', 2_000),
  ttsProvider: str('TTS_PROVIDER', 'cartesia'),
  cartesiaApiKey: str('CARTESIA_API_KEY', ''),
  ttsModel: str('TTS_MODEL', 'sonic-3.5'),
  ttsVoiceId: str('TTS_VOICE_ID', '694f9389-aac1-45b6-b726-9d9369183238'),
  ttsLanguage: str('TTS_LANGUAGE', 'en'),
  ttsEncoding: str('TTS_ENCODING', 'mp3'),
  ttsSampleRate: int('TTS_SAMPLE_RATE', 24_000),
  ttsBitRate: int('TTS_BIT_RATE', 128_000),
  ttsMaxConcurrent: int('TTS_MAX_CONCURRENT', 0),
  ttsRateLimitWaitMs: int('TTS_RATE_LIMIT_WAIT_MS', 800),
  llmProvider: str('LLM_PROVIDER', 'stub'),
  llmModel: str('LLM_MODEL', 'llama3.1'),
  llmBaseUrl: str('LLM_BASE_URL', 'http://localhost:11434/v1'),
  llmApiKey: str('LLM_API_KEY', ''),
  llmTimeoutMs: int('LLM_TIMEOUT_MS', 30_000),
  llmRpm: int('LLM_RPM', 0),
  llmTpm: int('LLM_TPM', 0),
  llmMaxConcurrent: int('LLM_MAX_CONCURRENT', 0),
  llmRateLimitWaitMs: int('LLM_RATE_LIMIT_WAIT_MS', 1_500),
  llmMaxOutputTokensEst: int('LLM_MAX_OUTPUT_TOKENS_EST', 800),
  // Each falls back to the matching LLM_* value so the classifier reuses the main provider
  // unless its own INTENT_LLM_* var is set.
  intentLlmProvider: str('INTENT_LLM_PROVIDER', str('LLM_PROVIDER', 'stub')),
  intentLlmModel: str('INTENT_LLM_MODEL', str('LLM_MODEL', 'llama3.1')),
  intentLlmBaseUrl: str('INTENT_LLM_BASE_URL', str('LLM_BASE_URL', 'http://localhost:11434/v1')),
  intentLlmApiKey: str('INTENT_LLM_API_KEY', str('LLM_API_KEY', '')),
  intentLlmTimeoutMs: int('INTENT_LLM_TIMEOUT_MS', int('LLM_TIMEOUT_MS', 30_000)),
  intentLlmRpm: int('INTENT_LLM_RPM', int('LLM_RPM', 0)),
  intentLlmTpm: int('INTENT_LLM_TPM', int('LLM_TPM', 0)),
  intentLlmMaxConcurrent: int('INTENT_LLM_MAX_CONCURRENT', int('LLM_MAX_CONCURRENT', 0)),
  intentLlmRateLimitWaitMs: int('INTENT_LLM_RATE_LIMIT_WAIT_MS', int('LLM_RATE_LIMIT_WAIT_MS', 1_500)),
  intentLlmMaxOutputTokensEst: int('INTENT_LLM_MAX_OUTPUT_TOKENS_EST', 32),
  embeddingProvider: str('EMBEDDING_PROVIDER', 'stub'),
  embeddingModel: str('EMBEDDING_MODEL', 'jina-embeddings-v3'),
  embeddingDimensions: int('EMBEDDING_DIMENSIONS', 1024),
  jinaApiKey: str('JINA_API_KEY', ''),
  jinaBaseUrl: str('JINA_BASE_URL', 'https://api.jina.ai/v1/embeddings'),
  embeddingRpm: int('EMBEDDING_RPM', 0),
  embeddingTpm: int('EMBEDDING_TPM', 0),
  embeddingMaxConcurrent: int('EMBEDDING_MAX_CONCURRENT', 0),
  embeddingRateLimitWaitMs: int('EMBEDDING_RATE_LIMIT_WAIT_MS', 1_000),
  menuExcludedCategories: list('MENU_EXCLUDED_CATEGORIES'),
};
