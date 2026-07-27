---
type: Concept
title: Rate Limiter
description: Token bucket + semaphore + quota-identity registry, injected into the four provider adapters.
resource: src/ratelimit
timestamp: 2026-07-27
---

# Rate Limiter

## Purpose
Proactive shaping of every outbound metered call (AssemblyAI STT, Cartesia TTS,
OpenAI-compatible LLM ×2, Jina embeddings). Before this the only protection was reactive —
the OpenAI SDK's internal 429 retries and Jina's single retry, both *after* the provider had
already rejected us, so a busy restaurant tripped the quota and the retries added load.

The limiter lives **inside the provider adapters**. Nothing in `ordering`, `events`,
`realtime`, or `voice` knows it exists; the `LlmProvider`/`SttProvider`/`TtsProvider`/
`EmbeddingService` interfaces are unchanged, which is what keeps it out of the event-bus
contracts.

## Mechanics

**The four providers meter four different things** — the fact the whole design turns on. A
uniform per-minute request bucket would be wrong for three of them:

| Provider | Metered | Explicitly NOT metered | Primitive |
|---|---|---|---|
| AssemblyAI | new sessions **per minute** | total concurrent streams | token bucket |
| Cartesia | concurrent contexts (2–15 by plan) | RPM, characters/min | semaphore |
| Jina | RPM **and** TPM, whichever trips first | batch size | dual bucket |
| OpenAI-compatible | RPM **and** TPM per model pool | — (Ollama meters nothing) | dual bucket |

- `TokenBucket(capacity, refillPerSec)` — rate dimensions. Capacity = one minute's budget,
  mirroring how providers meter; a fixed window would admit 2× across a boundary. FIFO waiter
  queue, **scheduled not polled** (one timer armed for the head only, re-armed on drain,
  `unref`'d). Injected monotonic clock (`performance.now()`, never `Date.now()` — NTP can step
  it backwards and vanish tokens) with a `max(0, delta)` refill guard. Tokens may go negative
  after reconciliation; the debt drains at the quota rate. A cost exceeding capacity is clamped
  and warned once, so an oversized prompt degrades to "wait one refill period" rather than
  hanging to its deadline every call.
- `Semaphore(permits)` — concurrency. FIFO, permit handed directly to the queue head, and
  **idempotent release**. The bucket/semaphore split is not stylistic: a bucket models a
  *regenerating* resource and has no release, so a slot that must be **returned** — and can
  therefore be **leaked** — cannot be represented in one.
- `RateLimiter` — composes RPM bucket → TPM bucket → semaphore behind `acquire`/`run`/
  `penalize`. **One absolute deadline is computed once** and shared by all three stages, so
  total wait is bounded by `deadlineMs` rather than 3×. Deadline expiry and abort **splice the
  waiter out of the queue** — a corpse holding a reservation is a slow-motion capacity leak. A
  hard `maxQueuedWaiters` cap rejects synchronously, because per-waiter deadlines alone bound
  depth only to arrival-rate × deadline.
