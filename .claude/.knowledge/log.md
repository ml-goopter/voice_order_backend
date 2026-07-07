---
type: Log
title: Change Log
description: Chronological history of codebase changes (newest first).
timestamp: 2026-07-07
---

# Change Log

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
