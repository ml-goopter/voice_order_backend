# Rate limiting for third-party APIs (policy)

Status: **implemented** (`src/ratelimit/`, wired into the four call sites below). Scope: `src/stt/`, `src/tts/`, `src/llm/`, `src/menu/jina-embedding-service.ts`,
`src/config/`, plus a new `src/ratelimit/`.

Provider quotas verified against vendor docs on 2026-07-27; see §7 for source caveats.

## 1. Problem

Nothing in the backend limits the rate of outbound calls to metered third parties. Four callers
share that exposure:

| Caller | File | Call shape |
|---|---|---|
| AssemblyAI STT | `src/stt/assemblyai-stt-provider.ts:26-82` | long-lived WebSocket, minutes per session |
| Cartesia TTS | `src/tts/cartesia-tts-provider.ts:37-41` | **discrete REST request per segment** |
| OpenAI-compatible LLM | `src/llm/openai-compatible-provider.ts:60-68`, `:92-100` | request/response, ×2 adapters |
| Jina embeddings | `src/menu/jina-embedding-service.ts:56-92` | request/response, ≤`maxAgentSteps` per turn |

The only existing protection is reactive: the OpenAI SDK retries 429/5xx internally
(`LIMITS.llmTransportMaxRetries = 3`) and Jina retries once (`MAX_RETRIES = 1`). Both react *after*
the provider has already rejected us. There is no proactive shaping, so a busy restaurant hits the
quota, the provider 429s, the retries add load, and the turn fails.

`src/shared/async-lock.ts` (`KeyedAsyncLock`) is a serializer, not a limiter — it bounds ordering,
not rate.

## 2. What each provider actually meters

This is the crux of the policy: **the four providers meter four different things.** A single
per-minute request bucket applied uniformly would be wrong for three of the four.

| Provider | Metered dimension | Explicitly *not* metered | Primitive |
|---|---|---|---|
| AssemblyAI | **new sessions / minute** (5 free, 100 paid, auto-scaling) | total concurrent streams | token bucket |
| Cartesia | **concurrent contexts** (2 / 3 / 5 / 15 by plan) | RPM, characters-per-minute | semaphore |
| Jina | **RPM and TPM**, whichever trips first | batch size on `/v1/embeddings` | dual bucket |
| OpenAI-compatible | **RPM and TPM** per model pool | — (Ollama meters nothing) | dual bucket |

Three consequences that drive the rest of this document:

**AssemblyAI limits session *creation*, not session *count*.** Documented verbatim: "There is no
limit on the total number of concurrent streaming sessions; instead, there is only a limit on the
number of new streaming sessions that can be created per minute." The quota-respecting primitive is
therefore a bucket on connect, not a semaphore. A concurrency cap is still worth having, but its
justification is **cost, not quota** — see §5.1.

**Cartesia is the binding constraint of the four.** 2 concurrent contexts on Free, 3 on Pro. Their
docs put achievable parallel conversations at ~4× the concurrency limit for conversational use, so
Pro supports roughly 12 simultaneous conversations before TTS becomes the wall — long before the LLM
or STT quota is troubled.

**Cartesia's own mitigation does not apply to this codebase as written.** Their guidance for voice
agents is to reuse one WebSocket `context_id` per call, since repeated requests on the same context
serialize instead of adding concurrency. This backend uses the REST `tts.generate()` path, one call
per segment (`tts-client.ts:47-60`), so **each segment is its own context and consumes its own
slot**. A four-sentence reply is four slots on a 2-slot plan. Migrating TTS to a persistent
WebSocket context is out of scope here but is the single highest-leverage follow-up; noted in §9.

## 3. Primitives

Token bucket for rate dimensions, semaphore for concurrency. The distinction is not stylistic: a
bucket models a **regenerating** resource and has no release operation, so a slot that must be
*returned* — and can therefore be *leaked* — cannot be represented in one.

- `TokenBucket(capacity, refillPerSec)` — `capacity = RPM` (or TPM), `refill = capacity/60` per
  second. Burst tolerance up to one minute's budget, which mirrors how the providers meter. A fixed
  window would admit 2× the limit across a window boundary; a bucket will not.
- `Semaphore(permits)` — FIFO, permit handed directly to the queue head, **idempotent release**.

