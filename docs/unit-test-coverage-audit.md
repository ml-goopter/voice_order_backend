# Unit Test Coverage Audit

_Audit date: 2026-07-09. Test runner: vitest. Scope: every module under `src/`._

**Legend:** ✅ Covered · 🟡 Partial (has tests, real gaps) · 🔴 Untested (no test file) · ⚪️ Type-only / no logic

## By module

| Module | File | Status | Key gaps |
|---|---|---|---|
| **events** | `event-bus.ts` | ✅ | _Done 2026-07-10._ subscribe→emit delivery + order, `off`, event isolation, **no-error-isolation pinned** (a throw escapes `emit`), conditional correlation-logging |
| | `event-types.ts` | ⚪️ | type-only |
| **shared** | `async-lock.ts` | ✅ | thorough |
| | `errors.ts` | 🔴 | `messageOf`/`errorMeta`, AppError subclass `code`+`.name` via `new.target`, `CartRejectedError.reason` |
| | `ids.ts` | 🔴 | prefix+UUID shape per generator, uniqueness |
| | `result.ts` | 🔴 | `ok`/`err`/`isOk` shape + type-guard narrowing |
| | `time.ts` | 🔴 | thin wrappers, low value |
| **redis** | `cart-cache.ts` | ✅ | _Done 2026-07-10._ Redis path covered; `InMemoryCartCache` + `cartKey` now covered |
| | `redis-client.ts` | ✅ | _Done 2026-07-10._ singleton memoization, handler registration, `close` quit→disconnect fallback + no-client no-op |
| **realtime** | `realtime-gateway.ts` | ✅ | _Done 2026-07-10._ `cart.updated` multi-device broadcast, clarification option-omission, `cart.operation_rejected` targeting (3 branches), disconnect→voice cleanup, resume existing-vs-empty cart |
| | `client-registry.ts` | ✅ | _Done 2026-07-10._ cart-set lifecycle, empty-set cleanup (leak guard), multi-device fan-out, copy-on-read |
| | `message-router.ts` | ✅ | _Done 2026-07-10._ all routing branches incl. `order.clarification_answered`→bus + rejection propagation |
| | `realtime-message-types.ts` | ✅ | _Done 2026-07-10._ `parseInbound` — invalid JSON / non-object / null / unknown type / pass-through |
| | `websocket-server.ts` | ✅ | strong; minor heartbeat/route edges |
| **voice** | `voice-message-handler.ts` | 🟡 | STT `onError` mid-stream path, `pendingAudio` cap (200), mid-listening final |
| | `voice-session-manager.ts` | 🔴 | `remove` closes live stream before delete |
| | `voice-session.ts` | ⚪️ | data class |
| **ordering** | `parse-and-validate.node.ts` | 🟡 | `maxRepairs=0` boundary, repair-prompt args, exhaustion error identity |
| | `order-graph-output.schema.ts` | 🟡 | `needs_clarification:true`+null question must fail; option-key omission |
| | `graph/instrument.ts` | 🔴 | LangGraph bubble-up re-thrown **without** logging (breaks clarification if regressed) |
| | `order-understanding-service.ts` | ✅ | strong; missing `MAX_CLARIFICATION_ROUNDS` cap path |
| | nodes (normalize/parse-order/retrieve/validate), `schemas/zod-error.ts`, `register-handlers.ts` | 🔴 | direct unit tests |
| **cart** | controller / applier / validator | ✅ | thorough; narrow branch gaps (priced() batching, name fallback) |
| | `register-handlers.ts` | 🔴 | rejected `applyProposal` swallowed by `.catch` |
| **menu** | `candidate-matcher.ts` | 🟡 | **lexical-union recall** (headline feature) untested, fallback branches, score threshold + hybrid blend |
| | `in-memory-menu-store.ts` | 🔴 | reference double every matcher test trusts — cosine/knn top-k unverified |
| | `menu-service.ts`, `embedding-service.ts` | 🔴 | delegation / stub contract |
| | fuzzy / modifier / jina / menu-index / menu-store | ✅ | good; minor numeric/threshold edges |
| **llm** | `prompt-builder.ts` | ✅ | _Done 2026-07-10._ Covers the "keep full `available_modifiers`" invariant + clarification-block branches + repair prompt |
| | `openai-compatible-provider.ts` | ✅ | _Done 2026-07-10._ Missing-key throw, request mapping (temp 0, json_object), empty-content warn, rejection propagation |
| | `llm-client.ts` | ✅ | _Done 2026-07-10._ Provider factory (openai/ollama/stub) + stub proposal |
| **stt** | `assemblyai-stt-provider.ts` | 🟡 | subarray Buffer forwards only viewed bytes; connect-reject |
| | `stt-client.ts` | 🔴 | no-key→Noop fallback (silent-misconfig trap) |
| **platform** | `auth/session-auth.ts` | 🔴 | `pos_config_id:0` accepted (=== undefined vs truthiness), missing-field errors |
| | `config/env.ts` | 🔴 | non-numeric→fallback (not NaN), empty-string→unset |
| | `config/logger.ts` | 🔴 | level threshold gate, `child()` binding merge |
| | `observability/metrics.ts`, `app.ts`, `server.ts`, `api/health.routes.ts`, `auth/auth-types.ts`, `config/constants.ts` | ⚪️/N/A | no-op stubs / wiring / e2e territory — not worth unit tests |

