---
type: Log
title: Change Log
description: Chronological history of codebase changes (newest first).
timestamp: 2026-07-07
---

# Change Log

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
