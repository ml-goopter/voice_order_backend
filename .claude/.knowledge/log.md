---
type: Log
title: Change Log
description: Chronological history of codebase changes (newest first).
timestamp: 2026-07-07
---

# Change Log

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
