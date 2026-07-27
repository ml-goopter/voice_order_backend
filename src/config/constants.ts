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
  /** Hard ceiling on ONE Cartesia synthesis request. The concurrency permit is held for the whole
   *  call, so without this a stalled request retires a slot for as long as the SDK's own default
   *  (1 min × 2 retries) — on the 2-context Free plan two of those silence every later reply.
   *  Sized well above a normal segment (~1 s) but inside a turn's usable latency. */
  ttsRequestMs: 10_000,
} as const;

export const LIMITS = {
  /** §7 — in-memory embedding matcher is fine below this many menu vectors. */
  inMemoryEmbeddingCap: 2_000,
  /** §7 — candidate set size returned to the LLM per turn. */
  maxCandidatesToLlm: 8,
  /** Cap on the items a spoken reply carries to the client. A payload/card-count guard, NOT a
   *  function of `maxCandidatesToLlm`: a turn accumulates every search it ran, so the agent may
   *  legitimately have seen far more items than one search returns. */
  maxMentionedItems: 8,
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
 * Rate-limiter algorithm tunables. The quotas themselves live in `env.ts` — they are a function
 * of the provider plan an operator bought, so they are per-deployment.
 */
export const RATE_LIMIT = {
  /** char→token estimation divisor; post-call reconciliation corrects the error. */
  charsPerToken: 4,
  /** Next-grant floor applied when a 429 carried no usable `Retry-After`. */
  penalty429Ms: 5_000,
  /** Ceiling on a penalty derived from a provider's `Retry-After`. A penalty only ever EXTENDS,
   *  so one absurd header (`Retry-After: 86400`, or a far-future HTTP-date) would otherwise
   *  disable that provider for the lifetime of the process. Every quota here is metered per
   *  minute, so a minute is the longest hold-off that can still be about rate. */
  maxPenaltyMs: 60_000,
  /** Delay before a client's OWN transport retry when the provider sent no usable `Retry-After`.
   *  Re-issuing instantly against a key that just said stop is how one 429 becomes a burst. */
  retryBackoffMs: 250,
  /** Ceiling on that delay. This wait sits INSIDE the caller's request budget — a live voice turn
   *  — so a provider's multi-second `Retry-After` cannot be honoured in full here. The rest of the
   *  hold-off is carried by `penalize`, which floors the next grant for every later caller. */
  maxRetryBackoffMs: 500,
  /** Backstop against unbounded queue growth under sustained overload. Per-waiter deadlines
   *  alone bound depth only to arrival-rate × deadline; failing fast beats a queue in which
   *  everyone times out anyway. */
  maxQueuedWaiters: 256,
  /** Fallback wait budget for an acquire that names no `deadlineMs`. Every production call site
   *  passes its own (`*_RATE_LIMIT_WAIT_MS`) — the deadline is a per-call latency budget, never a
   *  property of the quota. */
  defaultWaitMs: 1_000,
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