Both take an injected monotonic clock (`performance.now()`, never `Date.now()` — NTP can step it
backwards and make tokens vanish), with a `max(0, delta)` guard on the refill arithmetic.

Waiting is **scheduled, not polled**: one timer armed for the queue head only, re-armed on drain,
`unref`'d (matching `voice-message-handler.ts:112`).

## 4. Overflow policy: queue with a deadline, then fail

A caller waits for capacity up to a bounded deadline; on expiry it fails fast so the turn degrades
rather than hanging. Live voice makes unbounded queuing worse than rejection.

Three properties this requires:

**One absolute deadline, computed once** and shared across all stages of an acquire (RPM → TPM →
concurrency). Staging three independent `deadlineMs` timeouts would let total wait reach 3× the
configured bound.

**Dead waiters hold nothing.** On deadline expiry or abort, the waiter is spliced out of the queue
and its reservation released. A corpse holding a reservation is a slow-motion capacity leak.

**A hard queue-depth cap** (`maxQueuedWaiters`) rejecting synchronously past it. Per-waiter deadlines
alone bound queue depth only to arrival-rate × deadline; under sustained overload that is unbounded
in the dimension that matters. Failing fast beats a queue in which everyone times out anyway.

**Aborts must dequeue.** `tts-service.ts:79` already threads an `AbortSignal` and barge-in
(`:41-45`) aborts the superseded reply. A superseded reply must surrender its queue place
immediately, or repeated interruption fills the TTS queue with work nobody is listening to.

## 5. Per-provider policy

### 5.1 AssemblyAI STT — bucket on connect, plus a cost guard

Primary: `TokenBucket(STT_SESSIONS_PER_MIN)` acquired before `await transcriber.connect()`
(`assemblyai-stt-provider.ts:62`). Sized to the plan tier; note AA auto-scales the ceiling +10% per
minute above 70% utilization with no documented cap, so a conservative local value costs little.

Secondary, **cost not quota**: an optional `Semaphore(STT_MAX_CONCURRENT_SESSIONS)`. AssemblyAI
bills on **socket-open time**, not audio sent, and auto-closes at 3 hours. A leaked socket therefore
bills three hours of silence. This makes explicit teardown mandatory rather than hygienic.

**Release must be idempotent and wired to every exit** — this is the worst failure mode in the
design, because a leaked permit is permanent and monotonically strangles the restaurant. There are
**five** exits, and this numbering is authoritative: the class comment on
`AssemblyAiSttProvider` uses the same five, in the same order.

1. `stop()` — normal flush
2. `close()` — disconnect teardown (also how a stream whose caller went away is retired)
3. the `'close'` event handler — **the guard for a socket that died on its own**
4. the `'error'` event — a socket that errors need not go on to fire `'close'`, and the voice layer
   marks the session `failed`, after which `stopSession` early-returns and never calls `stop()`.
   Without a release here the permit is pinned for the socket's lifetime.
5. **anything thrown while opening** — `connect()` rejecting on a failed handshake, but also the
   transcriber factory and the `.on()` registrations, which run between the reservation and the
   handshake; a throw there leaks the permit *and* spends the session token for a socket that never
   existed. All of that sits inside ONE guarded region in `openStream`, which is why these are one
   exit and not two.

Paths 1 and 3 both fire on a normal stop, and 4 then 3 on a dying socket, which is precisely why
release must be idempotent. Paths 1 and 2 release from a `finally`: nothing retries a teardown, so a
throw out of `forceEndpoint()` or `close()` must not be able to skip it.

**A sixth path is owned by the voice layer, not the adapter.** A session removed or superseded
while its `openStream` is still in flight has no stream to close yet, so the adapter's exits are all
unreachable: the stream resolves onto an object no longer in the registry and the permit becomes
unreferenced. `VoiceSession` therefore carries a `retired` flag — `retire()` closes the stream and
bars any later attach, and `attachStream()` closes a stream that arrives after retirement instead of
storing it. Both race directions are covered. Eviction is by session *object*, never by id: a
failed open must not tear down the session that already replaced it. This matters because the
hands-free mic-restart pattern makes back-to-back `voice.start` a real client behaviour, and with a
permit attached an orphan is no longer a stray socket but permanent lost capacity.

