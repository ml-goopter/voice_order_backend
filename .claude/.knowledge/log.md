---
type: Log
title: Change Log
description: Chronological history of codebase changes (newest first).
timestamp: 2026-07-07
---

# Change Log

## 2026-07-14 — Notify client on server-initiated (idle) voice stop
- **What:** Added outbound WS message `voice.stopped` (`{ session_id; reason: 'idle' }`) and
  send it when the stopped-talking idle timer fires, just before `handleStop`. A client-sent
  `voice.stop` gets no echo. Reviewed existing outbounds first — none fit (`voice.final_transcript`
  is conditional/display, `voice.error` would mislabel a normal end-of-turn as a failure).
- **Why:** On a server-initiated stop the client had no signal that the backend closed the mic,
  so it couldn't drop its listening UI or stop capturing audio.
- **Where:** `realtime/realtime-message-types.ts` (new `VoiceStoppedMsg` + union),
  `voice/voice-message-handler.ts` (`armIdleStop` emit), `docs/design.md` §17.7, `voice` bundle.

## 2026-07-14 — TTS: standalone mp3 per sentence segment (progressive playback)
- **What:** Reworked TTS so each `tts.audio_chunk` is a **complete, standalone** audio file
  rather than a byte slice of one continuous mp3 stream. `TtsService` now splits the reply
  into ≈sentence segments (`segment-text.ts`) and synthesizes each as its own Deepgram request,
  emitting one chunk per segment as it completes. The `TtsProvider` contract changed from
  callback-streaming (`synthesize(text, handlers) → TtsSynthesis` with `onAudio`/`onDone`/
  `onError`) to one-shot `synthesize(text, signal) → Promise<Buffer>`; `DeepgramTtsProvider`
  drains the streamed body into one buffer. Removed `TtsStreamHandlers`/`TtsSynthesis`.
- **Why:** The frontend needs each chunk to be independently decodable/playable — mid-stream
  slices of a single mp3 aren't (Layer III bit reservoir). Per-segment synthesis yields an
  independent mp3 per sentence and lets the client play segment 1 while segment 2 synthesizes
  (low time-to-first-audio). Deepgram bills per character, so N requests cost the same as one.
- **Where:** `src/tts/` (`tts-types.ts`, `tts-service.ts`, `deepgram-tts-provider.ts`,
  `tts-client.ts`, new `segment-text.ts`, + tests); `realtime/realtime-message-types.ts` (chunk
  doc); `docs/text-to-speech.md`, `.claude/.knowledge/tts/overview.md`.
- **Notes:** Wire message shapes are unchanged (same `tts.*` types); only the *meaning* of a
  chunk changed (standalone file, not a stream slice) — a coordinated frontend/backend contract
  change. `seq` is now the segment index. Barge-in/cancel still per-session `AbortController`
  (now aborts the in-flight segment and halts the loop).

## 2026-07-14 — Cancel in-flight TTS on client disconnect
- **What:** Added `TtsService.cancel(session_id)` and call it from the Realtime Gateway's
  `onDisconnect` (next to the existing STT teardown). It aborts any in-flight synthesis for
  the session and drops the handle.
- **Why:** A client that dropped mid-reply left the Deepgram synthesis running — a paid
  request streaming frames into a closed socket — with no symmetric teardown (STT already
  cancelled on disconnect).
- **Where:** `src/tts/tts-service.ts`, `realtime/realtime-gateway.ts` (+ tests).

## 2026-07-14 — Stream TTS audio for spoken replies (Deepgram)
- **What:** New `tts` module. The Realtime Gateway now, on `order.reply`, both sends the reply
  text and drives `TtsService` to synthesize it via Deepgram Aura and stream the audio back over
  the same socket as new `tts.audio_start` / `tts.audio_chunk` (base64) / `tts.audio_end` /
  `tts.error` outbound messages. Provider abstraction mirrors STT (`TtsProvider` + factory +
  `NoopTtsProvider` fallback); Deepgram REST speak (`@deepgram/sdk`) streamed frame by frame with
  an injectable `SpeakFn`. Barge-in is cancel-previous-only (per-session `AbortController`).
- **Why:** Speak the agent's clarifying questions/recommendations to the customer, not just show
  them (`docs/text-to-speech.md`).
- **Where:** `src/tts/` (new); `realtime/realtime-gateway.ts`, `realtime/realtime-message-types.ts`,
  `app.ts`, `config/env.ts`, `.env.example`.
- **Notes:** Config `TTS_PROVIDER` (default `deepgram`), `DEEPGRAM_API_KEY`, `TTS_MODEL`
  (`aura-2-thalia-en`), `TTS_ENCODING` (`mp3` default), `TTS_SAMPLE_RATE` (linear16 only). New dep
  `@deepgram/sdk`. Frontend contract documented in `../shared/docs/frontend-integration-guide.md`.
  Full barge-in on `voice.start` remains out of scope.

## 2026-07-14 — Unify turn-failure logging under `order.turn_failed`
- **What:** `order-understanding-service.ts` `dispatch()` now logs the `fail` outcome as
  `order.turn_failed` (with `reason`) instead of `order.agent_no_terminal`. The event name is now
  the same for every failure mode (node throw → `order_parse_failed`, and the agent loop's
  `agent_step_limit` / `agent_no_terminal`); the `reason` field distinguishes the cause.
- **Why:** Code-review finding — the old name mislabeled step-limit and node-throw failures as
  "no terminal", muddying observability.
- **Where:** `ordering/order-understanding-service.ts`.

## 2026-07-13 — Embed the propose_cart operation JSON Schema in the agent system prompt
- **What:** `agent-prompt-builder.ts` now generates a JSON Schema from `cartOperationSchema`
  (`z.toJSONSchema` + a `scrubSchema` pass that drops zod's sentinel `maximum` and `$schema`) and
  embeds it in the system prompt as the exact per-operation shape for `propose_cart`.
- **Why:** Give the model the precise structural contract (fields/types/required per action),
  derived from the source of truth so it can't drift from validation. It complements — does NOT
  replace — the prose KEY RULES, which still carry the semantics a schema can't express (key
  provenance, inline-modifier rule, matching a cart line by name).
- **Where:** `llm/agent-prompt-builder.ts`. Knowledge: `llm/overview.md`.
- **Notes:** The `propose_cart` tool spec `parameters` stays intentionally loose; the contract
  lives in the system prompt per the existing design.

## 2026-07-13 — Agent-loop review fixes (step budget, empty-propose guard, emit safety, dead config)
- **What:**
  - `LIMITS.maxAgentSteps` 4 → **8** so a model that searches one item per turn can still finish a
    multi-item order before the loop bails (`agent_step_limit`).
  - `run-tools.ts` `propose_cart` now rejects an **empty/absent `operations`** list as a retriable
    tool error instead of validating it to an empty proposal (`operations` defaults to `[]`, which
    previously let a malformed call silently "succeed" and drop the customer's request).
  - `order-understanding-service.ts` restructured: `runTurn` now returns the full `GraphTurnResult`
    (mapping a node throw to `{status:'fail'}`) and a new `dispatch` emits the outcome **outside**
    the try/catch — so a throwing event subscriber can't be swallowed and re-reported as a turn
    failure (double-emit). Previously only the proposal was emitted outside; reply/fail were inside.
  - Removed dead `LIMITS.llmMaxRetries` (its consumer, the old schema-repair loop, was deleted).
- **Why:** Findings from the post-rework code review (correctness + robustness + cleanup).
- **Where:** `config/constants.ts`, `ordering/tools/run-tools.ts`,
  `ordering/order-understanding-service.ts`, plus tests. Knowledge: `ordering/overview.md`.
- **Notes:** New tests — empty-`propose_cart` loops then proposes; step-limit test now keys off
  `LIMITS.maxAgentSteps` so it can't drift. NOT addressed: the loss of structured recommended-item
  keys in history (a deliberate rework tradeoff — follow-ups resolve via re-search) is left as-is
  pending a product decision.

## 2026-07-13 — Fix: preserve provider tool-call payload so Gemini agent loop doesn't 400
- **What:** `ToolCall` now carries an opaque `raw` field holding the provider's original
  tool-call object; `parseToolCall` stashes it and `toOpenAiMessage` replays it VERBATIM
  instead of rebuilding `{id,type,function}` from `id`/`name`/`arguments`. The
  tool-calls-only assistant turn also now OMITS `content` (was `content: null`).
- **Why:** Gemini 3.x attaches a `thought_signature` to every function call that its
  OpenAI-compatible endpoint requires echoed back on the follow-up request; rebuilding the
  call dropped it, so the SECOND `chat()` (the first to replay an assistant tool-call turn)
  failed with a bare `400`, ending every multi-step turn as `voice.session_failed`. The
  agent loop could never take more than one step against Gemini.
- **Where:** `llm/llm-provider.ts` (ToolCall.raw), `llm/openai-compatible-provider.ts`
  (`parseToolCall`, `toOpenAiMessage`), `llm/openai-compatible-provider.test.ts`.
- **Notes:** Root cause isolated by replaying against the live endpoint — verbatim replay
  succeeds, rebuilt call 400s regardless of `content` (null vs omitted). `raw` stays opaque
  to the rest of the system; only the producing provider reads it.

## 2026-07-13 — Agent tool-calling: graph rework replaces the pipeline (Phase 2)
- **What:** Replaced the fixed `retrieve → parse → suggest` order pipeline with an LLM
  **agent tool-calling loop** (`normalize → classify → load_cart → agent ⇄ tools → finalize`).
  - `classify` demoted to a **junk-gate**: `order` and `suggest` both route to `load_cart` →
    `agent`; `junk` → END. Force-order next turn now keys off the prior turn's `agent_reply`.
  - Two tools (`ordering/tools/`): `search_menu_semantic` (wraps `menu.getCandidates`) and
    `propose_cart` (validates against the zod output schema; a failure is a repair-friendly
    tool error retried within `LIMITS.maxAgentSteps` = 4). New `llm/agent-prompt-builder.ts`.
  - **Clarify and suggest merged into one `reply` outcome**: the agent ends a turn either by
    calling `propose_cart` OR by replying with plain text (no tool call). The spoken reply is
    fire-and-forget. New event **`order.reply`** replaces `order.clarification_needed` +
    `order.suggestion_ready` (updates the WS gateway + `realtime-message-types`). **This changes
    the client-facing WS protocol.**
  - New turn-scoped state channels (`agent_messages`, `agent_steps`, `failure_reason`, `reply`),
    all cleared in `normalize`; `GraphTurnResult` is now `complete | reply | junk | fail`.
  - **Dropped the consecutive-clarification cap** (`maxClarifications`, `clarification_unresolved`,
    `trailingClarificationRun`) — a merged reply outcome shouldn't cap multi-turn conversations;
    within-turn runaway is bounded by `maxAgentSteps`.
  - **Deleted** `retrieve-candidates`/`parse-order`/`parse-and-validate`/`validate-operations`/
    `suggest` nodes, `prompt-builder`, `suggestion-prompt-builder`, `suggestion.schema`; simplified
    `order-graph-output` to operations-only and removed the orphaned `OrderGraphInput` type.
  - Migrated `order-understanding-service.test.ts` (reply outcome, force-order, propose retry,
    step-limit fail), `realtime-gateway.test.ts`, `state.test.ts`, `intents.test.ts`.
- **Why:** Let the model drive retrieval and decide the outcome, per docs/agent-tools.md — and,
  per follow-up, express clarify/suggest as a plain spoken reply rather than as tools.
- **Where:** ordering (`src/ordering/`), llm (`src/llm/agent-prompt-builder.ts`), events, realtime,
  config.
- **Notes:** Production now requires a tool-capable model (stub scripts tool calls for tests).
  Prompted-ReAct fallback for weak models is still deferred.

## 2026-07-13 — Agent tool-calling: provider `chat()` (Phase 1)
- **What:** Added native tool-calling to the LLM provider abstraction. New types in
  `llm-provider.ts` (`ToolSpec`, `ToolCall`, `AgentMessage`, `ChatResult`) and a
  `chat(messages, tools)` method on `LlmProvider`. Implemented `chat` in
  `OpenAiCompatibleLlmProvider` (maps `AgentMessage[]`/`ToolSpec[]` onto the OpenAI
  `tools` API, parses `tool_calls` with JSON-decoded arguments, malformed args → `{}`).
  `StubLlmProvider.chat` replays an optional scripted `ChatResult[]`. Added provider
  `chat` unit tests; added throwaway `chat` stubs to the three existing test fakes so
  the widened interface still compiles.
- **Why:** First phase of the agent-tools rework (`docs/agent-tools.md`) — turn the
  passive `retrieve → parse` pipeline into an LLM agent that drives retrieval by
  calling tools. Phase 1 is provider plumbing only; no graph/behavior change yet.
- **Where:** llm module (`src/llm/`).
- **Notes:** `complete()` is unchanged and still used by the parser/classifier. No
  agent graph yet — that's Phase 2 (agent/tools nodes, delete `retrieve`/`parse`/
  `suggest`). Pre-existing 2 failures in `order-understanding-service.test.ts`
  (consecutive-clarification cap) are unrelated to this change.

