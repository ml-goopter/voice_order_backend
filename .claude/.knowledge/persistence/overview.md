---
type: Concept
title: Persistence (Redis + Odoo)
description: Two stores — Redis for all our state (hot + durable), Odoo POS as read-only source of truth.
resource: src/redis, src/db
timestamp: 2026-07-07
---

# Persistence

## Purpose
Durable and hot state for the system (design §9). **No local Postgres** — our own
state lives in Redis. Two stores:
- **Redis** — live active carts (`cart:{cart_id}`, JSON blob) plus the seeded menu
  corpus (`menu:item:{pos}:{id}` with precomputed name vectors). Our other durable
  app state (voice settings, cart registry + recovery snapshots, sessions,
  transcripts, clarifications, server calls, idempotency ledger, order-confirmation
  bridge) is still in-memory stubs.
- **Odoo POS Postgres** — menu, modifiers, categories, combos, tables, restaurants
  (`pos_config`), and confirmed orders (`pos_order`). READ-only; referenced by
  **integer soft-ref**, never redefined. (Odoo's own DB — not ours.)

## Mechanics
- `redis/cart-cache.ts` — `CartCache` interface. `RedisCartCache` (on `ioredis`)
  is the runtime store: one JSON blob per cart at `cart:{cart_id}`
  (get/set/delete). `InMemoryCartCache` remains for tests. Key is `cart_id` only —
  the interface's `get`/`delete` receive no `pos_config_id`. A recovery snapshot
  (in `cart-repository`, still in-memory) mirrors the cache value.
- `redis/redis-client.ts` — `createRedisClient()` returns a shared `ioredis`
  connection (reused process-wide; logs connect/error).
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
- `redis/cart-cache.ts`, `redis/redis-client.ts`, `cart/cart-repository.ts`.
- `db/schema/01_external_odoo.sql` + `db/schema/README.md` (Odoo reference).

## Not done yet
- `CartRepository` still keeps in-memory Maps (idempotency ledger + `saveSnapshot`);
  the LangGraph checkpointer is still `MemorySaver`. An Odoo client for reads +
  writing confirmed carts to `pos_order` is also pending.
