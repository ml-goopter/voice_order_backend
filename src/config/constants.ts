/** Tunables drawn from the design (timeouts in ms). */
export const TIMEOUTS = {
  /** §11.2 case C — fail the session if no final transcript arrives after voice.stop. */
  finalTranscriptMs: 4_000,
  /** §9 Tier-1 — expire a stalled clarification so the per-cart FIFO never freezes. */
  clarificationMs: 30_000,
  /** §3 / §11.1 — heartbeat ping interval and dead-socket threshold. */
  heartbeatIntervalMs: 15_000,
  heartbeatTimeoutMs: 30_000,
  /** §11.1 — how long the backend holds cart/session state open for reconnect. */
  reconnectWindowMs: 60_000,
} as const;

export const LIMITS = {
  /** §7 — in-memory embedding matcher is fine below this many menu vectors. */
  inMemoryEmbeddingCap: 2_000,
  /** §7 — candidate set size returned to the LLM. */
  maxCandidatesToLlm: 8,
  /** §11.3 — LLM retry budget before falling back to clarify/manual. */
  llmMaxRetries: 1,
} as const;