## Top 12 highest-value missing tests (cross-module)

1. **`event-bus`** — subscribe→emit delivers exact payload to all handlers in order; `off` unsubscribes; **pin that a throwing handler propagates** (no isolation exists today — this is a latent surprise).
2. **`prompt-builder.buildPrompt`** — full `available_modifiers` preserved un-trimmed (guards the documented project invariant) + clarification block only when answer `!== undefined`.
3. **`ordering/graph/instrument.node`** — LangGraph interrupt/Command re-thrown *without* `order.node_failed` logging; a regression mislabels every clarification as a node failure.
4. **`candidate-matcher`** — lexical-union recall (KNN-miss + lexical-hit still surfaced) + the two `fuzzyScan` fallback branches. The module's headline feature is untested.
5. **`session-auth`** — `pos_config_id: 0` is accepted (=== undefined, not truthiness) + each missing field → `unauthenticated`.
6. **`realtime-gateway`** — `cart.updated` multi-device broadcast + `cart.operation_rejected` session-vs-cart-wide-vs-absent targeting.
7. **`voice-message-handler`** — STT `onError` mid-stream: status→failed, `voice.error stt_failed`, `voice.session_failed` emitted (whole branch undriven).
8. **`parseOrderGraphOutput`** — `needs_clarification:true` + null question must fail; empty `{}` applies defaults; option-key omission.
9. **`register-handlers`** (both cart & ordering) — rejected handler promise is caught/logged, never a silently-dropped turn.
10. **`openai-compatible-provider`** — missing-key throw + request mapping (`temperature:0`, `response_format: json_object`, message roles).
11. **`env.ts`** — non-numeric env → fallback (not NaN); empty-string treated as unset.
12. **`in-memory-menu-store`** — cosine math + knn top-k cutoff; the reference double every matcher test trusts is itself unverified.

## Structural flags to decide on

- **`event-bus` has no error isolation** — a throwing subscriber breaks the `emit` and later handlers don't run. Several modules rely on a `.catch` at the *handler registration* site to compensate. Confirm that's the intended design before tests simply document it.
- **`env.ts` / `logger.ts` bind config at import time** — meaningful tests need `vi.resetModules()` + `process.env` manipulation (or exporting the `str`/`int` helpers). Affects how those suites are structured.

## Per-module detail

### realtime
- `client-registry.ts` (🔴): `add`→`getBySession`; multi-device same `cart_id`→`getByCart` returns both; duplicate `session_id` overwrite semantics; `remove` empties cart set and deletes the cart entry (leak guard); one-of-two removal leaves the other reachable; remove-unknown no-op; `getByCart` returns a copy.
- `message-router.ts` (🔴): `voice.start/audio_chunk/stop` delegation (start/stop awaited, audio sync); `order.clarification_answered`→bus emit with mapped fields; `connection.resume`→no-op (gateway-owned); rejected `handleStart/Stop` propagates.
- `realtime-gateway.ts` (🟡): `cart.updated` broadcast to every socket on a cart / none when absent; `order.clarification_needed` single-session send with conditional `options`; `cart.operation_rejected` with/without `session_id` and absent-socket filter; `onConnect`/`onDisconnect` registry + `voice.handleDisconnect`; `handleResume` `?? emptyCart` fallback (version 0) vs existing cart; bad frame → `voice.error bad_message`.
- `realtime-message-types.parseInbound` (🟡): invalid JSON→null; non-object→null; `null` literal→null; unknown/missing `type`→null; each accepted type passes through.
- `websocket-server.ts` (✅): lower-priority heartbeat (dead-socket sweep, pong liveness), non-OPEN `send` no-op, `/healthz` alias, 404, `paramsFromUrl` NaN guard, `close()` teardown, pre-auth socket error caught.