Ordering caveat on 5: if the socket fires `'close'` *before* `connect()` rejects, the close handler
settles first and the later `abandon()` is a no-op under the lease's first-write-wins contract. That
is the right answer — a socket that closed did exist, so the provider counted the session — and the
permit comes back either way.

**Adaptation on refusal.** An over-limit refusal both settles its lease *and* calls
`penalize(nowMs() + retryAfterMs(err))`, exactly as the LLM path does.

AssemblyAI signals a streaming refusal with a **close code in its own application range, not the
WebSocket policy-violation 1008 and not an HTTP 429**. The codes that mean "over quota" are `4029`
(RateLimited), `4102` (TooManyStreams) and `3009` (ConcurrencyLimitExceeded); they mirror the SDK's
unexported `StreamingErrorType` and must be re-checked on an SDK bump. `4030`
(UniqueSessionViolation) is deliberately **excluded** — a session id already in use is our own bug
or a stale socket, not a quota state, so waiting does not fix it and the next caller (different id)
would be throttled for nothing.

Detection is by code, never by message text: the "Too many concurrent sessions" wording is a display
string and contradicts the limit actually enforced. The SDK rejects `connect()` with that code and
does *not* invoke the `'close'` listener, so the catch is the only place it can be seen. No
`Retry-After` accompanies a streaming refusal, so the floor is `RATE_LIMIT.penalty429Ms` in practice;
the `maxPenaltyMs` clamp still covers the REST-shaped 429, which can carry a header.

The floor is per-account and therefore shared by every session on the key — intended, since the
quota is per-account — and it **cannot ratchet**: a penalty stores an absolute instant rather than
accumulating, is always `now + ≤maxPenaltyMs` on a monotonic clock, and a further refusal is
unreachable until the current floor elapses (a refusal requires a grant, and grants are gated while
the floor holds). `penalize` touches only the rate buckets, never the concurrency semaphore, so
live sockets are unaffected — only new session creation is held back. Only over-limit refusals
penalize; auth, network and config failures say nothing about quota.

**The `'error'` exit closes the socket, not just the permit.** Releasing the permit fixes the leak
but not the bill: AA meters socket-open time and auto-closes only after three hours, so an errored
socket nobody drops bills silence until the client's next `voice.start` or disconnect. The handler
releases, marks the stream self-closing, fires a guarded `close(false)`, and only then calls
`onError` — teardown before the callback, so neither a throwing `close()` nor a throwing `onError`
can skip the other. Marking it self-closing is what stops our own teardown being re-reported as a
mid-speech drop, which would send the client a second, false `voice.error`.

**Degradation:** `openStream` rejects; `voice-message-handler.ts:116-131` already handles that —
removes the orphaned session, logs, sends `voice.error`. Add a distinct reason `stt_busy` with a
truthful message ("we're a bit busy — try again in a moment"). `VoiceErrorMsg.reason` is a free
string (`realtime-message-types.ts:108`), so no contract changes. No session is created, no
transcript is produced, the cart is untouched.

### 5.2 Cartesia TTS — semaphore only

`Semaphore(TTS_MAX_CONCURRENT)` acquired inside `synthesize`, released in `finally`, signal-aware.
The permit is held for the whole request, so the request needs a deadline of its own
(`TIMEOUTS.ttsRequestMs`) composed with the caller's barge-in signal: barge-in only fires on
supersede/disconnect, so without it a stalled call retires a slot for the SDK's own default (1 min ×
2 retries) — on the 2-context Free plan, two of those silence every later reply.
**No RPM bucket** — Cartesia publishes no request-rate limit, and a speculative one would throttle
below a limit that does not exist. Their only volume dimension is the monthly credit balance
(~1 credit/character), which is a budget, not a rate, and belongs in billing alerts rather than in a
limiter.

**Degradation:** `synthesize` throws → `tts-service.ts:80-91` already catches, emits `tts.error`,
logs `tts.synthesis_failed`. The reply **text** was already sent by the gateway
(`realtime-gateway.ts:43-48`) *before* `speak` is called at `:50`, so the degraded experience is
**the customer reads the reply but does not hear it**. That is the correct degradation and needs no
new event.