- **The reservation basis never shrinks.** `settle(actual)` charges MORE (`forceTake`, may go
  negative) but never refunds below what was reserved. Providers assess
  `max(max_tokens, input estimate)` before generation with no refund, so refunding locally
  would make the limiter strictly more permissive than the provider it protects — manufacturing
  the 429s it exists to prevent. `settle(undefined)` leaves the estimate standing (Ollama and
  Gemini's compat endpoint report no `usage`).
- `arrival.ts` / `reachedProvider()` — decides refund vs keep on failure, reading through the
  `cause` chain (depth-capped, so a cycle cannot loop). Any HTTP status proves arrival; a
  connection-establishment errno (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`,
  `ENETUNREACH`, `ERR_SOCKET_CONNECTION_TIMEOUT`) or our own limiter refusing proves the
  opposite; **everything else keeps its charge**. Deliberately asymmetric: over-charging a call
  that never arrived costs throughput that refills within the metering window, while
  under-charging one that did arrive is permanent and compounds exactly when the provider is
  already rejecting us. `ECONNRESET`/`ETIMEDOUT` are excluded from never-arrived — both also
  occur mid-request.
- `registry.ts` — memoizes limiters on **quota identity** (`provider | baseUrl | apiKey |
  model`). Load-bearing: every `INTENT_LLM_*` var falls back to its `LLM_*` twin, so by default
  both LLM adapters hit the same account/model/quota, and two independent limiters would
  silently grant 2× the real budget. Conflicting quota on one identity keeps the first and warns
  with a `shaped` field, distinguishing "we picked one of two caps" from "no cap survived".
  Identity bookkeeping runs even when the resolved limiter is `NO_LIMIT`, so a disagreement
  still surfaces.
- `estimate-tokens.ts` — `ceil(chars / 4)` plus a per-message envelope. Deliberately not a real
  BPE tokenizer: `gpt-tokenizer` is a devDependency used only by `scripts/`, and a BPE table in
  the hot path to refine a number reconciliation corrects anyway is not worth it. A calibration
  test pins it within ±25% of the ~4,303 tokens/step recorded in `docs/llm-prompt-cost-estimate.md`.
- `retry-after.ts` — parses delay-seconds and all three RFC 7231 date forms (asctime is
  normalised to GMT; `Date.parse` would otherwise read it as local). Gated on a weekday prefix
  before trusting `Date.parse`, because `Date.parse('-5')` returns a valid 2001 timestamp rather
  than NaN, which silently produced a **zero** penalty. Clamped to `RATE_LIMIT.maxPenaltyMs`, so
  a hostile `Retry-After: 86400` cannot disable a provider for the process lifetime.
- **429 ownership is split.** The SDK stays the sole *reactive* handler (do not add a second
  retry loop — two layers multiply into 3×3 attempts against a provider already saying stop).
  The limiter is purely *proactive*, reserving once per logical call outside the retry loop. A
  terminal 429 **settles** (the provider counted that request) and calls `penalize()` to floor
  the next grant. `penalize` stores an absolute instant rather than accumulating and is bounded
  by `maxPenaltyMs`, so it cannot ratchet; it touches only the rate buckets, never the
  semaphore, so live sessions are unaffected.

**Ships dark.** All-zero limits resolve to a shared `NO_LIMIT` whose `run` calls `fn()`
directly — no allocation, no timers, no token estimate computed.

## Dependencies
- `config/env` (per-deployment quota; every limit defaults to `0`) and `config/constants`
  (`RATE_LIMIT` algorithm tunables). `shared/errors` for `RateLimitTimeoutError`.
- Consumed by `stt/`, `tts/`, `llm/`, `menu/` adapters; `app.ts` logs resolved identities at boot.

## Key files
- `token-bucket.ts` — rate dimensions; refill, FIFO queue, penalty floor, clamp-and-warn.
- `semaphore.ts` — concurrency; FIFO, direct handoff, idempotent release.
- `rate-limiter.ts` — the composite (`acquire`/`run`/`penalize`, `Lease`, `NO_LIMIT`).
- `registry.ts` — `rateLimiters` singleton, quota-identity memoization, `describe()` for the boot log.
- `arrival.ts` — `reachedProvider()`, the refund-vs-keep rule.
- `estimate-tokens.ts` — pre-call TPM estimate.
- `retry-after.ts` — `retryAfterMs`, `is429`.
- `errors.ts` — `RateLimitTimeoutError`.

## Known limitations
- **RPM systematically under-books.** One reservation sits outside every transport retry loop,
  so a logical call can cost up to 4 provider-counted requests (OpenAI `maxRetries: 3`), 2
  (Jina), or 3 (AssemblyAI's `maxConnectionRetries`). Worst during a refusal storm — exactly
  when retries fire. TPM is unaffected, being reconciled from real `usage`.
- **Single process, in-memory.** N replicas grant N× quota. The seam is `TokenBucket`/
  `Semaphore` behind the limiter facade — a cross-replica version replaces only those two
  against the existing `src/redis/` client.
- **Strict FIFO** can let a large agent call delay a small intent call. Small-first would invert
  the harm onto the call that serves the customer, so FIFO stands; the mitigation is separate
  credentials for `INTENT_LLM_*`.