## 2026-07-13 — Remove Redis code from the menu module
- **What:** Deleted `RedisMenuStore`, the RediSearch index (`menu-index.ts`), and their
  tests. Reduced `menu-store.ts` to just the `MenuStore` interface; dropped the now-unused
  Redis-only helpers (`toMenuItem`/`toCandidateModifier`/`lexicalQuery`/`Stored*`/key
  builders). Refreshed stale Redis comments in `menu-service.ts`, `candidate-matcher.ts`,
  `in-memory-menu-store.ts`, `postgres-menu-store.ts`.
- **Why:** The menu backend is Postgres/pgvector; Redis should only be used by the Cart
  Module (cart persistence). The Redis menu path was unwired dead code.
- **Where:** menu module (`src/menu/`).
- **Notes:** No production wiring changed (`app.ts` already used `PostgresMenuStore`).
  `MenuStore` interface + `InMemoryMenuStore` (test double) and `PostgresMenuStore` unchanged.
## 2026-07-13 — All-language names for the client (cart, modifiers, suggestions)
- **What:** Added an all-language `names` map alongside the single-string `name` on every
  client-facing item/modifier, so the frontend picks the display locale.
  - **Cart items** — required `names: Record<LangCode, string>` on `CartLine`, snapshotted
    from `item.names` in the applier.
  - **Modifiers** — optional `names?` on `CandidateModifier` (`menu-types.ts`) and
    `CartModifier` (`cart-types.ts`); both stores emit it (`PostgresMenuStore.hydrate` via
    new `namesOf` helper, `toCandidateModifier` in `menu-store.ts`); the applier snapshots
    it via a `toCartModifier` helper.
  - **Suggestions** — optional `names?` on `CandidateItem` (`menu-types.ts`, populated in
    `candidate-matcher.ts`) and `SuggestedItem` (`suggestion.schema.ts`); `suggest.node.ts`
    carries it from the matched candidate into `order.suggestion_ready`.
- **Why:** `cart.updated` and `order.suggestion_ready` only carried one display name (en_US
  w/ fallback). The frontend needs every translated name to display in the customer's chosen
  locale — language selection is a client concern.
- **Where:** `menu` (`menu-types.ts`, `postgres-menu-store.ts`, `menu-store.ts`,
  `candidate-matcher.ts`), `cart` (`cart-types.ts`, `cart-operation-applier.ts`), `ordering`
  (`schemas/suggestion.schema.ts`, `nodes/suggest.node.ts`) + their tests. Frontend contract
  doc updated (`shared/docs/frontend-integration-guide.md`).
- **Notes:** Additive — flows to the client automatically since the events forward the stored
  shapes. Multilingual data was already fetched from Odoo (`product_template.name` /
  `product_attribute_value.name` jsonb); the read paths previously flattened it. The `names`
  maps on modifiers/candidates/suggestions are optional (legacy data / minimal fixtures may
  omit them); `name` stays the required single-string fallback. The LLM's `CartView`
  (`load-cart.node.ts`) is unaffected (rebuilt from the menu, still en_US).

## 2026-07-13 — Menu backend: Postgres/pgvector replaces Redis
- **What:** Added `PostgresMenuStore` (`src/menu/postgres-menu-store.ts`) implementing the
  `MenuStore` interface over an `item_vector` table (pgvector) that lives IN the Odoo Postgres DB.
  `item_vector(pos_config_id, product_tmpl_id, menu_item_key, lang, name, vector)` holds the
  per-restaurant membership + LLM key + one embedding row per (item, language); Odoo's own tables
  (`product_template`, `product_template_attribute_value`, `product_attribute_value`,
  `product_attribute`) are JOINed at read time for live names/price/availability/modifiers.
  KNN uses pgvector `<=>` cosine distance; lexical retrieval is `name ILIKE ANY(%term%)`. Mapping:
  `base_price_cents = round(list_price*100)`, `available = available_in_pos AND active`,
  `modifier_key = String(ptav_id)`. New `src/db/postgres-client.ts` (shared `pg.Pool`), `env`
  `ODOO_DATABASE_URL`, and `scripts/populate-postgres-menu.ts` (`npm run seed:menu:pg`) which
  embeds Odoo template names and upserts `item_vector`. `app.ts` now wires
  `MenuService(new PostgresMenuStore(pool))` and closes the pool on stop.
- **Why:** Move the menu off Redis/RediSearch onto Postgres/pgvector (a pgvector `db` service is in
  docker-compose). Cart state stays on Redis.
- **Where:** `menu` (new store + tests), `persistence` (pg client), `platform` (env, app wiring),
  `docker-compose.yml`, `package.json`.
- **Notes:** `RedisMenuStore` and its tests stay in the tree but are no longer wired. With the stub
  embedder (`EMBEDDING_DIMENSIONS=0`) `ensureIndex` no-ops and the menu is empty — a real embedding
  provider + `seed:menu:pg` is required to populate `item_vector`. Requires the pgvector extension.
## 2026-07-13 — Suggest node: real LLM recommender (replaces the stub)
- **What:** Turned the `suggest` graph node from a log-only stub into a recommender. The node now
  loads the cart (for upsell) + retrieves candidates, then calls the proposer `llm` via a new
  `buildSuggestionPrompt` (`llm/suggestion-prompt-builder.ts`) and validates the reply with a new
  `parseSuggestion` (`schemas/suggestion.schema.ts` → `Suggestion`/`SuggestedItem`). Output is
  filtered to the candidates (no hallucinated items) and degrades to a safe fallback reply on any
  failure. Each surviving item's `name` is taken from the matched candidate (the menu), not the
  model's echo, and keys are deduped — so a right-key/wrong-name or repeated recommendation can't
  reach the client or `suggested_items` history. The result rides a new `suggestion` state channel (cleared by `normalize` each fresh
  turn); the façade surfaces `{ status: 'suggest', reply, items }` and the service emits a new
  `order.suggestion_ready` event, forwarded to the client by `realtime-gateway` (new
  `SuggestionReadyMsg`). `finalize` records the recommended items into
  `HistoryTurn.suggested_items`, and the parse prompt gained one instruction allowing a recalled
  suggested `menu_item_key` in a follow-up `add_item`, so "the first one" resolves next turn.
- **Why:** Ship the recommender the intent classifier already routes to, and make it conversational
  (follow-ups referencing a suggestion resolve) rather than fire-and-forget.
- **Where:** `ordering/nodes/suggest.node.ts` (+ test), `ordering/graph/{build-graph,state}.ts`,
  `ordering/order-graph.ts`, `ordering/order-understanding-service.ts` (+ test),
  `ordering/schemas/{suggestion.schema,order-graph-input.schema}.ts`,
  `llm/{suggestion-prompt-builder,prompt-builder}.ts`, `events/event-types.ts`,
  `realtime/{realtime-message-types,realtime-gateway}.ts`.
- **Notes:** Suggest reuses the proposer `llm` (no separate creds). With the `stub` LLM the
  classifier always degrades to `order`, so this path only activates against a real LLM.
  `docs/LLM-graph.md` §4 `suggest` / state table / file map updated. Two PRE-EXISTING failures in
  `order-understanding-service.test.ts` (repair-exhausted call count, clarification cap) are
  unrelated to this change.

## 2026-07-10 — Intent classifier: run after normalize, own creds, hardening
- **What:** Follow-ups to the intent classifier. (1) Moved `classify` to run AFTER `normalize`
  instead of being the entry point — the graph is now `START → normalize → classify → (route)`,
  so the classifier sees the whitespace-normalized utterance; `INTENT_ROUTE.order` now points at
  `load_cart` (normalize already ran) and `classify` reads the `clarification_question` channel
  (set by `normalize`) for its pending-answer override instead of re-reading `history`. (2) Gave
  the classifier its OWN LLM provider/creds: new `INTENT_LLM_*` env (falling back to `LLM_*`),
  `createIntentLlmProvider`, `GraphDeps.intentLlm`; `OpenAiCompatibleLlmProvider` now takes an
  injected `LlmClientConfig` instead of reading `config` directly. (3) Fixed three review
  findings: `classifyIntent` no longer throws on a valid-but-non-object payload (JSON `null`,
  bare number/string) — it degrades to `order` like every other malformed shape; `junk` now
  routes straight to `END` (skips `finalize`) so noise is not recorded to history and can't
  pollute later `parse` context; the `ScriptedLlm` test now identifies the classifier hop by
  comparing against `buildIntentPrompt('').system` rather than a hard-coded prefix.
- **Why:** Classify the cleaned text; let the cheap routing call use a cheaper/separate model
  and key; close the crash hole in the "never drop an order" contract; keep the order parser's
  conversation context free of non-orderable noise.
- **Where:** `ordering/graph/build-graph.ts`, `ordering/graph/intents.ts`,
  `ordering/order-graph.ts`, `ordering/nodes/classify-intent.node.ts`, `config/env.ts`,
  `llm/openai-compatible-provider.ts`, `llm/llm-client.ts`, `app.ts`, `.env.example`; tests in
  `intents.test.ts`, `classify-intent.node.test.ts`, `openai-compatible-provider.test.ts`,
  `llm-client.test.ts`, `order-understanding-service.test.ts`; docs `docs/LLM-graph.md`.