The `signal.aborted` re-check at `tts-service.ts:81` sorts the two kinds of limiter rejection, and
the direction is the opposite of what an earlier draft of this section claimed. An acquire aborted
by barge-in rejects *with the signal already aborted*, so the check returns and the customer hears
nothing extra — correct: the reply it belonged to has been superseded, and a `tts.error` for it
would be noise. A rejection on the **deadline** leaves the signal unaborted, falls through to the
error branch, and is reported. Silent for a supersede, loud for a genuine capacity failure.

### 5.3 OpenAI-compatible LLM — dual bucket, reserve then reconcile

RPM and TPM buckets. Token cost is unknown before the call, so the TPM bucket is driven in two
phases: reserve an estimate before `create()`, reconcile against `usage` after. `usageOf`
(`openai-compatible-provider.ts:185-200`) already yields `totalTokens` — reuse it.

**The reservation must cover the whole call, not the larger half of it.** A completion's real cost
is `prompt + completion` — the two are summed, never alternatives. The rule:

> Reserve `estimated input tokens + LLM_MAX_OUTPUT_TOKENS_EST` (additive). On reconcile, only
> *increase* the charge when actual exceeds the reservation (`forceTake`, allowed to drive the
> bucket negative — an honest representation of "already overspent", which drains at the quota
> rate). Never refund below the original reservation basis.

An earlier draft of this document specified `max(...)` of the two, quoting OpenAI's "maximum of
`max_tokens` and the estimated number of tokens" wording. That is wrong here for two reasons. First,
**we do not send `max_tokens`**, so no parameter of ours is the ceiling that sentence is about.
Second, `max` reserves nothing at all for the reply whenever the prompt dominates — which is *every*
agent step in this codebase (~4,303 fixed prompt tokens against an 800-token reply). Reconciliation
does repair the arithmetic, but only once the response is back; every call dispatched in the
meantime was admitted against capacity that was already spoken for, and that window is exactly when
the 429 lands.

The no-refund half of the rule stands: providers assess before generation and issue no refund when
the response comes in short, so a limiter that refunded locally would be more permissive than the
provider it protects. Refunds remain correct for the *concurrency* and *RPM* dimensions, and for the
abandon path (§6).

The corollary changes shape accordingly. `LLM_MAX_OUTPUT_TOKENS_EST` is a **modelled** output
ceiling, not a request parameter: `max_tokens` is deliberately left off the request, because
truncating a reply that ran long is a worse failure than over-reserving, and the variable defaults
to a non-zero value that would otherwise start capping every deployment silently. Since the
reservation basis never shrinks, an oversized value burns *our own* throughput on every call — set
it near the expected reply size. Spoken replies are short, so that is still a real and free win.

For the same reason the classifier gets **its own** `INTENT_LLM_MAX_OUTPUT_TOKENS_EST` (default 32),
and it is the one `INTENT_LLM_*` var that deliberately does **not** fall back to its `LLM_*` twin.
Every other one describes the operator's *plan*, which is genuinely shared when the creds are; this
one describes the size of *our* prompt's reply, and the classifier's entire reply is
`{"intent":"service"}` — about ten tokens. Inheriting the agent's 800 would reserve ~80× the real
cost on the bucket the two adapters share by default, throttling the parser against tokens the
classifier never spends.

**Estimation** should be `ceil(chars / 4)` plus a per-message envelope — not a real BPE tokenizer.
`gpt-tokenizer` is a devDependency used only by `scripts/estimate-prompt-tokens.ts`; putting a BPE
table in the hot path to refine a number that reconciliation corrects anyway is not worth it.

**Guard: estimate larger than the whole bucket.** `docs/llm-prompt-cost-estimate.md` records ~4,303
fixed tokens per agent step before any scratchpad. On a small plan that can exceed the entire
per-minute budget, and an unguarded waiter would then hang to its deadline *every single time*.
Clamp the request to capacity and warn once per limiter, so it degrades to "wait one refill period".

**Shared-quota hazard.** `createLlmProvider()` and `createIntentLlmProvider()` build two adapters,
and `env.ts:118-122` makes every `INTENT_LLM_*` var fall back to its `LLM_*` twin. In the default
configuration both point at the **same account, same model, same quota** — two independent limiters
would silently grant 2× the real quota. Limiters must therefore be keyed on **quota identity**
(`provider | baseUrl | apiKey | model` — the vendor namespace keeps STT/TTS/embedding, which key on
an api key alone, from collapsing onto one bucket when those keys match or are both unset) from a
shared registry, so shared credentials share one bucket by
construction and genuinely separate deployments get separate buckets.