### voice
- `voice-message-handler.ts` (🟡): `onError` mid-stream (status failed, `voice.error stt_failed`, `voice.session_failed`); `pendingAudio` cap at 200 (overflow dropped); mid-listening final (no `session_ended`, session stays live); final with no `language` omits the key; `handleAudioChunk` unknown/stopping/pre-open cases; `handleStop` no-stream early return; `handleDisconnect` preserves terminal status, clears `finalTimer`, unknown-session no-op.
- `voice-session-manager.ts` (🔴): `create`/`get` round-trip; duplicate overwrite; `remove` closes live `stream` then deletes; `remove` with null stream / unknown id no-op.
- `voice-session.ts` (⚪️): data class, no logic.

### ordering
- `normalize-transcript.node` (🔴): trim + collapse whitespace runs; tabs/newlines; empty/whitespace-only→`""`; no-op passthrough.
- `parse-order.node` (🔴): raw passthrough of `llm.complete`; called once with `buildPrompt(input)`.
- `parse-and-validate.node` (🟡): `maxRepairs=0`→throw immediately, one LLM call; valid-first→no repair; invalid→invalid→valid with cap 2; exhaustion throws *last* ValidationError; repair prompt carries prior raw + error; emits `order.schema_repair_retry`/`_exhausted`.
- `retrieve-candidates.node` (🔴): delegates to `menu.getCandidates` and returns `CandidateSet` unchanged.
- `load-cart.node` (🟡): `loadCart` hit vs `emptyCart` fallback (version 0); `buildCartView` empty cart + de-duped tmpl lookup; name fallback chain.
- `validate-operations.node` (🔴): invalid-JSON→`err(ValidationError('...not valid JSON'))` vs valid-JSON-bad-schema.
- `schemas/order-graph-output.schema` (🟡): defaults on `{}`; `needs_clarification:true`+null question fails; option-key omission/preservation; invalid op fails whole parse.
- `schemas/cart-operation.schema` (✅): add unknown-keys behavior; `update_quantity` negative/non-integer parity.
- `schemas/zod-error` (🔴): single issue `path: msg`; root `(root): msg`; multi-issue `; ` join.
- `graph/state` (🟡): empty `prev`; under-cap no truncation; **`cap=0`→`slice(-0)` returns full array (bug trap)**.
- `graph/instrument` (🔴): resolve passthrough; normal throw logs `order.node_failed` once + re-throws; **bubble-up (interrupt/Command) re-thrown WITHOUT logging**.
- `graph/build-graph` (🟡): clarify-vs-finalize routing; `ClarificationInterrupt` option omission; history recording; `toInput` optional-key omission.
- `order-graph` (🟡): `interpret` interrupt→clarify (option omission) vs complete; `start` language omission; thread id `${pos_config_id}:${cart_id}`.
- `order-understanding-service` (✅): missing `MAX_CLARIFICATION_ROUNDS`→`clarification_unresolved`; answer-with-no-pending logs and returns; non-LLM node fault→`order_parse_failed`.
- `register-handlers` (🔴): `stt.final_transcript.received`→`handleFinalTranscript`; `order.clarification_answered`→`handleClarificationAnswer`; rejection caught/logged.

