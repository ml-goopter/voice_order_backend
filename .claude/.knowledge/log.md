---
type: Log
title: Change Log
description: Chronological history of codebase changes (newest first).
timestamp: 2026-07-07
---

# Change Log

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
