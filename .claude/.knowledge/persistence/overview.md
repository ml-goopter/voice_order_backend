---
type: Concept
title: Persistence (Redis + Odoo)
description: Redis for hot/durable app state, Postgres/pgvector (in the Odoo DB) for the menu, Odoo POS as read-only source of truth.
resource: src/redis, src/db
timestamp: 2026-07-13
---

# Persistence

## Purpose
Durable and hot state for the system (design §9). Stores:
- **Redis** — live active carts (`cart:{cart_id}`, JSON blob). Our other durable
  app state (voice settings, cart registry + recovery snapshots, sessions,
  transcripts, clarifications, server calls, idempotency ledger, order-confirmation
  bridge) is still in-memory stubs. The Redis menu corpus (`menu:item:*` + RediSearch)
  is no longer the wired menu backend (see below) but its store/scripts remain.
- **Postgres/pgvector** — the wired **menu** backend. Our `item_vector` table lives
  **inside the Odoo Postgres DB** and holds per-restaurant membership + `menu_item_key`
  + one embedding row per (item, language). `PostgresMenuStore` KNN-searches it and
  JOINs Odoo's own tables for live metadata. Shared `pg.Pool` in
  `db/postgres-client.ts`; connection via `ODOO_DATABASE_URL`. (See the [menu](../menu/overview.md) bundle.)
- **Odoo POS Postgres** — menu, modifiers, categories, combos, tables, restaurants
  (`pos_config`), and confirmed orders (`pos_order`). READ-only; referenced by
  **integer soft-ref**, never redefined. (Odoo's own DB — which now also hosts our
  `item_vector` table.)

## Mechanics
- `redis/cart-cache.ts` — `CartCache` interface. `RedisCartCache` (on `ioredis`)
  is the runtime store: one JSON blob per cart at `cart:{cart_id}`
  (get/set/delete). `InMemoryCartCache` remains for tests. Key is `cart_id` only —
  the interface's `get`/`delete` receive no `pos_config_id`. A recovery snapshot
  (in `cart-repository`, still in-memory) mirrors the cache value.
- `redis/redis-client.ts` — `createRedisClient()` returns a shared `ioredis`
  connection (reused process-wide; logs connect/error).
- `db/postgres-client.ts` — `createPgPool()`/`closePgPool()` manage a shared `pg.Pool`
  to `ODOO_DATABASE_URL` (the menu store's `item_vector` table + Odoo reads).
- `cart/cart-repository.ts` — idempotency ledger + snapshots, in-memory Maps
  today; TODO back with Redis. `confirmOrder` writes to Odoo `pos_order` (stub).
- `db/schema/01_external_odoo.sql` + `README.md` — **reference only** for the Odoo
  tables we read (no DDL). Our identities are text keys (`cart_id`, `session_id`,
  `line_id`, `request_id`); Odoo identities are integers (`pos_config_id`,
  `product_tmpl_id`, `ptav_id`, `restaurant_table_id`, `pos_order_id`).
  Multi-language uses Odoo jsonb (`res.lang` codes). Money in cents.

## Dependencies
- `cart/cart-types` (`Cart` shape). Odoo reads depend on the Odoo POS database.

## Key files
- `redis/cart-cache.ts`, `redis/redis-client.ts`, `db/postgres-client.ts`,
  `cart/cart-repository.ts`.
- `db/schema/01_external_odoo.sql` + `db/schema/README.md` (Odoo reference).

## Not done yet
- `CartRepository`'s `confirmOrder` (writing confirmed carts to Odoo `pos_order`) is still
  a stub, and the LangGraph checkpointer is still `MemorySaver`. An Odoo client for reads +
  writing confirmed carts to `pos_order` is also pending.