**Degradation:** agent-LLM timeout propagates through the existing failure path
(`order-understanding-service.ts:50-57` → `voice.session_failed` → `voice.error`), cart untouched.
Map `RateLimitTimeoutError` to a distinct reason `llm_rate_limited` so the cause is diagnosable
rather than folded into the generic parse failure. Intent-LLM timeout needs **no change**:
`classify-intent.node.ts:19-22` already catches any throw and degrades to `service`, so the junk gate
is skipped and the turn proceeds — the never-drop-an-order invariant holds for free.

### 5.4 Jina embeddings — dual bucket, self-owned backoff

RPM and TPM buckets around `post()`. Jina publishes **nothing** about its 429 body shape and returns
no `x-ratelimit-*` or `Retry-After` headers on observed responses, so the client must own its backoff
schedule entirely: read `Retry-After` **opportunistically**, with a fallback that is always used in
practice, and never make any behaviour *depend* on the header being there.

**The retry has to actually back off.** `post()` retries once on 429/5xx/network. Re-issuing at the
same instant against a key that just said stop is the burst `penalize` exists to prevent, so the
retry waits: `RATE_LIMIT.retryBackoffMs` by default, or the parsed `Retry-After` when one arrives,
capped at `RATE_LIMIT.maxRetryBackoffMs`. The cap is deliberate — that wait sits inside a live
turn's latency budget, so a multi-second `Retry-After` cannot be honoured here. It is honoured by
`penalize`, which floors the next grant on the buckets for *every later caller* rather than blocking
this one.

**The retry is exempt from the penalty it just installed, and that is deliberate.** `post()` runs
*inside* `limiter.run`, so its second attempt never re-enters the buckets — the floor `penalize`
sets on the 429 gates the next *logical* call, not this one's retry. Only `retryBackoffMs` (or the
clamped `Retry-After`) holds the retry back. Two reasons to keep it that way: re-acquiring
mid-request would double-count the reservation for one logical call, and it would make a single
embedding lookup subject to two independent wait deadlines inside one turn. The cost is that the
retry is the one request that can cross the floor — bounded at exactly one extra request per
logical call, since `MAX_RETRIES = 1`.

**A 429 must survive a later attempt failing.** The status carried onto the thrown error is sticky
across attempts and 429 outranks anything else, because the commonest production shape is a
rate-limited key whose retry then trips the request timeout. If the network failure cleared the
status, the error would reach the limiter looking like a call that never happened and the whole
reservation — the request Jina counted included — would be refunded (§6).

Its quota is **shared across all Jina products** on one key, so if the reranker or reader endpoints
are ever adopted they compete with embeddings for the same budget and must share the limiter.

Degradation is the mildest of the four: `src/menu/candidate-matcher.ts:72` throws up through
`search_menu` and `run-tools.ts` converts it into a retriable tool error the agent sees, bounded by
`LIMITS.maxAgentSteps`. The agent can search again or ask. That conversion is `executeToolCall`'s
try/catch: without it the throw escapes the graph node, kills the whole turn, and — because
`order-understanding-service.ts` maps any `RateLimitTimeoutError` to `llm_rate_limited` — reports an
embedding saturation as an LLM quota problem. The tool error is tagged `rate_limited` on the
`order.agent_tool` line so the two stay distinguishable, and its text names the saturated tool and
tells the agent not to repeat that call.

**That catch is filtered, and must stay filtered.** It converts failed *tool/IO* calls — a
`RateLimitTimeoutError`, an HTTP status, a socket `code` anywhere in the `cause` chain. A
programming error (`TypeError`, `RangeError`, `ReferenceError` with no transport evidence)
propagates instead, because swallowing one is strictly worse than the crash it replaces: it is
logged at WARN as a routine bad tool call, replayed to the model up to `maxAgentSteps` times, and
finally kills the turn as `agent_step_limit` — a reason that describes nothing about the fault and
points every operator at the model. The `cause`-chain check is what keeps `TypeError: fetch failed`,
the shape `fetch` reports every network failure in, on the retriable side.