- **Notes:** `INTENT_LLM_*` are opt-in — unset means the classifier shares the main provider
  (and `OrderGraph`'s `intentLlm` constructor arg defaults to the parser `llm`), so existing
  deployments and the `stub` provider behave exactly as before.

## 2026-07-10 — Intent classifier at the head of the order graph
- **What:** Added a `classify` node as the graph's new entry point. It labels each utterance
  as `order` | `suggest` | `junk` via a cheap first-hop LLM call and routes on it through a
  single table-driven conditional edge: `order` → the existing `normalize → load_cart →
  retrieve → parse → finalize` pipeline; `suggest` → a v1 stub node → `finalize`; `junk` →
  straight to `finalize`. Non-order turns short-circuit (no cart load, no parse). Surfaced as
  two new `GraphTurnResult` variants (`{status:'suggest'}` / `{status:'junk'}`), which the
  service handles by logging and ending the turn (no proposal, no failure).
- **Why:** Not every utterance is an order; running the full proposer on greetings/noise or on
  recommendation requests is wasteful and wrong. The design centers on cheap future
  extensibility — adding/routing a new intent is a one-row edit.
- **Where:** new `ordering/graph/intents.ts` (`intentSchema` + `INTENT_ROUTE`, the single
  source of truth), `ordering/nodes/classify-intent.node.ts`, `ordering/nodes/suggest.node.ts`,
  `llm/intent-prompt-builder.ts`; edited `ordering/graph/state.ts` (new `intent` channel),
  `ordering/graph/build-graph.ts` (classify node + `addConditionalEdges`), `ordering/order-graph.ts`
  (`GraphTurnResult` + `interpret`), `ordering/order-understanding-service.ts` (junk/suggest
  handling). Tests: `intents.test.ts`, `classify-intent.node.test.ts`, `intent-prompt-builder.test.ts`,
  and routing cases in `order-understanding-service.test.ts`.
- **Notes:** The classifier DEGRADES TO `order` on any failure (transport error, non-JSON,
  unknown label) so a real order is never dropped — the `stub` LLM provider therefore behaves
  exactly as before (always `order`). When a clarification is pending (`history` last turn has a
  `clarification_question`), `classify` forces `order` and skips the classifier so the answer is
  never mislabeled `junk`. `suggest` is a stub: the recommender itself is future work (the node
  is the seam; the service has a TODO to emit a suggestion event). This adds one LLM round-trip
  per fresh non-clarification turn.

## 2026-07-10 — Drop the `clarification_answer` plumbing (keep the question)
- **What:** Removed everything named `clarification_answer` — the never-written
  `HistoryTurn.clarification_answer` field, the `clarification_answer` graph state channel,
  the `OrderGraphInput.clarification_answer` field, and the prompt's `answer` in the
  `clarification` block. `clarification_question` stays and is now the sole carrier: the
  prompt sends `clarification: { question }`, and the model is told the current
  `customer_text` is the answer. Also removed the always-true `clarification_answer ===
  undefined` guards in `trailingClarificationRun` and the `normalize` node.
- **Why:** The answer field was redundant with the question already riding in
  `conversation_history` (and on `HistoryTurn` it was read but never set — dead code). The
  utterance itself is the answer, so a separate round-tripped answer added no signal.
- **Where:** `ordering/schemas/order-graph-input.schema.ts`, `ordering/graph/state.ts`,
  `ordering/graph/build-graph.ts` (normalize), `llm/prompt-builder.ts`; tests in
  `graph/state.test.ts`, `llm/prompt-builder.test.ts`, `order-understanding-service.test.ts`.
- **Notes:** Behavior-preserving for the fire-and-forget clarification loop — the model still
  asks questions (`needs_clarification` output + `order.clarification_needed` event unchanged)
  and still resolves them from the pending question. The `retrieve` node also augments its
  query with the pending `clarification_question` for better candidate recall.

## 2026-07-10 — Fire-and-forget clarifications (no more waiting/resume)
- **What:** The clarify flow no longer pauses the turn. When `parse` sets
  `needs_clarification`, `finalize` records the question into `history` and the graph
  runs to `END`; the service emits `order.clarification_needed` and releases its FIFO
  slot. The customer's answer arrives as the **next** `stt.final_transcript` — that
  turn's `normalize` detects the pending question (last `history` entry with a
  `clarification_question` and no answer) and feeds `{question, answer: utterance}` to
  `parse`. Removed the LangGraph `interrupt`/`Command({resume})` machinery, the
  `clarify` node, the conditional edge, `OrderGraph.resume()`, and the whole blocking
  path in the service (`awaitClarification`, `pendingClarifications`,
  `handleClarificationAnswer`, `TIMEOUTS.clarificationMs`). Graph is now a straight
  line `normalize → load_cart → retrieve → parse → finalize → END`. Added a soft cap:
  `trailingClarificationRun(history)` counts consecutive unanswered clarifications and
  the service fails the turn (`clarification_unresolved`) past `MAX_CLARIFICATION_ROUNDS`.
  Added a prompt nudge so the model treats the utterance as the answer (or a fresh
  request if it plainly isn't). Removed the now-dead inbound `order.clarification_answered`
  contract (event type, bus map entry, WS message type, router case, gateway wiring).
- **Why:** Blocking the turn on a clarifying answer held the per-cart FIFO (turn 2
  stuck behind turn 1) and required a special answer channel + 30s timeout. Assuming the
  customer answers on the next turn removes the wait entirely while keeping the question
  in LLM history for context.
- **Where:** `ordering` (`graph/build-graph.ts`, `graph/state.ts`, `order-graph.ts`,
  `order-understanding-service.ts`, `register-handlers.ts`), `events/event-types.ts`,
  `realtime/{message-router,realtime-message-types,realtime-gateway}.ts`,
  `llm/prompt-builder.ts`, `config/constants.ts`, plus their tests.
- **Notes:** Client-facing contract change — the app must stop sending
  `order.clarification_answered` and simply send the next utterance. `MemorySaver` is
  still in-process, so a pending question is lost on restart (unchanged caveat).
## 2026-07-10 — Partial-transcript stop detection (auto-end the turn on silence)
- **What:** The voice handler now auto-fires `voice.stop` when no new partial transcript
  arrives within `TIMEOUTS.partialIdleMs` (2.5 s) — "the customer stopped talking." A
  `stopTimer` on `VoiceSession` is (re)armed on real speech progress (a growing partial
  or a final), never on `voice.audio_chunk` (silence still streams audio); empty/keepalive
  and verbatim-repeat partials are ignored via `lastPartialText`. On fire it reuses
  `handleStop`, so the flush + `finalTranscriptMs` grace window behave exactly like a
  client-sent stop. The timer is cleared on `handleStop`, disconnect, and STT error, and
  is `unref`'d so it never keeps the process alive.
- **Why:** The turn previously ended only on an explicit client `voice.stop`; customers
  had to signal end-of-turn manually. This detects end-of-turn from transcript inactivity.
  (Distinct from the longer session-idle "walked away" backstop in `voice-idle-timeout.md`.)
- **Where:** `config/constants.ts` (`partialIdleMs`), `voice/voice-session.ts`
  (`stopTimer`, `lastPartialText`), `voice/voice-message-handler.ts` (`armIdleStop`,
  `onPartial`/`onFinal` reset, clears in stop/disconnect/error),
  `voice/voice-message-handler.test.ts` (5 new tests), `docs/customer-stop-detection.md`.

## 2026-07-09 — Plan doc for a voice-session idle/silence timeout
- **What:** Added `docs/voice-idle-timeout.md` — a proposed (not implemented) plan to
  end a `listening` voice session after N seconds of silence. Key point: audio chunks
  stream continuously while the mic is open, so the idle timer must reset on transcript
  activity (`onPartial`/`onFinal`), never on `voice.audio_chunk`.
- **Why:** Nothing currently ends a session on customer silence; it leaves `listening`
  only on explicit `voice.stop`, disconnect, or STT error.
- **Where:** `docs/voice-idle-timeout.md`. Docs only — no code change.

## 2026-07-09 — Add Chinese-language e2e coverage to the LLM pipeline suite
- **What:** New `describe('Chinese-language support (zh_CN, cross-language matching)')`
  block in `E2E/llm_pipeline.e2e.ts` with 5 tests (happy-path add, quantity 两份→2,
  modifier add 加西兰花→add Broccoli, modifier omit 走西兰花→no Broccoli, clarification
  套餐→resume answered in Chinese). Extended the `emitFinal` helper with an optional
  `language` arg so transcripts carry `language: 'zh_CN'` (what STT would tag).
- **Why:** The suite exercised only English utterances; cross-language matching (the
  design §7/§15 premise — multilingual Jina embeddings map a Chinese utterance to the
  same menu items) had no end-to-end coverage.
- **Where:** `E2E/llm_pipeline.e2e.ts` (test-only; no product code changed).
- **Notes:** Phrases use the real Jade Garden `zh_CN` menu terms in Redis (咕嚕雞,
  炸云吞, 套餐, 加西兰花/走西兰花). Assertions still key off each item's `en_US` name,
  so the existing helpers are reused unchanged. Tolerant like the English tests
  (self-skip on non-determinism). Not run here.

## 2026-07-09 — Document current data schemas in design.md
- **What:** Added a "Data Schemas" section (§17) to `docs/design.md` capturing the
  implemented shapes: identity families (our text keys vs Odoo integer soft refs),
  the two data stores, stored `Cart`/`CartLine`/`CartModifier`, menu/candidate types,
  the LLM contract (`OrderGraphInput`, `CartOperation` union, `OrderGraphOutput`,
  `OrderProposal`), `AppEventMap` payloads, WebSocket messages, and the contract-key →
  Odoo-id mapping. Fixed the stale §9 Redis cart shape (was `menu_item_key`/flat money;
  now `product_tmpl_id`/`ptav_id`/`*_cents`/combo fields, key `cart:{cart_id}`).
- **Why:** design.md carried a `data schema` TODO and the §9 Redis block predated the
  move to Odoo integer ids and cents-based money.
- **Where:** `docs/design.md` (§9, new §17). Docs only — no code change.
## 2026-07-10 — Cross-event log traceability (request_id threading)
- **What:** (1) `voice-message-handler` now logs `voice.final_transcript`
  `{ request_id, session_id, cart_id }` where the turn id is minted — the join point
  from a socket (session_id) to its turn (request_id). (2) Added top-level `request_id`
  (+`cart_id`) to the `order.operations_proposed` payload and `request_id` to
  `cart.updated`, so the event-bus `event.emit` correlation log keeps the turn thread
  across the propose→apply→update hops (previously it dropped to session-only / cart-only).
- **Why:** A single user turn could not be traced end-to-end through the logs: the
  event-bus trace is the one cross-cutting line, but two payloads didn't expose
  `request_id`, and nothing bound session_id↔request_id together.
- **Where:** `src/voice/voice-message-handler.ts`, `src/ordering/order-understanding-service.ts`,
  `src/cart/cart-controller.ts`, `src/events/event-types.ts` (payload contracts).
- **Notes:** Additive fields only — consumers (`cart/register-handlers`, realtime gateway)
  ignore the extra keys. `event.emit` remains DEBUG-level, so a full trace still requires
  `LOG_LEVEL=debug`. Tests updated in voice/ordering/cart/realtime/event-bus suites (247 passing).
- **What:** Added `events/event-bus.test.ts`, `redis/redis-client.test.ts`, realtime
  `client-registry`/`message-router`/`realtime-message-types`/`realtime-gateway` tests,
  and extended `redis/cart-cache.test.ts` with `InMemoryCartCache` + `cartKey` (60 new
  tests). event-bus covers delivery/order/`off`/isolation, the **no-error-isolation**
  behavior (a throwing handler escapes `emit`), and conditional correlation-logging;
  gateway covers multi-device `cart.updated` broadcast, `cart.operation_rejected`
  targeting, clarification option-omission, disconnect→voice cleanup, and resume fallback.
- **Why:** Close the remaining top-priority audit gaps; the event bus (app backbone) and
  realtime routing had no direct coverage.
- **Where:** `src/events/`, `src/redis/`, `src/realtime/`; audit doc updated.
- **Notes:** `ioredis` mocked via `vi.mock` with an instance-capturing fake. Full suite
  now 246 passing.

## 2026-07-10 — Unit tests for the llm module
- **What:** Added `prompt-builder.test.ts`, `openai-compatible-provider.test.ts`, and
  `llm-client.test.ts` (21 tests). Covers the "keep full `available_modifiers`" prompt
  invariant, clarification-block branches, repair prompt, provider request mapping
  (`temperature:0`, `response_format json_object`), missing-`LLM_API_KEY` throw,
  empty-content warn, SDK rejection propagation, and the provider factory + stub.
- **Why:** Close the top-priority gaps from the coverage audit; the llm module had none.
- **Where:** `src/llm/`; audit doc `docs/unit-test-coverage-audit.md` updated.
- **Notes:** `openai` SDK mocked via `vi.mock`; config-dependent branches use env set
  before import + `vi.resetModules()` for the missing-key / provider-switch cases.
  Full suite now 186 passing.

## 2026-07-09 — Unit test coverage audit
- **What:** Added `docs/unit-test-coverage-audit.md` — a per-module review of missing
  unit tests (status table, top-12 prioritized gaps, per-file detail).
- **Why:** Establish a coverage baseline and prioritize which units to test next.
- **Where:** docs only; no source changes.
- **Notes:** Flags two structural items — `event-bus` has no handler error isolation
  (a throwing subscriber breaks `emit`), and `env.ts`/`logger.ts` bind config at import
  time so tests need `vi.resetModules()`.

## 2026-07-09 — Send clarification question with the answer on resume
- **What:** Thread the prior `clarification_question` through to the resumed parse
  prompt. Added `clarification_question?` to `OrderGraphInput`; `toInput` now copies it
  from state (already set by the `clarify` node); `buildPrompt` renders the answer +
  question together as a nested `clarification: { question, answer }` object (replacing
  the flat `clarification_answer` field).
- **Why:** On resume the model received the answer with no record of the question it
  answered, so it re-emitted the same `clarification_question` — the observed
  `clarification_needed → answered → clarification_needed` loop.
- **Where:** `ordering/schemas/order-graph-input.schema.ts`, `ordering/graph/build-graph.ts`
  (`toInput`), `llm/prompt-builder.ts`. Doc: `docs/ordering-langgraph.md` §6.
- **Notes:** Plumbing only. The complementary system-prompt instruction telling the
  model to resolve from `clarification` and not re-ask is NOT yet added — see
  `docs/ordering-langgraph.md` §6.4 (item 2, still open).

## 2026-07-09 — Switch LLM to Gemini; expand real-stack e2e coverage
- **What:** (1) Pointed the LLM at Google's OpenAI-compatible Gemini endpoint via env
  (`.env`: `LLM_PROVIDER=openai`, `LLM_BASE_URL=.../v1beta/openai/`, `LLM_MODEL=gemini-flash-lite-latest`).
  (2) Moved/authored the real-stack pipeline e2e as `E2E/llm_pipeline.e2e.ts` (replaces the
  old `src/ordering/final-transcript.e2e.ts`); added a per-test timing summary printed in
  `afterAll` (model name from env + average ms). (3) Added 8 new e2e cases: multi-item,
  multi-modifier, quantity+omission, no-op menu question, off-menu item, in-turn
  self-correction, add-to-non-empty-cart, and cooking-style modifier. (4) Made the
  `parses quantity` test tolerant of a clarification round (answers it, then asserts qty 2).
- **Why:** No local Ollama in this environment; Gemini's OpenAI-compat layer runs the same
  `OpenAiCompatibleLlmProvider` unchanged. Broaden e2e coverage of multi-op output and
  robustness (no fabricated adds), and de-flake the quantity test under the smaller model,
  which asks which wonton more often (the menu has several wonton dishes).
- **Where:** `.env`, `E2E/llm_pipeline.e2e.ts`.
- **Notes:** The configured Gemini key only serves the `-latest` alias models — pinned
  versions (`gemini-2.5-*`, `gemini-2.0-*`) 404 ("not available to new users") or 429
  (`limit: 0`, no free-tier quota). `vitest.e2e.config.ts:12-15`'s "FORCE the LLM to Ollama"
  comment is stale — `pick()` honours `.env` and only falls back to Ollama when unset.

## 2026-07-09 — Add Order Understanding LangGraph internals doc
- **What:** New `docs/ordering-langgraph.md` — deep reference for the ordering graph:
  topology, every state channel + reducer, the interrupt/resume mechanism, the
  checkpointer thread model, the schema-repair loop, failure modes, and invariants.
- **Why:** The module `overview.md` summarizes the graph; this captures the mechanics
  in depth for contributors touching pause/resume or state channels.
- **Where:** `docs/` (documentation only — no code change to `src/ordering`).

## 2026-07-09 — Logging hardening: level gating, correlation, safe error meta
- **What:** (1) `emit()` in `config/logger.ts` now honours `LOG_LEVEL` (was read into
  config but ignored — every level always printed). (2) `EventBus.emit` tags the
  `event.emit` debug trace with `request_id`/`cart_id`/`session_id` pulled off the payload,
  so the bus — which sees every event — is traceable per turn. (3) Adopted `logger.child()`
  (previously defined but unused) to bind turn ids once in `OrderUnderstandingService.runTurn`
  and `CartController.applyProposal`. (4) Both ordering bus handlers now `.catch` rejections
  and log them (mirrors the cart handler) instead of dropping turns as unhandled rejections.
  (5) New `messageOf()` / `errorMeta()` helpers in `shared/errors.ts` replace unsafe
  `(err as Error).message` at 7 log sites; `logger.error` sites now include `stack`.
- **Why:** Close observability gaps in the event-driven flow — an ignored log level, an
  un-correlated bus, a silent rejection path in ordering, inconsistent/unsafe error
  extraction, and stackless error logs.
- **Where:** `config/logger.ts`, `events/event-bus.ts`, `shared/errors.ts`,
  `ordering/register-handlers.ts`, `ordering/order-understanding-service.ts`,
  `ordering/graph/instrument.ts`, `cart/cart-controller.ts`, `cart/register-handlers.ts`,
  `redis/cart-cache.ts`, `redis/redis-client.ts`, `menu/menu-store.ts`, `app.ts`, `server.ts`,
  `voice/voice-message-handler.ts`.
- **Notes:** Provider-level logs (`llm.*`, `embedding.*`, `menu.*_unavailable`) remain
  un-correlated — full turn-context propagation (AsyncLocalStorage / graph-state logger)
  was deliberately deferred as a larger follow-up. Pre-existing failing test
  `cart-repository.test.ts` (MULTI/EXEC per-command error) is unrelated to this change.

## 2026-07-09 — Fix prompt/schema drift: derive ALLOWED_OPERATIONS from the validator
- **What:** `ALLOWED_OPERATIONS` in `src/llm/prompt-builder.ts` was a hand-maintained
  literal list that included `'clarify'`, an action the output schema
  (`cart-operation.schema.ts`) never defines. The prompt therefore advertised an operation
  that would fail Zod validation if the model emitted it. Replaced the literal with a list
  derived from the schema: `cartOperationSchema.options.map((o) => o.shape.action.value)`.
- **Why:** Clarification is signalled via the top-level `needs_clarification` /
  `clarification_question` fields, not as a member of the `operations` discriminated union.
  Deriving the advertised list from the validator makes drift structurally impossible.
- **Where:** `src/llm/prompt-builder.ts`.

## 2026-07-09 — Send the final transcript back to the mobile app
- **What:** Added a `voice.final_transcript` outbound message (`{ type, session_id, text,
  language? }`) to `realtime-message-types.ts` (`FinalTranscriptMsg` + `OutboundMessage`
  union). The Voice handler's `onFinal` now `conn.send`s it to the client — directly, the
  same way partials are sent — right before emitting the internal
  `stt.final_transcript.received` bus event. It sits inside the existing terminal-session
  guard, so a final that lands after the §11.2 C timeout (or an ended/interrupted session)
  is suppressed for the client too, not just the cart.
- **Why:** The app received live `voice.partial_transcript`s but never the settled final —
  the finalized text was only emitted internally and vanished from the UI, replaced by a
  cart update. The client now gets an authoritative "here's what we heard" to replace the
  partial. Display-only: the backend still acts on its own internal copy, never the client's.
- **Where:** `src/realtime/realtime-message-types.ts`, `src/voice/voice-message-handler.ts`
  (+ `voice-message-handler.test.ts`), `docs/realtime-gateway-frontend-integration.md`,
  `.claude/.knowledge/voice/overview.md`.

## 2026-07-09 — Add display `name` to CartLine and CartModifier
- **What:** `CartLine` and `CartModifier` (`cart-types.ts`) each gain a required `name: string`.
  Both are populated in `applyOperation` (`cart-operation-applier.ts`) from already-resolved menu
  data — the line name from the `MenuItem` (`item.names['en_US'] ?? Object.values(item.names)[0] ??
  item.menu_item_key`), the modifier name from the matched `CandidateModifier` (`mod.name`) in the
  `add_item` and `add_modifier` branches — so no extra menu round trip. All other ops spread-copy,
  preserving both names. The fields round-trip through the whole-blob Redis serialization
  automatically and now ride on the `cart.updated` wire payload (the gateway sends the full `cart`).
- **Why:** The persisted cart was id-only; the client had no human-readable item/modifier names
  without re-resolving the menu. `buildCartView` still re-resolves names live for the LLM view, so
  the stored names are snapshots captured at add time (can go stale if the menu is later renamed).
- **Where:** `src/cart/cart-types.ts`, `src/cart/cart-operation-applier.ts`; test fixtures updated
  in `cart-operation-applier.test.ts` and `final-transcript.e2e.ts`.

## 2026-07-09 — Per-node error logging in the order graph
- **What:** Added `src/ordering/graph/instrument.ts` exporting a `node(name, fn)` wrapper, and
  wrapped all six order-graph nodes (`normalize`, `load_cart`, `retrieve`, `parse`, `clarify`,
  `finalize`) with it in `build-graph.ts`. The wrapper logs `order.node_failed` (level `error`)
  with the node name + `request_id`/`cart_id`/`pos_config_id` on any throw, then re-throws
  unchanged; LangGraph control-flow throws (`interrupt()` pause, Command bubbling) are detected
  via `isGraphBubbleUp` and re-thrown WITHOUT logging. Relabeled the turn-level catch in
  `OrderUnderstandingService.runTurn` from `order.parse_failed` → `order.turn_failed` (it is now
  a fallback; the failing node already reports which state threw). The `voice.session_failed`
  reason string (`order_parse_failed`) is unchanged — it is an external event contract.
- **Why:** The single catch in the service flattened every node error (Redis in `load_cart`,
  MenuService in `retrieve`, ValidationError in `parse`) into one misleading `order.parse_failed`
  label, discarding which of the six states actually failed.
- **Where:** `src/ordering/graph/instrument.ts` (new), `src/ordering/graph/build-graph.ts`,
  `src/ordering/order-understanding-service.ts`.

## 2026-07-09 — Scope final-transcript e2e to the LLM output (drop the Cart module)
- **What:** `final-transcript.e2e.ts` now exercises the Order Understanding pipeline only,
  up to its terminal output (`order.operations_proposed` / `order.clarification_needed` /
  `voice.session_failed`) — it no longer wires the `CartController`/cart handlers and asserts
  nothing about the applied `cart.updated`. Assertions moved onto the proposal (schema-valid
  ops, resolved menu_item_key names/quantities, modifier key→ptav_id). `waitForAny` now reads
  cart_id from `proposal.cart_id` for `order.operations_proposed` (it has no top-level
  cart_id). The cross-turn test was converted to a single-turn *pronoun* test ("add broccoli
  to that" against a pre-seeded self-describing line), since cross-turn behavior depends on the
  cart being applied between turns (the graph re-loads the cart from Redis each turn). Removed
  the now-dead idempotency-ledger machinery (per-run request_id salt, `createdRequestIds`,
  `cart:req:{id}` cleanup) and the cart-state helpers (`expectLine`, `nameOfTmpl`).
- **Why:** The suite should test the pipeline up to the LLM output, isolating Order
  Understanding from the Cart module (which has its own tests).
- **Where:** `src/ordering/final-transcript.e2e.ts`.
## 2026-07-09 — Remove the `saveSnapshot` stub
- **What:** Dropped `CartRepository.saveSnapshot` — the interface method, both impls
  (Redis + in-memory, each a no-op that only logged `cart.snapshot`), and the
  `cart-controller.ts` call that ran it right after `commitApplied`.
- **Why:** The live cart already persists durably at `cart:{cart_id}` via `commitApplied`,
  and conversation history is persisted separately, so a second (never-implemented) versioned
  snapshot was speculative (YAGNI). Removing it also erases the latent bug where a throwing
  `saveSnapshot` after a successful commit would mis-report the apply as `internal_error`.
- **Where:** `src/cart/cart-controller.ts`, `src/cart/cart-repository.ts`,
  `src/cart/cart-types.ts` (comment), `src/cart/cart-controller.test.ts` (removed the
  now-moot test). Bundles: `cart/overview.md`, `persistence/overview.md`.

## 2026-07-09 — Close cart-subsystem test gaps (edge cases)
- **What:** Added tests covering previously-untested edge cases across the cart subsystem.
  New test files: `src/shared/async-lock.test.ts` (`KeyedAsyncLock` — same-key
  serialization, cross-key concurrency, throwing-callback isolation, map-entry cleanup),
  `src/ordering/cart-turn-queue.test.ts` (FIFO ordering, throwing-turn isolation),
  `src/ordering/schemas/cart-operation.schema.test.ts` (`parseCartOperation` — the sole
  guard on `add_item` quantity, unknown action, empty/missing fields). Extended existing
  suites: applier (delisted line reprices to 0, delisted-item→invalid_modifier conflation,
  unknown-action switch fall-through), controller (empty batch no-op, reused request_id
  across carts, `confirm()` present/absent), repository (unchecked MULTI/EXEC per-command
  error + a currently-failing test asserting it should reject), cache (transport error from
  `redis.get` propagates).
- **Why:** A coverage audit surfaced real gaps — a delisted line silently pricing to 0, the
  schema being the only quantity guard, and an unchecked EXEC result. Most tests pin current
  behavior; the H4 test asserts the correct behavior for a genuine bug and is RED so it
  catches the bug.
- **Where:** `src/shared`, `src/ordering`, `src/ordering/schemas`, `src/cart`, `src/redis`
  (tests only — no source changed).
- **Notes:** One test fails on purpose against the current code (H4: unchecked MULTI/EXEC
  result in cart-repository). It goes green once that bug is fixed — do not delete or skip it
  to make the suite pass.

## 2026-07-08 — Fix Redis persistence + e2e re-run collision from the idempotency ledger
- **What:** Two fixes exposed while running the final-transcript e2e. (1) `docker-compose.yml`:
  mount the redis volume at redis-stack-server's native data dir (`/var/lib/redis-stack`,
  its default `dir`) instead of `/data`. The old mount left the real data dir on the
  ephemeral container layer, so the menu + KNN index were lost on every container recreate.
  (2) `final-transcript.e2e.ts`: the now Redis-backed idempotency ledger
  (`cart:req:{request_id}`, 24h TTL) survives across runs, but the test used deterministic
  request_ids that reset each run — a re-run within the TTL was dropped as
  `cart.duplicate_request` and hung the turn to timeout. Added a per-run salt to
  `request_id`, tracked emitted request_ids via `emitFinal`, and extended `afterEach` to
  delete `cart:req:{id}` alongside the cart key.
- **Why:** After a container recreate the e2e preflight reported "Redis has no menu" (empty
  DB); after restoring the menu, re-runs then hung on the persistent ledger. Neither was a
  code regression — both are consequences of the ledger going Redis-backed (see below).
- **Where:** `docker-compose.yml`, `src/ordering/final-transcript.e2e.ts`.
- **Notes:** Restoring the lost data: the menu survived in the older `populate_redis_redis-data`
  docker volume (351 items, embeddings live in the JSON blobs), copied into `backend_redis-data`;
  the KNN index was rebuilt locally with `npm run index:menu` (no Jina call). The graph
  checkpointer is in-memory, so no other cross-run state needed cleanup.

## 2026-07-08 — Redis-backed cart idempotency ledger + infra-failure handling
- **What:** (F3) Turned `CartRepository` into an interface with `RedisCartRepository`
  (idempotency ledger at `cart:req:{request_id}`, TTL-bounded via new
  `CART_IDEMPOTENCY_TTL_SECONDS`, default 24h) + `InMemoryCartRepository` for tests —
  mirroring the `CartCache` two-impl pattern. New `commitApplied` writes the cart blob
  and the ledger mark in one Redis `MULTI`. (F2) Wrapped `CartController.applyProposal`
  in try/catch: an unexpected/infra throw (Redis/menu down) now aborts before any
  persist, leaves the request un-marked (retry-safe), and emits one
  `cart.operation_rejected` with reason `internal_error` instead of silently dropping
  the turn; `registerCartHandlers` also `.catch`es as a last-resort guard. Tightened
  `applyOperation`/`validateOperation` error types to `CartRejectedError` and removed
  the now-dead non-rejection `else` branch in the controller.
- **Why:** The in-memory ledger grew unbounded (F3), and infra errors escaped as
  unhandled promise rejections that dropped the turn with no client signal; the
  separate cart-write/ledger-mark also had a double-apply-on-partial-failure window (F2).
- **Where:** `src/cart/cart-repository.ts` (+ test), `cart-controller.ts` (+ test),
  `cart-operation-applier.ts`, `cart-validator.ts`, `register-handlers.ts`,
  `src/redis/cart-cache.ts` (export `cartKey`), `src/config/env.ts`, `app.ts`,
  `src/ordering/final-transcript.e2e.ts`, `.env.example`.
- **Notes:** New env var `CART_IDEMPOTENCY_TTL_SECONDS`. `RedisCartRepository` writes
  the cart key too (via `commitApplied`), so the controller's applied path no longer
  calls `CartCache.set` — reads still go through `CartCache`. The try/catch guards only
  the compute-and-persist section; the `cart.updated` and per-op rejection emits run
  after it (outside the try) so a synchronously-throwing event listener (`EventBus.emit`
  isolates nothing) can't be misread as an infra failure and emit a spurious
  `internal_error` for an already-committed cart.

## 2026-07-08 — cart-controller test aligned with in-memory CartRepository
- **What:** Removed dead `import type { Db } from '../db/db.js'`, the unused `dbStub`,
  and the stray `new CartRepository(dbStub)` argument from `cart-controller.test.ts`;
  the constructor takes no args.
- **Why:** Leftover from an abandoned Postgres-backed-repository direction — the module
  removed by `db/db.js` never existed, and test files are excluded from `tsc` (and
  vitest strips types), so the dangling import + wrong arity slipped through both gates.
  With "persist only to Redis for now," `CartRepository` stays in-memory.
- **Where:** `src/cart/cart-controller.test.ts`.
## 2026-07-08 — Remove Plan B (candidate accumulation); carry clarification question in history
- **What:** (1) Reverted the `candidates` graph channel from the accumulating merge back to
  last-write-wins — each turn's `retrieve` again fully replaces the prompt's candidate set.
  Deleted `mergeCandidateLists`/`mergeCandidates` and `LIMITS.maxAccumulatedCandidates`, and
  the Plan B reducer unit test. (2) `HistoryTurn` now also carries `clarification_question`; the
  `clarify` node stashes the question, `normalize` clears it per turn, and `finalize` records it
  next to the answer so a history entry like `answer: "both"` keeps the question that produced it.
- **Why:** Plan A's self-describing `cart_view` supplies `line_id` + `available_modifiers` for any
  cart-resident item deterministically, which is exactly what Plan B's accumulation was for — so
  Plan B no longer earned its cost: it injected earlier turns' items into `candidate_items` as
  stale `add_item` distractors (and a failed/abandoned turn's retrieved candidates persisted with
  no eviction). The cross-turn edit e2e still passes on Plan A alone. Separately, a clarification
  answer stored without its question was ambiguous context for later reference resolution.
- **Where:** `src/ordering/graph/state.ts`, `src/config/constants.ts`,
  `src/ordering/graph/build-graph.ts`, `src/ordering/schemas/order-graph-input.schema.ts`,
  `src/ordering/graph/state.test.ts`, `src/ordering/order-understanding-service.test.ts`,
  `src/ordering/final-transcript.e2e.ts` (comment only).
- **Notes:** Supersedes the "Plan B: candidates accumulate across turns" entry below — that
  channel is gone. `cart_view` and `history` remain the two cross-turn channels.

## 2026-07-08 — Fix: CartView name resolution for non-English menus
- **What:** `buildCartView` (`load-cart.node.ts`) now resolves a line's display name as
  `names.en_US ?? Object.values(names)[0] ?? menu_item_key ?? String(product_tmpl_id)`,
  matching the fallback chain already used in `candidate-matcher.ts` and `menu-store.ts`.
  Added a unit test for the non-en_US case.
- **Why:** The name previously fell back straight from `names.en_US` to the numeric
  `product_tmpl_id`, so a menu stored only under `zh_CN`/`fr_FR` gave every cart line the
  numeric id as its name — breaking Plan A's "match the reference to a line by name" and
  leaking a numeric id into the prompt.
- **Where:** `src/ordering/nodes/load-cart.node.ts`, `src/ordering/nodes/load-cart.node.test.ts`.

## 2026-07-08 — Plan A: self-describing cart + persisted conversation context
- **What:** (1) `load_cart` now projects the stored cart into a self-describing `CartView`
  (`buildCartView` in `load-cart.node.ts`, one batched `menu.getItems`): each line carries
  `line_id`, `name`, `menu_item_key`, its current modifiers, and the item's
  `available_modifiers` — keys/names only, numeric `product_tmpl_id`/`ptav_id` omitted. (2) A
  new `history` state channel + `finalize` graph node record each completed turn's
  `customer_text` + any `clarification_answer` and re-send them to the next turn's prompt as
  `conversation_history` (capped at `LIMITS.maxHistoryTurns = 6`). Graph is now
  `normalize → load_cart → retrieve → parse → decide{clarify | finalize}`. Prompt updated to
  describe the self-describing lines and a guardrail that history is reference-only (never
  re-execute). New unit tests (`buildCartView`, `mergeHistory`, two-turn history + cart-view
  prompt assertions); the e2e `add_modifier`/`remove_modifier`/cross-turn edit tests tightened
  from self-skip to hard assertions.
- **Why:** Make multi-turn cart edits deterministic. `current_cart` was numeric-only, so the
  model couldn't map "the chicken" → `line_id` or know a line's `modifier_key` vocabulary; and
  nothing about prior utterances reached the next turn, so references ("that", "the same")
  had nothing to resolve against. Plan B (candidate accumulation) only heuristically helped
  edits — a surviving candidate isn't linked to a `line_id`. Plan A fixes both at the source.
- **Where:** `src/ordering/nodes/load-cart.node.ts`, `src/ordering/graph/state.ts`,
  `src/ordering/graph/build-graph.ts`, `src/llm/prompt-builder.ts`,
  `src/ordering/schemas/order-graph-input.schema.ts`, `src/config/constants.ts`; tests in
  `src/ordering/nodes/load-cart.node.test.ts`, `src/ordering/graph/state.test.ts`,
  `src/ordering/order-understanding-service.test.ts`, `src/ordering/final-transcript.e2e.ts`.
- **Notes:** Layered on Plan B (candidates still accumulate; they supply modifiers for NEW
  `add_item`s and discussed-but-not-added items). Stored `Cart`/`CartLine` shape and the Redis
  contract are UNTOUCHED — `CartView` is a prompt-only projection. Replaced the raw `cart`
  state channel with `cart_view` (`base_version` still derives from the loaded cart in-node).
  `finalize` runs once per turn (direct + post-resume) before END; `normalize` clears the
  one-shot `clarification_answer` at the next turn's START, so the top-level field stays empty
  while the answer persists in history. The old "does not leak clarification answer" test was
  reframed: the top-level field must be empty, but the answer intentionally rides in history.

## 2026-07-08 — Plan B: candidates accumulate across turns
- **What:** Changed the `candidates` graph state channel from last-write-wins to a
  de-duplicating, size-capped merge (`mergeCandidateLists` + `mergeCandidates` reducer
  in `graph/state.ts`, bounded by new `LIMITS.maxAccumulatedCandidates = 24`). Each
  turn's `retrieve` now merges its matches into the persisted set (newest first, deduped
  by `menu_item_key`) instead of overwriting it. Added a deterministic reducer unit test
  (`graph/state.test.ts`) and a real-stack cross-turn e2e case in `final-transcript.e2e.ts`.
