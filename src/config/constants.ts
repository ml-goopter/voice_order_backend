/** Tunables drawn from the design (timeouts in ms). */
export const TIMEOUTS = {
  /** §11.2 case C — fail the session if no final transcript arrives after voice.stop. */
  finalTranscriptMs: 4_000,
  /** §3 / §11.1 — heartbeat ping interval and dead-socket threshold. */
  heartbeatIntervalMs: 15_000,
  heartbeatTimeoutMs: 30_000,
  /** §11.1 — how long the backend holds cart/session state open for reconnect. */
  reconnectWindowMs: 60_000,
} as const;

export const LIMITS = {
  /** §7 — in-memory embedding matcher is fine below this many menu vectors. */
  inMemoryEmbeddingCap: 2_000,
  /** §7 — candidate set size returned to the LLM per turn. */
  maxCandidatesToLlm: 8,
  /** Plan A — turns of prior (utterance + clarification answer) resent to the model as context. */
  maxHistoryTurns: 6,
  /** §11.3 — schema-repair re-prompts on invalid LLM JSON before falling back to clarify/manual. */
  llmMaxRetries: 1,
  /** Transport-level retries (429/5xx/network) the OpenAI SDK performs per request. */
  llmTransportMaxRetries: 1,
} as const;