### 5.5 Odoo — out of scope

`src/odoo/*` gets no limiter. It is a self-hosted first-party addon, not a metered third party:
no quota to protect, no 429 to respect, no per-token billing. Its failure mode is worker-pool
exhaustion, which is a server-side capacity problem. The seam is identical if that changes.

## 6. Who owns 429

Ownership is split and non-overlapping:

- **The SDK stays the sole reactive handler.** `maxRetries: LIMITS.llmTransportMaxRetries`
  (`openai-compatible-provider.ts:52`) already honours `Retry-After` with backoff. Do not add a
  second retry loop; two retry layers multiply into 3×3 attempts against a provider that is already
  saying stop.
- **The local limiter is purely proactive shaping.** It reserves once per *logical* call, outside the
  SDK's retry loop.

**One reservation per logical call means RPM systematically UNDER-books.** Every retry loop in the
system sits *inside* a single reservation, so the provider counts attempts the limiter counted once:

| Retry loop | Attempts per reservation | Provider-counted requests |
|---|---|---|
| OpenAI SDK `maxRetries: LIMITS.llmTransportMaxRetries` (3) | up to 4 | up to 4× the RPM booked |
| Jina `post()` `MAX_RETRIES = 1` | up to 2 | up to 2× |
| AssemblyAI `connect()` `maxConnectionRetries: 2` | up to 3 | up to 3× |

This is an accuracy trade-off, not a safety property, and it is worst exactly when it hurts most:
retries only fire when the provider is already failing or 429ing, so the skew peaks during a storm.
It is accepted for v1 for three reasons. The alternative — a `forceTake(1)` per retry — would need
a hook into each SDK's retry callback that only the OpenAI client actually exposes; TPM, the
dimension that binds first on the LLM, is reconciled from real `usage` and so is unaffected; and
`penalize` already applies a much larger correction on the 429 that provokes the retries. The
honest summary is: **RPM is a floor on what we spend, not a ceiling.** Size `LLM_RPM` with that in
mind, or drop the SDK's `maxRetries` to 0 and let the limiter's own back-off carry the load.

**Adaptation.** A terminal 429 is proof the estimate was wrong, so it should feed back:
`penalize(now + retryAfterMs(err))` sets a next-grant floor on the buckets. It deliberately does not
*drain* them — draining conflates the rate dimension with the penalty dimension. The next caller then
waits and most likely trips its own deadline into graceful degradation, rather than piling further
429s onto a provider that is already rejecting us. This matters because OpenAI documents that
**failed requests still count against the limit** — a retry storm compounds itself.

Two consequences the code must encode:

- **Arrival, not rejection-for-rate, decides settle vs. abandon.** A 429 settles its lease — but so
  does every other failure the provider *received*: a 500, a terminal 400, an
  `APIConnectionTimeoutError` raised after the body went out. All of them were transmitted and
  counted, and refunding them would make the limiter strictly more permissive than the pool it
  protects, precisely while that pool is under strain.

  The code cannot always *know* which side of the wire a failure happened on, so the rule is
  fail-**closed** and states in one sentence: **abandon only what provably never left this process**
  (`reachedProvider`, `src/ratelimit/arrival.ts`). An HTTP status — any status, read through the
  `cause` chain `fetch` hides it behind — proves arrival. A connection-establishment code proves the
  opposite; the set is exactly `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`,
  `ENETUNREACH`, `ERR_SOCKET_CONNECTION_TIMEOUT` (undici's CONNECT-phase timeout, distinct from its
  request and body timeouts), and `rate_limited` — our own limiter refusing to dispatch the call at
  all. Everything else keeps its charge.

  The asymmetry is what settles the ambiguous middle. Over-charging a call that never arrived costs
  a little local throughput, and the bucket refills it inside the metering window. Under-charging
  one that did arrive is permanent and compounding, and it happens exactly when the provider is
  already rejecting us — it is how a limiter manufactures the 429s it exists to prevent.
  `ECONNRESET` and `ETIMEDOUT` are deliberately *not* on the never-arrived list: both also occur
  mid-request, and a timeout at a multi-second request deadline has almost always already sent the
  body (connect failures surface far faster).