- **Why:** Closes the cross-turn modifier-edit gap: a turn like "add broccoli to that"
  (pronoun, no dish name) didn't surface the already-ordered item, so the model had no
  valid `modifier_key` for the existing line and the edit failed/clarified. The cart-keyed
  MemorySaver checkpointer already persists graph state across turns, so merging keeps the
  earlier turn's candidate (with its `available_modifiers`) alive for a later turn's `parse`.
- **Where:** `src/ordering/graph/state.ts`, `src/config/constants.ts`,
  `src/ordering/graph/state.test.ts` (new), `src/ordering/final-transcript.e2e.ts`.
- **Notes:** Plan B chosen over Plan A (cart enrichment) — a heuristic bounded by the cap +
  recency, not a guarantee: edit an item surfaced many turns/items ago and its candidate may
  have been evicted. `retrieve` node unchanged (its return is now the reducer's `next`).
  Resume path re-enters at `clarify`→`parse` and skips `retrieve`, so no mid-turn double-merge.
  Trade-off: later turns carry earlier turns' items as `add_item` distractors — lower the cap
  if it biases matches. Plan A (deterministic, also fixes line identification) remains an escalation.

## 2026-07-08 — e2e coverage for edit ops + stricter clarification tests
- **What:** Added real-stack e2e cases for the four edit operations that had no
  coverage — `update_quantity`, `remove_item`, `add_modifier`, `remove_modifier` —
  each seeding a real menu line via a new `seedCartWithLine` helper (resolves a real
  product_tmpl_id + modifier keys through the live candidate matcher) and asserting
  the proposed op targets the seeded string `line_id` and the applied cart reflects it.
  The two clarification tests now FAIL (were: self-skip) when the model doesn't ask.
- **Why:** Every prior e2e started from an empty cart, so only `add_item` (+ inline
  modifiers) and the clarify branch were exercised; the edit ops were untested e2e.
- **Where:** `src/ordering/final-transcript.e2e.ts`.
- **Notes:** update_quantity/remove_item self-skip only if the model picks a different
  valid op; add_modifier/remove_modifier are more tolerant (self-skip) because editing a
  modifier on an existing line depends on candidate retrieval surfacing the item's
  modifier_key from a transcript naming no dish — a genuine weak spot in the pipeline
  (retrieve-candidates keys off the transcript only, not the cart's lines).
- **Known-gap test:** added an `it.fails` case ("cross-turn modifier edit by reference")
  that drives a real two-turn flow on one cart — add by name, then edit by pronoun
  ("add broccoli to that") — and asserts the DESIRED outcome (broccoli lands on the
  line). It passes today because that outcome does NOT hold: on the edit turn the model
  has no valid modifier_key for the prior-turn line. When the cart-enrichment fix lands,
  `it.fails` flips to failing and the marker should be removed. Fix options captured for
  later: (A) enrich current_cart with each line's item name + available_modifiers/keys;
  (B) accumulate candidates across turns instead of last-write-wins in the graph state.

## 2026-07-08 — Prompt: inline modifiers on add_item
- **What:** Reworded the order-parse system prompt in `buildPrompt` to state that a
  new item's extras/omissions belong in `add_item.modifiers` (inline), that
  add_modifier/remove_modifier only edit lines already in `current_cart` via a string
  `line_id`, and added a worked add_item-with-modifier JSON example.
- **Why:** e2e modifier tests failed — the model split "chicken with broccoli" into
  add_item + add_modifier, inventing a numeric `line_id` (a leaked ptav_id/tmpl_id) for
  a line that doesn't exist yet, so schema validation/repair failed → order_parse_failed.
- **Where:** `src/llm/prompt-builder.ts` (`buildPrompt`).
- **Notes:** Prompt-only; the add_item schema already supported inline `modifiers`.
  Candidate serialization still leaks numeric `ptav_id`/`product_tmpl_id` — not fixed here.

## 2026-07-08 — Realtime gateway frontend-integration doc
- **What:** Added `docs/realtime-gateway-frontend-integration.md` — client-facing
  spec for the `/ws` WebSocket: endpoint/port, query-string auth (+`4001`), heartbeat,
  the inbound/outbound message schemas (`voice.*` / `order.*` / `cart.*` / `connection.*`),
  audio format (base64 PCM16 @ 16 kHz), the `Cart` shape, turn lifecycle, and reconnect.
- **Why:** Frontend needs the exact wire contract to integrate against the gateway.
- **Where:** `docs/` (new); derives from `src/realtime/*`, `src/auth/session-auth.ts`,
  `src/voice/voice-message-handler.ts`, `src/cart/cart-types.ts`, `src/config/*`.
- **Notes:** Doc-only, no code change. Flags that `authenticate()` is still a stub
  (`token` parsed but unverified).

## 2026-07-08 — Real-stack e2e for the final-transcript pipeline
- **What:** New `src/ordering/final-transcript.e2e.ts` — an opt-in e2e that emits
  `stt.final_transcript.received` on a real `EventBus` and drives the full pipeline
  against LIVE Redis Stack (real menu + `idx:menuvec`), LIVE Jina query embeddings,
  and a LIVE Ollama LLM (default `qwen3:14b`), asserting the applied cart plus the
  proposed operations (schema-valid; add_item resolves to the ordered dish; modifiers
  resolve key→ptav_id and land on the cart line). Covers happy add, quantity, add- and
  omit-modifiers, and clarify→resume / clarify→timeout (best-effort: the clarify tests
  self-skip when the model doesn't ask; parse-failure is skipped — can't be forced with
  a compliant LLM, covered by `order-understanding-service.test.ts`). Ships
  `vitest.e2e.config.ts` (loads `.env`, forces `LLM_PROVIDER=ollama`, `LLM_TIMEOUT_MS`,
  240s test timeout) and a `test:e2e` script. Named `*.e2e.ts` so `npm test` never runs
  it. Made the LLM per-request timeout configurable via `LLM_TIMEOUT_MS` (env.ts +
  openai-compatible-provider.ts), default 30s — qwen3:14b thinks well past 30s.
- **Why:** Verify the whole trigger→propose→apply flow end-to-end on the real stack,
  not just service-level fakes.
- **Where:** `ordering` (e2e), `llm`/`config` (configurable timeout), `vitest.e2e.config.ts`, `package.json`.
- **Notes:** Requires Redis Stack (RediSearch) with the menu populated + `npm run index:menu`,
  a `JINA_API_KEY` (EMBEDDING_PROVIDER=jina) for real KNN retrieval, and Ollama serving the
  model. The suite self-skips if any is unreachable.
## 2026-07-08 — Realtime: harden the `ws` transport error paths
- **What:** Two crash-safety fixes in `websocket-server.ts`. (1) The
  `socket.on('message')` handler now `.catch()`es `gateway.onRawMessage` — a
  downstream rejection (STT open failure, cart-cache error) was floating
  unhandled. (2) The per-socket `'error'` listener moved above the auth check so
  auth-rejected sockets are covered too (an unhandled `'error'` on a ws socket is
  an uncaught throw); `session_id` is threaded via a closure var. Added a test
  that a rejecting gateway does not crash the server.
- **Why:** Both were error-path process crashes (`unhandledRejection` / uncaught
  `'error'`) that the happy-path tests never exercised.
- **Where:** `src/realtime/websocket-server.ts`,
  `src/realtime/websocket-server.test.ts`. No behavior/structure change to the
  documented transport, so no bundle edit.

## 2026-07-08 — Realtime: wire the `ws` transport (gateway goes live)
- **What:** Replaced the `websocket-server.ts` stub with a real `ws`
  `WebSocketServer` on path `/ws`, attached to an `http.Server` that also serves
  `GET /health`. Per socket: authenticate from URL query params (close `4001` on
  failure), build a `ClientConnection` adapter, forward message/close/error to the
  gateway, and run a single heartbeat interval (ping; miss one → `terminate()`,
  per `TIMEOUTS.heartbeatIntervalMs`). The handle now exposes the `http.Server`
  and closes the interval + both servers on shutdown. Added
  `websocket-server.test.ts` (connect+resume round-trip, 4001 on missing auth,
  `bad_message` on malformed frame, `/health`).
- **Why:** The gateway logic was complete but had no live transport; this lets the
  app accept real WebSocket clients end-to-end (design §4, §3/§11.1).
- **Where:** `src/realtime/websocket-server.ts`,
  `src/realtime/websocket-server.test.ts` (new). No changes to gateway/router/
  registry/contracts. `app.ts` wiring unchanged (still `startWebSocketServer`/
  `.close()`).
- **Notes:** Auth stays the query-param stub (`?token&session_id&cart_id&pos_config_id`)
  — signed-token verification is still a TODO. A server-side reconnect-hold timer
  (§11.1 "short window") was left out; the client-driven `connection.resume` path
  already returns a fresh snapshot.

## 2026-07-08 — LLM: OpenAI-compatible provider (Ollama by default)
- **What:** New `src/llm/openai-compatible-provider.ts` —
  `OpenAiCompatibleLlmProvider` uses the OpenAI SDK against a configurable
  base URL, so one client serves Ollama (default `http://localhost:11434/v1`),
  OpenAI, Groq, etc. Forces `response_format: json_object`, `temperature: 0`,
  30s timeout, SDK transport retries = `LIMITS.llmTransportMaxRetries` (distinct
  from `llmMaxRetries`, the schema-repair budget). `LLM_API_KEY` has no default
  and is required (constructor throws when empty). `createLlmProvider` now
  routes `ollama`/`openai` to it (default stays stub). Added `openai` dependency.
- **Why:** Wire a real, locally-runnable LLM; the OpenAI SDK + env-driven base
  URL keeps the parser provider-agnostic (design §8/§14).
- **Where:** `src/llm/openai-compatible-provider.ts` (new), `src/llm/llm-client.ts`,
  `src/config/env.ts` (`llmModel`/`llmBaseUrl`/`llmApiKey`; default `LLM_PROVIDER`
  now `stub`), `.env.example`, `package.json`.
- **Notes:** Local use: `ollama pull llama3.1` then `LLM_PROVIDER=ollama`. For
  OpenAI, set `LLM_BASE_URL=https://api.openai.com/v1`, `LLM_MODEL`, `LLM_API_KEY`.
## 2026-07-08 — Menu search hardening: hybrid retrieval, error fallback, read-time availability
- **What:** Fixed a batch of issues in the Redis vector-search refactor.
  (1) `knnSearch` now catches FT.SEARCH errors and degrades to an empty result, so
  a missing/incompatible index falls back to the fuzzy scan instead of failing the
  order turn (previously a thrown error propagated to `order_parse_failed`; a
  half-applied fix also shadowed `reply` and broke parsing). (2) `candidate-matcher`
  now retrieves a **union of KNN + lexical** name matches (new `MenuStore.lexicalSearch`
  over a `name` TEXT field), restoring recall for lexically-close items the vector
  search misses. (3) Availability is no longer indexed — the KNN query dropped its
  `@available` filter; `rank()`'s live-blob check is the sole gate, so re-enabling an
  item needs no reindex. (4) `ensureMenuIndex` records a schema+dim signature
  (`menu:index:meta`) and drops+recreates the index when either drifts (dimension
  change / schema bump). (5) `index-redis-menu.ts` skips wrong-width vectors instead
  of writing dead docs, and writes the `name` field. (6) COSINE similarity clamped to
  [0,1]. (7) KNN over-fetches `k·4` docs and dedupes to `k` distinct items (per-language
  doc explosion). (8) per-phrase KNN searches run concurrently. (9) cart repricing
  batches line lookups through `MenuLookup.getItems` (one MGET) instead of a GET per
  line per op. (10) added tests for the FT.SEARCH request shape, `lexicalSearch`, and
  `ensureMenuIndex`; `InMemoryMenuStore` mirrors the read-time-availability semantics.
- **Why:** Code review of the vector-search branch: the promised fuzzy fallback never
  fired on a missing index, retrieve-then-rerank silently dropped high-fuzzy items,
  availability edits were invisible until reindex, and repricing did N sequential
  round trips.
- **Where:** `menu/menu-store.ts`, `menu/menu-index.ts`, `menu/candidate-matcher.ts`,
  `menu/in-memory-menu-store.ts`, `menu/menu-service.ts`, `cart/cart-operation-applier.ts`,
  `scripts/index-redis-menu.ts`, and their tests.
- **Notes:** Schema change (added `name` TEXT, dropped `available` TAG) → `SCHEMA_VERSION`
  bumped; the first boot / `index:menu` after deploy rebuilds `idx:menuvec` automatically.

## 2026-07-07 — Menu matching: Redis KNN vector search, drop the in-memory cache
- **What:** The menu module now runs a RediSearch KNN vector search per request
  instead of loading the whole menu into an in-memory cache at boot. New
  `menu-index.ts` (the `idx:menuvec` FLAT/COSINE index + `menu:vec:{pos}:{tmpl}:{i}`
  HASH docs — one vector per (item, language), since KNN can't index a multi-vector
  field) and `menu-store.ts` (`MenuStore` interface + `RedisMenuStore`:
  `knnSearch`/`getItem`/`getItemByKey`/`allItems`). `candidate-matcher.ts` is now
  retrieve-then-rerank: embed phrases → KNN per phrase → hydrate the union →
  hybrid-rank (embed+fuzzy+modifier), with a fuzzy-scan fallback when no embeddings/
  index exist. New `scripts/index-redis-menu.ts` (npm `index:menu`) projects the
  index + `menu:key:*` lookups from the EXISTING item blobs (additive; never mutates
  source data). Deleted `menu-cache.ts` and `menu-repository.ts`; added
  `in-memory-menu-store.ts` as the test/dev `MenuStore`.
- **Why:** The in-memory cosine scan was the documented scale-up bottleneck
  (design §7/§13); vector search removes the RAM cache and the per-boot menu load.
- **Where:** `src/menu/*` (matcher, service, new store/index, removed cache/repo),
  `src/cart/cart-operation-applier.ts` + `cart-validator.ts` (now async — the menu
  lookups they call became async Redis reads), `src/cart/cart-controller.ts`
  (`await applyOperation`), `src/app.ts` (drop boot-load loop, `ensureIndex` at
  start), `docker-compose.yml` (`redis/redis-stack-server` for the RediSearch
  module), `package.json` (`index:menu`).
- **Notes:** Requires the RediSearch module (Redis Stack / Redis 8); on plain Redis
  the matcher falls back to a fuzzy scan. `resolveItemKey`/`findByTmplId` are now
  `Promise`-returning (`MenuLookup`). Verified end-to-end against Redis Stack: seed
  → `index:menu` → KNN match ranks the right items and excludes unavailable ones.
  The `available` TAG is stamped at index time, so availability changes need an
  `index:menu` re-run. Run order for a fresh corpus: `embed:menu` then `index:menu`.
## 2026-07-08 — Close two gaps in the voice.stop / STT-open flow
- **What:** Two correctness fixes surfaced in review. (1) `handleStop`'s idempotency
  guard now also checks `session.stopping`, not just `finalTimer`/terminal status.
  Because `stopping` is set synchronously before the `await session.stream.stop()`
  yields, a second `voice.stop` that interleaves *during* the flush (messages are
  dispatched without awaiting in `socket.on('message', …)`) no longer calls
  `stream.stop()` — and thus `forceEndpoint()`/`close(true)` — a second time on an
  already-closing socket. (2) `handleStart` now wraps `stt.openStream()` in
  try/catch: an AssemblyAI auth/handshake rejection (§11.2 A, newly reachable now
  that the real provider connects) removes the orphaned `idle` session, sends a
  `voice.error` (stt_failed), and emits `voice.session_failed` instead of leaking an
  unhandled promise rejection and leaving a dead session in the manager.
- **Why:** A double/concurrent stop double-flushed the STT socket; a failed stream
  open silently orphaned the session with no client notification.
- **Where:** `voice/voice-message-handler.ts` (+ test).

## 2026-07-08 — Suppress stray finals and late audio after voice.stop
- **What:** Two correctness fixes around the post-`voice.stop` window. (1) `onFinal`
  now bails when the session is already terminal (`ended`/`failed`/`interrupted`),
  so a final that lands after the §11.2 C timeout has failed the session no longer
  emits `stt.final_transcript.received` — previously it still reached the cart after
  the customer was told to repeat, risking a double order. (2) `VoiceSession` gains a
  `stopping` flag set at the start of `handleStop`; `handleAudioChunk` drops audio
  while stopping, so trailing chunks are no longer fed into the flushing/closed STT
  stream (status stays `listening` for the grace window, so the old
  `status !== 'listening'` gate no longer covered this).
- **Why:** A late final could mutate the cart for an utterance the user was asked to
  repeat; late audio chunks were forwarded into an already-flushed AssemblyAI socket.
- **Where:** `voice/voice-message-handler.ts` (+ test), `voice/voice-session.ts`.

## 2026-07-08 — Fix duplicate session failure on the stop-without-final path
- **What:** Two correctness fixes to the §11.2 C flow. (1) `AssemblyAiSttProvider`
  now tracks a `selfClosing` flag set by `stop()`/`close()`, and its `'close'`
  handler only raises `onError` for an *unexpected* close before a final — a close
  we initiated is expected, leaving the handler's finalTranscript timeout as the
  single authority for the no-final case. Previously a graceful stop with no speech
  fired `onError` (stt_failed) *and* the 4s timeout (final_transcript_timeout),
  double-failing the session and preempting the grace window. (2) `handleStop`
  ignores a repeat `voice.stop` while a grace window is pending or the session is
  terminal (was re-flushing a closing socket and orphaning the first timer). The
  timeout callback also bails if the session already failed.
- **Why:** One stop could emit two `voice.session_failed` events and two
  `voice.error` messages to the client, and the intended 4s grace window was
  bypassed for graceful closes.
- **Where:** `stt/assemblyai-stt-provider.ts` (+ test),
  `voice/voice-message-handler.ts` (+ test).

## 2026-07-08 — Wire real AssemblyAI STT behind the swappable provider seam
- **What:** New `AssemblyAiSttProvider` (`src/stt/assemblyai-stt-provider.ts`)
  implements `SttProvider` using AssemblyAI universal-streaming: maps `turn` events
  to `onPartial` (non-final) / `onFinal` (formatted end-of-turn, deduped by
  `turn_order`) / `onError` (provider error or a close before any final — §11.2 B).
  A transcriber factory is injectable for hermetic tests. `createSttProvider`
  selects `assemblyai` (falls back to `NoopSttProvider` with a warning when
  `ASSEMBLYAI_API_KEY` is unset). Implemented the §11.2 C final-transcript timeout
  in `VoiceMessageHandler.handleStop` (arms `TIMEOUTS.finalTranscriptMs`; a late
  final cancels it and ends the session, else `voice.session_failed` +
  `voice.error` reason `final_transcript_timeout`). Added `finalReceived` /
  `finalTimer` to `VoiceSession`; timer is cleared on disconnect.
- **Why:** The pipeline had only `NoopSttProvider`, so no transcript ever flowed;
  and the stop-without-final path was a TODO. Keeps STT trivially swappable — a new
  provider is one file + one `case`.
- **Where:** `stt/assemblyai-stt-provider.ts` (new) + test, `stt/stt-client.ts`,
  `voice/voice-message-handler.ts` (+ test), `voice/voice-session.ts`,
  `config/env.ts`, `.env.example`.
- **Notes:** Audio contract is PCM16 mono @ `STT_SAMPLE_RATE` (default 16000);
  `sendAudio` slices the Buffer's backing `ArrayBuffer` for the SDK. `stop()` calls
  `forceEndpoint()` then `close(true)` to flush a pending final. Failure reasons
  reuse the existing `voice.session_failed` event (no new event-map entries).

## 2026-07-07 — Backfill: embed an already-seeded Redis menu in place
- **What:** New `scripts/embed-redis-menu.ts` (npm `embed:menu`). Reads each
  existing `menu:item:{pos}:{id}` record straight from Redis, embeds its
  per-language names ('passage' role, mirroring `MenuCache.embedNames`), writes the
  `vectors` back into the record, and stamps `menu:meta:{pos}.embedding =
  { model, dimensions }`. Discovers pos_config_ids via `SCAN menu:meta:*`; embeds in
  chunks of 100 names/request; idempotent (re-run overwrites vectors).
- **Why:** The corpus was already seeded from Odoo (351 items, pos 1) but written
  WITHOUT vectors and with no `menu:meta.embedding`. `populate-redis-menu.ts`
  re-sources from Postgres; this backfills embeddings using only what's in Redis.
- **Where:** `scripts/embed-redis-menu.ts` (new), `package.json` (`embed:menu`).
- **Notes:** Requires `EMBEDDING_PROVIDER=jina` + `JINA_API_KEY`; exits early (no
  Redis writes) if the embedder yields 0 dims. Only `names` are embedded (not
  `alternative_name`/`descriptions`) so seed vectors match what the runtime matcher
  would produce. Run: `EMBEDDING_PROVIDER=jina JINA_API_KEY=… npm run embed:menu`.

## 2026-07-07 — Redis review follow-ups: graceful close + embedder-mismatch caveat
- **What:** (1) Shutdown now calls a new `closeRedisClient()` that `quit()`s the
  shared connection (drains in-flight commands, vs the old abrupt `disconnect()`)
  and clears the module singleton so a later `createRedisClient()` (restart/tests)
  gets a live client. (2) Documented `CartId` as MUST-be-globally-unique (it is the
  un-namespaced `cart:{cart_id}` key).
- **Why:** Code-review findings: `disconnect()` could drop in-flight cart writes and
  left a permanently-dead cached client after `stop()`; the cart key is not scoped
  by `pos_config_id`, so uniqueness must hold at the `cart_id` level.
- **Where:** `src/redis/redis-client.ts`, `src/app.ts`, `src/shared/types.ts`.
- **Notes:** KNOWN CAVEAT (not yet fixed) — `menu-repository.ts` checks stored
  vector length against `config.embeddingDimensions` (a static config default), not
  the *live* embedder's `dimensions`. If the menu is seeded with `jina` (1024-dim)
  but the app runs the default `stub` embedder (0-dim query vectors), no dim
  warning fires yet `cosine()` returns 0 for every item, so retrieval silently
  degrades to fuzzy-only. A real fix should compare stored dims against the running
  embedder (and/or against `menu:meta.embedding`) and warn when they differ.

## 2026-07-07 — Redis: real client, cart read/write, menu+embeddings persisted
- **What:** Replaced the Redis stubs with a real `ioredis` integration. (1)
  `redis/redis-client.ts` now returns a shared `ioredis` connection. (2)
  `redis/cart-cache.ts` gained `RedisCartCache` (key `cart:{cart_id}`, JSON blob) —
  `app.ts` uses it instead of `InMemoryCartCache`, so carts read/write from Redis.
  (3) `scripts/populate-redis-menu.ts` now embeds each item's per-language names
  ('passage' role, mirroring `MenuCache.embedNames`) and writes them as `vectors`
  inside each `menu:item` record; `menu:meta` records the embedding model/dims.
  (4) New `menu/menu-repository.ts` (`RedisMenuRepository`) reads items+vectors
  from Redis and `MenuCache.loadIndexed` / `MenuService.loadIndexedMenu` load them
  without re-embedding; `app.start()` auto-discovers seeded menus via `SCAN
  menu:meta:*` and loads each.
- **Why:** The scaffold had Redis stubs but nothing talked to Redis; items,
  embeddings, and carts need to persist in and load from Redis.
- **Where:** `src/redis/redis-client.ts`, `src/redis/cart-cache.ts`,
  `src/menu/menu-repository.ts` (new), `src/menu/menu-cache.ts`,
  `src/menu/menu-service.ts`, `src/app.ts`, `scripts/populate-redis-menu.ts`;
  tests `src/redis/cart-cache.test.ts`, `src/menu/menu-repository.test.ts` (new).
- **Notes:** Cart key is `cart:{cart_id}` (globally-unique text id) — the
  `CartCache` interface only receives `cart_id`, so `pos_config_id` is not in the
  key. Vectors ride inside the item JSON and the in-process cosine scan is
  unchanged (no RediSearch; plain `redis:7-alpine`). Seeding writes real vectors
  only with `EMBEDDING_PROVIDER=jina` + `JINA_API_KEY`; otherwise items are written
  vectorless and the read-time dim check warns. Still stubs: `CartRepository`
  idempotency ledger + `saveSnapshot`, and the LangGraph `MemorySaver`.

## 2026-07-07 — Ordering: fix cross-turn clarification leak + proposal-emit misclassification
- **What:** Two review fixes. (1) The `normalize` node now resets the one-shot
  `clarification_answer` channel to `undefined`; because the cart-keyed checkpointer
  thread persists across turns, a prior turn's answer was leaking into the next turn's
  parse prompt. `normalize` runs only on a fresh `start()` (a resume re-enters at
  `clarify`), so a within-turn answer still survives to `parse`, while durable cart
  context still persists. (2) `order-understanding-service.ts` now emits the proposal
  OUTSIDE the parse `try/catch` (extracted `runTurn()`): a throwing
  `order.operations_proposed` subscriber was being caught and mis-reported as
  `order_parse_failed`, double-emitting a proposal AND `voice.session_failed`.
- **Why:** Correctness bugs found in code review of the LangGraph port.
- **Where:** `src/ordering/graph/build-graph.ts`, `src/ordering/order-understanding-service.ts`,
  `src/ordering/order-understanding-service.test.ts` (2 regression tests).
- **Notes:** Confirmed cross-turn persistence is intended (context follows the cart), so
  the fix clears only the per-turn signal — it does not drop the thread. `MemorySaver`
  in-process growth (one thread per cart) is an accepted consequence of that design; a
  durable/bounded checkpointer remains a later step.

## 2026-07-07 — Ordering: real LangGraph + clarification resume + repair + zod
- **What:** Ported `ordering/order-graph.ts` from the hand-rolled pipeline to a real
  `@langchain/langgraph` `StateGraph` (`graph/state.ts` + `graph/build-graph.ts`,
  nodes `normalize → load_cart → retrieve → parse → decide{propose|clarify}`),
  compiled with a `MemorySaver` checkpointer keyed `thread_id=${pos_config_id}:${cart_id}`.
  Implemented clarification pause/resume via `interrupt()` + `Command({resume})`, with
  `OrderGraph.start()/resume()` returning a `GraphTurnResult`. Rewrote
  `order-understanding-service.ts` to drive the clarification loop while HOLDING the
  per-cart FIFO slot (turn 2 blocks) with a `TIMEOUTS.clarificationMs` timeout →
  `voice.session_failed(clarification_timeout)`; `handleClarificationAnswer` now
  actually resumes (was a no-op). Added schema-repair retry
  (`nodes/parse-and-validate.node.ts` + `buildRepairPrompt`). Migrated
  `schemas/cart-operation` + `order-graph-output` to zod (`zod-error.ts` helper).
  Added `order-understanding-service.test.ts` (7 tests).
- **Why:** Close checklist §5 — real pause/resume, graceful LLM-failure handling,
  and validated LLM I/O per design §6/§8/§9/§11.3.
- **Where:** `src/ordering/**` (graph, nodes, schemas, service), `src/llm/prompt-builder.ts`.
- **Notes:** Verified LangGraph interrupt/resume semantics by spike (interrupted
  invoke returns `__interrupt__`; thrown node rejects invoke; plain input on a paused
  thread restarts — so a timed-out clarification needs no thread cleanup). `MemorySaver`
  is in-process; a durable checkpointer is a later step. `supported_languages` still
  hardcoded `[]`. Full suite: 20 tests green, `tsc` clean.

## 2026-07-07 — Populate Redis with menu items from the Odoo dump
- **What:** Added `scripts/populate-redis-menu.ts` (+ `populate:menu` npm script,
  `tsx` devDependency) that reads POS-available products from an Odoo Postgres
  (the restored `jadegarden1` dump) and writes one JSON blob per item to Redis:
  `menu:item:{pos_config_id}:{product_tmpl_id}` (translated `names` + `descriptions`
  keyed by res.lang, `alternative_name`, `base_price_cents`, `available`, POS
  `categories`, and `modifiers` from `product_template_attribute_value` with
  translated value names + `price_extra_cents`), plus `menu:items:{pos_config_id}`
  (SET of ids) and `menu:meta:{pos_config_id}`.
- **Why:** Seed the menu into Redis (item names, translations, price, availability,
  modifiers) for the voice ordering flow.
- **Where:** `scripts/populate-redis-menu.ts`, `package.json`.
- **Notes:** Source is the `jadegarden1` Odoo dump restored into a throwaway
  Postgres container (`SOURCE_DATABASE_URL`, default `localhost:5433`); Redis via
  `docker compose up -d redis`. Loaded 351 items (pos_config_id=1 "Jade Garden";
  config 2 is unused), 213 with modifiers, languages en_US + zh_CN. This dump has
  **no description data** (all description columns NULL) — `descriptions` is written
  as `{}`; the Chinese name lives in `alternative_name`. Money in integer cents.
## 2026-07-07 — Drop local Postgres (our state → Redis)
- **What:** Removed our own Postgres entirely. Deleted `src/db/db.ts` (`Db` stub),
  `scripts/migrate.ts`, the `migrate` npm script, the `pg`/`@types/pg` deps,
  `DATABASE_URL` (config + `.env.example`), and our DDL (`02_settings`, `04_carts`,
  `05_order_confirmations`, `06_voice`, `07_server_calls`). `CartRepository` no
  longer takes a `Db` (in-memory Maps, to be backed by Redis); `app.ts` stops
  constructing `db`. Rewrote `db/schema/README.md` and the persistence/cart
  knowledge bundles around two stores.
- **Why:** Decision: no local Postgres. Our durable app state (cart registry +
  snapshots, sessions, transcripts, clarifications, server calls, idempotency,
  order-confirmation bridge) targets **Redis** instead.
- **Where:** `src/db/`, `scripts/`, `src/app.ts`, `src/cart/cart-repository.ts`,
  `src/config/env.ts`, `.env.example`, `package.json`, knowledge bundles.
- **Notes:** Scope is **our** Postgres only — the **Odoo POS** database stays the
  read-only source of truth (menu reads, `pos_order` writes); `01_external_odoo.sql`
  (reference-only, no DDL) is kept. `confirmOrder` will use an Odoo client. Redis
  wiring itself is still a stub (`redis/*`), so state is in-memory for now. NOTE:
  `design.cleaned.md` still documents the old three-store (Postgres) design — not
  updated here.

## 2026-07-07 — Jina AI text embeddings (swappable provider)
- **What:** Replaced the dead embedding term with a real provider. Extended
  `EmbeddingService` (added `dimensions` + `embedBatch` + an optional
  `role: 'query' | 'passage'` hint), added `JinaEmbeddingService` (Jina
  `/v1/embeddings`, `jina-embeddings-v3`, batched, `index`-ordered parse, one
  retry on 429/5xx, fail-fast on 4xx) and a `createEmbeddingService()` factory —
  the single swap point, mirroring `createLlmProvider`/`createSttProvider`.
  `MenuCache` now embeds names as `'passage'`, `CandidateMatcher` embeds transcript
  phrases as `'query'` (design §7 asymmetric retrieval). Config gained
  `EMBEDDING_PROVIDER`, `EMBEDDING_DIMENSIONS`, `JINA_API_KEY`, `JINA_BASE_URL`;
  default model is now `jina-embeddings-v3`.
- **Why:** The stub returned `[]`, so cross-language matching (design §7/§15) was
  impossible with fuzzy signals alone. Swapping the model is now an env change.
- **Where:** `menu` module (`embedding-service.ts`, new `jina-embedding-service.ts`,
  `menu-service.ts`, `menu-cache.ts`, `candidate-matcher.ts`); `config/env.ts`;
  `.env.example`; new `menu/jina-embedding-service.test.ts`.
- **Notes:** Default provider stays `stub` (zero behavior change until
  `EMBEDDING_PROVIDER=jina` + `JINA_API_KEY` are set). Embeddings live **in-memory
  only** — see the removal entry below.

## 2026-07-07 — Drop Postgres embedding store (in-memory only)
- **What:** Removed the pgvector persistence path: deleted `03_embeddings.sql`
  (`menu_embeddings` table), `00_extensions.sql` (its only content was the `vector`
  extension), `scripts/refresh-embeddings.ts`, and the `refresh:embeddings`
  npm script. Updated `db/schema/README.md` (file list, `01`→`07` ordering, FR5
  coverage) and the persistence/menu knowledge bundles.
- **Why:** Decision: embeddings are not stored in Postgres. The Menu Candidate
  Matcher keeps them in memory (design §7), so the persistent vector store and its
  re-embed script are dead weight.
- **Where:** `src/db/schema/`, `scripts/`, `package.json`, knowledge bundles.
- **Notes:** No table used `vector` besides `menu_embeddings`; `gen_random_uuid()`
  is core PG13+, so removing `00_extensions.sql` needs no replacement.

## 2026-07-07 — Docker setup (app + Redis)
- **What:** Added `Dockerfile` (3-stage on `node:26-alpine`: build → compile TS,
  deps → prod-only `node_modules`, runtime → copies both and runs `dist/server.js`
  as non-root `node`), `.dockerignore`, and
  `docker-compose.yml` with a `redis:7-alpine` service (persisted volume,
  healthcheck) plus the `app` service wired to it via `REDIS_URL=redis://redis:6379`.
- **Why:** Provide a local containerized run. Redis is the only backing service
  needed right now; Postgres is intentionally omitted.
- **Where:** repo root (build/infra tooling); no source modules touched.
- **Notes:** `app` reads `.env` via `env_file` and overrides `REDIS_URL` to reach
  the compose Redis. `docker compose config` validates. No Postgres service —
  add one later if the `DATABASE_URL` stubs get wired.

## 2026-07-07 — Menu candidate matcher: hybrid ranking + Vitest
- **What:** Replaced the naive substring placeholder in `candidate-matcher.ts` with
  hybrid ranking (embedding cosine + fuzzy + modifier, availability-filtered,
  top-N). Added `fuzzy-matcher.ts` (Levenshtein + substring similarity) and
  `modifier-matcher.ts` (phrase↔modifier scoring). `menu-cache.ts` now precomputes
  per-language name vectors at load via the injected `EmbeddingService` (async
  `load`); added `MenuVector` + `IndexedMenuItem`. `MenuService` injects the
  embedder (defaults to `StubEmbeddingService`); `loadMenu`/`getCandidates` are now
  async. Dropped `aliases` and `popularity` from ranking and from `MenuItem`.
- **Why:** Turn the §7 candidate matcher from a placeholder into real, tested
  ranking logic that degrades to fuzzy/modifier when the embedder is a stub and
  sharpens when a real embedder is injected.
- **Where:** menu module; `ordering/nodes/retrieve-candidates.node.ts` and
  `ordering/order-graph.ts` await the now-async call.
- **Notes:** Stood up Vitest — `vitest.config.ts`; `tsconfig.build.json` excludes
  `*.test.ts` from the emitted build; `build` script → `tsconfig.build.json`
  (`typecheck` still covers tests). 13 tests pass, `tsc --noEmit` green. Installed
  runtime deps (`ws`, `ioredis`, `pg`, `zod`, `@langchain/langgraph`, `assemblyai`)
  + dev types (`@types/ws`, `@types/pg`, `vitest`). Still stubbed/deferred: the real
  embedding provider (`StubEmbeddingService` returns `[]`) and the Odoo
  menu-repository load. Redis vector search (to replace the per-phrase vector loop)
  was considered and **deferred** — needs Redis Stack/RediSearch + a fixed embedding
  DIM, and §13 notes the search is <1 ms and not the bottleneck at ≤2k items.

## 2026-07-07 — Cart Module unit tests
- **What:** Added vitest suites for the Cart Module (33 tests): `cart-operation-applier.test.ts`
  (every op × valid/reject branch, pricing, immutability, modifier idempotence),
  `cart-validator.test.ts` (ok(void) + rejection mirrors the applier, no mutation),
  and `cart-controller.test.ts` (cart creation, one-version-bump-per-proposal,
  idempotency by `request_id`, mixed-batch apply+reject events, session_id
  forwarding, rebase from a stale `base_version`, and apply-lock serialization of
  concurrent applies).
- **Why:** Lock in the deterministic §9 Tier-2 behavior (sole writer, rebase,
  idempotency, versioning) before persistence/pricing are wired for real.
- **Where:** `cart` module (tests only; no behavior change).
- **Notes:** Tests use the real in-memory deps (MenuService, InMemoryCartCache,
  CartRepository, EventBus) — no mocks. Added `src/**/*.test.ts` to tsconfig
  `exclude` so `tsc` build/typecheck skip tests; vitest transpiles them. Verified:
  `vitest run src/cart` 33 passed; `npm run typecheck` exit 0; test files typecheck
  clean under a temp include.

## 2026-07-07 — Scaffold the modular monolith
- **What:** Generated the full TypeScript (ESM) source tree from design §12 — 62
  files across realtime, voice, stt, ordering, menu, llm, cart, events, redis, db,
  config, shared, observability, auth, api — plus `app.ts`/`server.ts` composition
  root, `.env.example`, `.gitignore`, README, and script stubs.
- **Why:** Turn the design document into a runnable, typed skeleton with real
  module boundaries and the event bus wired end-to-end.
- **Where:** all module bundles (realtime, voice, ordering, menu, llm, cart,
  events, persistence, platform).
- **Notes:** Dependency-light on purpose so `npm run typecheck` is green and the
  app boots with stub providers. `package.json` switched to `"type": "module"` and
  tsconfig `types: ["node"]` to satisfy the repo's `nodenext` + `verbatimModuleSyntax`
  config. External systems (STT, LLM, Redis, Postgres, `ws`, LangGraph, embeddings,
  Odoo menu load) are stubbed behind interfaces — search `TODO`. Real: typed event
  bus, WS contracts, cart validate/apply, per-cart FIFO + apply lock + version/rebase,
  idempotency, candidate matcher, reconnect/resume. Verified: `tsc --noEmit` exit 0;
  `node dist/server.js` boots and logs `app.started`.

## 2026-07-07 — Reconcile data schema with Odoo POS
- **What:** Rewrote the SQL schema to treat menu/modifiers/categories/combos/tables/
  restaurants as **externally owned by Odoo POS** (referenced by integer soft-ref),
  and re-keyed our tables to Odoo ids (`pos_config_id`, `product_tmpl_id`, `ptav_id`,
  `restaurant_table_id`). Dropped invented restaurant/menu/modifier/translation
  tables; replaced normalized `orders` with a `voice_order_confirmations` bridge to
  Odoo `pos_order`; added `voice_restaurant_settings`; multi-language now uses Odoo
  jsonb (`res.lang` codes).
- **Why:** The menu and restaurant data live in an existing Odoo POS database
  (`menu_restaurant_schema.md`); the app reads them and must not redefine them.
- **Where:** persistence (`src/db/schema/*.sql`, README).
- **Notes:** Confirmed orders are Odoo's system of record. Files: `01_external_odoo.sql`
  (reference-only), `02_settings.sql`, `03_embeddings.sql`, `04_carts.sql`,
  `05_order_confirmations.sql`, `06_voice.sql`, `07_server_calls.sql`. Unverified
  against a live Postgres/Odoo.

## 2026-07-07 — Initial data schema
- **What:** Created the first PostgreSQL DDL covering all functional requirements
  (sessions, transcripts, clarifications, carts, snapshots, idempotency, orders,
  server calls, embeddings).
- **Why:** Address the design's open "data schema" TODO.
- **Where:** persistence (`src/db/schema/`).
- **Notes:** Superseded the same day by the Odoo reconciliation above.
