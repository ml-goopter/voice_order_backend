/** Tunables drawn from the design (timeouts in ms). */
export const TIMEOUTS = {
  /** §11.2 case C — fail the session if no final transcript arrives after voice.stop. */
  finalTranscriptMs: 4_000,
  /** Auto-end the turn when no new partial transcript arrives — the customer stopped talking. */
  partialIdleMs: 60_000,
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
  /** §7 — candidate set size returned to the LLM per turn. */
  maxCandidatesToLlm: 8,
  /** Plan A — turns of prior (utterance + agent reply) resent to the model as context. */
  maxHistoryTurns: 6,
  /** Agent tool-calling: cap on `agent ⇄ tools` iterations per turn (cost/latency guard +
   *  runaway-loop backstop). Exhaustion fails the turn (`agent_step_limit`). Sized to allow
   *  several sequential per-item searches before a `propose_cart` — a model that searches
   *  one item per turn must still be able to finish a multi-item order. See docs/agent-tools.md. */
  maxAgentSteps: 8,
  /** Transport-level retries (429/5xx/network) the OpenAI SDK performs per request. */
  llmTransportMaxRetries: 3,
} as const;

/**
 * Popularity ranking, derived live from `pos_order_line` (there is no stored popularity —
 * see docs/plans/agent-search-extension.md §5).
 */
export const POPULARITY = {
  /** Trailing window of trade to rank over. Both live DBs hold ~1-7 weeks, so this is
   *  currently "everything"; it exists so the window can't silently become "all time". */
  windowDays: 90,
  /** Rank boundaries for the coarse tier shown to the agent. A rank number would be false
   *  precision on ~1 month of trade; a tier is honest at this sample size. */
  topRank: 5,
  popularRank: 20,
} as const;