- **`Retry-After` is clamped at both ends** (`RATE_LIMIT.maxPenaltyMs`). A penalty only ever
  *extends*, so one absurd header — `Retry-After: 86400`, or a far-future HTTP-date — would
  otherwise take the provider out for the lifetime of the process. The lower end matters just as
  much and is subtler: `Date.parse` is not a validity test. V8 reads `-5` as a year and `12-25` as a
  month-day, returning real timestamps decades in the past, so an unparseable header clamped to a
  **zero** penalty — `penalize(now + 0)`, a no-op — on the one signal proving our estimate was
  wrong. The date branch is therefore gated on the value looking like an RFC 7231 HTTP-date (all
  three forms begin with a weekday name) before `Date.parse` is trusted, and `0` stays reserved for
  a genuine date that has already elapsed. Anything else falls back to `RATE_LIMIT.penalty429Ms`.

STT is the highest-value hook: AssemblyAI's primary metered dimension is new-sessions-per-minute,
which is precisely what an over-limit close code refuses (§5.1).

Jina is the cleanest hook: `jina-embedding-service.ts:127` already has `res.status` and headers in
hand at the 429 branch.

## 7. Configuration

**Quota in `env.ts`, algorithm in `constants.ts`.** Quota is a function of the provider *plan* the
operator bought, so it is per-deployment; `constants.ts` is "tunables drawn from the design".

**Every limit defaults to `0`, meaning unlimited.** With all limits zero the registry returns a
shared no-op limiter with no allocation and no timers, so the change **ships dark** and is enabled
per deployment. This is also what keeps the existing test suite green without a single limiter stub.

Wait deadlines differ by call site because their latency budgets differ: TTS ~800 ms (mid-reply),
LLM ~1,500 ms, STT ~2,000 ms (once per session, not per turn), embeddings ~1,000 ms. A deadline is
therefore passed **per acquire** (`AcquireOptions.deadlineMs`) and is deliberately **not** part of
`RateLimits` or of limiter identity: two call sites that share one quota pool — the parser and the
intent classifier on the same creds, which is the default — must each keep their own budget, with
no `limits_conflict`. Only rpm/tpm/maxConcurrent may conflict, because only those are the quota.