### cart
- `cart-controller.ts` (✅): version-mismatch log branch with no items; `cart.updated` `pos_config_id`; throwing listener doesn't cause spurious `internal_error`; `confirm`/`applyProposal` share applyLock.
- `cart-operation-applier.ts` (✅): add_item name fallback past absent `en_US`; `priced()` tmpl dedup + summed subtotal; duplicate modifier_key in add_item; remove-to-empty reprices to 0.
- `cart-validator.ts` (🟡): valid `add_modifier`/`update_quantity` ok(void) no mutation; non-`line_gone` reason propagated verbatim.
- `register-handlers.ts` (🔴): `order.operations_proposed`→`applyProposal(proposal, session_id)`; rejected promise swallowed by `.catch`; omitted `session_id`→`undefined`.

### menu
- `fuzzy-matcher.ts` (🟡): Levenshtein value pinned (`coke`/`cola`≈0.75); multi-space normalization; substring symmetry.
- `modifier-matcher.ts` (🟡): threshold boundary (0.6); best score across multiple modifiers.
- `candidate-matcher.ts` (🟡): `chunk()` delimiters; empty transcript early return; empty-vector fallback; empty-retrieval fallback; **lexical-union recall**; hybrid score blend; SCORE_THRESHOLD exclusion; sort order; name fallback.
- `embedding-service.ts` (🔴): `StubEmbeddingService` empty vectors/dims 0; `createEmbeddingService` default/jina switch.
- `in-memory-menu-store.ts` (🔴): `cosine` cases; `knnSearch` top-k cutoff + best-per-item; `load` drops empty vectors; `lexicalSearch` substring-or-fuzzy threshold; `of()` items-only store; `getItemByKey` unknown→undefined.
- `menu-service.ts` (🔴): each method delegates to store/matcher; constructor default embedder.
- `jina-embedding-service.ts` (✅): missing retry-exhaustion + non-HTTP catch.
- `menu-index.ts` (✅): missing `dropMenuIndex` rethrow, already-exists race, schema-version rebuild.
- `menu-store.ts` (✅): missing `lexicalQuery` word rules, `getItems([])` short-circuit, KNN overfetch/top-k trim, malformed-JSON parse.

### llm
- `prompt-builder.ts` (🔴): `{system, user}` shape; system lists all ops from `cartOperationSchema`; **full `available_modifiers` un-trimmed**; user field mapping (`request_id`, `customer_text`, `history`→`conversation_history`, etc.); clarification block only when `!== undefined` (incl. `''`); `buildRepairPrompt` appends instruction + `PREVIOUS_INVALID_OUTPUT`/`VALIDATION_ERROR` while retaining base.
- `openai-compatible-provider.ts` (🔴): missing-key throw; SDK opts (baseURL/apiKey/timeout/maxRetries); `create` call (model, `temperature:0`, `response_format json_object`, system/user roles); content passthrough; empty-content warn+`''`; missing choices→`''`; rejection propagates; `name` getter.
- `llm-client.ts` (🔴): factory openai/ollama→`OpenAiCompatibleLlmProvider`, unknown→`StubLlmProvider`; stub returns valid empty proposal + warn.

### stt
- `assemblyai-stt-provider.ts` (🟡): subarray Buffer forwards only viewed bytes; `connect()` reject propagates; empty final-path guard; two-turn dedup; `close()` selfClosing→no onError; partial-after-final still onPartial; error-after-final still onError.
- `stt-client.ts` (🔴): assemblyai+key→`AssemblyAiSttProvider`; assemblyai+no-key→`NoopSttProvider`+warn; unknown→`NoopSttProvider`; noop stream behavior + `stop()`→`onError(stt_not_implemented)`.

### platform
- `config/env.ts` (🔴): `int` fallback on unset/empty/non-numeric (not NaN)/truncation; `str` fallback; `config` shape/defaults.
- `config/logger.ts` (🔴): below-threshold dropped; at/above emitted as single JSON line; unknown level→info; `child()` merge; base bindings.
- `auth/session-auth.ts` (🔴): all params→ok context; `pos_config_id:0`→ok (=== undefined); each missing field→`unauthenticated`; empty-string→err; exact message; token ignored.
- `api/health.routes.ts` (🔴, low value): `status:'ok'`, rounded `uptime_s`, ISO `ts`.
- Not worth unit testing: `observability/metrics.ts` (no-op stub), `app.ts` (composition root), `server.ts` (bootstrap/process side-effects), `auth/auth-types.ts` & `config/constants.ts` (type/data only).