Add a `# Rate limiting` section to `.env.example` documenting `0 = unlimited` plus recommended values
per plan tier. `.env.example` must stay **plain dotenv** — `cp .env.example .env` is the documented
starting point, and the file was for a while wrapped in a markdown ```` ```dotenv ```` fence that
made it unusable that way. `env-example.test.ts` now asserts every line is a comment or a
`KEY=VALUE`, and that two values whose env fallbacks differ actually reach `config`.

**Integer syntax is plain decimal digits, nothing wider.** `env.ts`'s `int()` rejects anything that
is not `/^\d+$/` — a fraction or a negative is always a typo for a count/port/duration, and bare
`Number` coercion is far wider than a dotenv value ever is (`0x10` → 16, `1e3` → 1000, `' 5 '` → 5,
`+7` → 7). Obeying those silently would set a quota the operator never wrote, and for a rate limit
the wrong number is worse than none: `0` here means *unlimited*. A rejected value is reported as
`config.invalid_int` and the default is used.

**Do not hardcode vendor numbers as authoritative.** Jina's product page and docs portal publish
*contradictory* TPM figures (2M/50M vs 1M/5M), and OpenAI **no longer publishes** a concrete RPM/TPM
tier matrix at all — every specific figure circulating online for it is third-party. Both should be
read from the respective dashboards into env vars.

## 8. Observability

Match existing conventions — per-op lines DEBUG (like `event.emit`), failures WARN (like
`llm.call_failed`, `tts.synthesis_failed`):

- `ratelimit.waited` — DEBUG, only when `waitedMs > 0`
- `ratelimit.rejected` — WARN, with `reason: deadline | queue_full | aborted`
- `ratelimit.penalized` — WARN; the estimate-was-wrong signal, emitted **only when a rate bucket
  actually took the floor**
- `ratelimit.penalty_unavailable` — WARN; the same refusal arriving at a limiter with **no rate
  dimension to floor** (concurrency-only config, e.g. `STT_MAX_CONCURRENT_SESSIONS` set with
  `STT_SESSIONS_PER_MIN=0`). A penalty is a rate instrument, so there is nowhere to apply it and
  **no back-off is in force**. Emitting `ratelimit.penalized` here would report an absorbed refusal
  that was not absorbed at all; the operator's fix is to configure the rate dimension.
- `ratelimit.cost_exceeds_capacity` — WARN, once per limiter
- `ratelimit.limits_conflict` — WARN; two call sites disagreeing about ONE quota. Carries
  `shaped`, which is `false` when the winning (first) configuration capped nothing — see §9.
- `ratelimit.configured` — INFO at boot; operators need to see what actually took effect

Reconciliation rides the **existing** `llm.usage` line (extend `logUsage` with `rate_limit_wait_ms`
and `estimated_tokens`) rather than adding a line. One record per call, with estimate error directly
queryable against `total_tokens` on the same row.

## 9. Known limitations

**Turn-level latency amplification.** The agent loop makes up to `LIMITS.maxAgentSteps = 8`
sequential `chat` calls, each acquiring independently — worst case 8 × the LLM wait deadline. At the
1,500 ms default that is 12 s, which is unacceptable for live voice, though realistic step counts are
2–3. Accepted for v1 with a low default; the fix is a per-turn deadline threaded through `GraphDeps`.
The same amplification applies to embeddings via repeated `search_menu`.

**Ollama enforces nothing.** If `LLM_BASE_URL` stays pointed at Ollama there is no quota to respect:
no rate limiting, no `x-ratelimit-*` headers, no auth. Its real backpressure is
`OLLAMA_NUM_PARALLEL` — **default 1**, which serializes turns — and a `503` past a 512-deep queue.
A limiter keyed off rate-limit headers must degrade gracefully to "no headers" rather than assume
either unlimited capacity or a 429 contract. Ollama also reports no `usage`, so reconciliation must
treat missing usage as "estimate stands" rather than stalling.

**Single process, in-memory.** Limits are per-instance; N replicas grant N× the quota. The seam is
`TokenBucket`/`Semaphore` behind the limiter facade — a cross-replica version replaces exactly those
two classes with Lua-backed equivalents against the existing `src/redis/` client, leaving the facade
identical. `async-lock.ts` and `cart-turn-queue.ts` already carry the same "in-memory only — shard to
scale out" caveat.

**Strict FIFO can let a large agent call delay a small intent call.** Small-first scheduling would
invert the harm onto the call that actually serves the customer, so FIFO stands. The mitigations are
configuration (point `INTENT_LLM_*` at separate credentials for a separate bucket) and the fact that
intent degradation is free.

`.env.example` deliberately does **not** do this: it ships every `INTENT_LLM_*` var commented out, so
the classifier reuses the main provider and both adapters share ONE bucket. Splitting them is safe
only when `INTENT_LLM_RPM`/`INTENT_LLM_TPM` are set explicitly too — the fallback copies the `LLM_*`
numbers by value, so a classifier on a different model silently receives a second, full copy of the
budget, and no `limits_conflict` fires because the two limiters are genuinely distinct quotas.

**First-writer-wins can resolve a shared pool to NO shaping at all.** The inverse of the 2× hazard
above, and it is not symmetric with the ordinary conflict. On one identity, `LLM_RPM=0` with
`INTENT_LLM_RPM=500` registers `llm` first with nothing capped — which is the *shared* `NO_LIMIT`
passthrough — and `intent-llm` then gets that same passthrough back. The operator asked for shaping
and got none. First-writer-wins is kept anyway: the registry's guarantee is **one quota identity, one
limiter**, and upgrading in place would either strand queued waiters under limits they were never
admitted against or hand the two adapters *different* limiter objects for one pool, which is exactly
the state the registry exists to prevent. The mitigation is reporting, not repair — the
`ratelimit.limits_conflict` line carries `shaped: false` when the surviving configuration capped
nothing, so "we picked one of two caps" and "no cap survived" are distinguishable at a glance, and
`ratelimit.configured` shows the same per identity at boot. Rule for operators: **shared creds ⇒ set
the same numbers on both sides, or leave both unset.**

**TTS concurrency is consumed per segment.** Until TTS moves to a persistent Cartesia WebSocket
context, a multi-sentence reply competes with itself for slots. This is the highest-leverage
follow-up.
