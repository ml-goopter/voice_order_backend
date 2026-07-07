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
- **Redis** — live active carts (`cart:{pos_config_id}:{cart_id}`) **and** our
  durable app state: voice settings, cart registry + recovery snapshots, sessions,
  transcripts, clarifications, server calls, idempotency ledger, order-confirmation
  bridge. Currently all in-memory stubs.
- **Odoo POS Postgres** — menu, modifiers, categories, combos, tables, restaurants
  (`pos_config`), and confirmed orders (`pos_order`). READ-only; referenced by
  **integer soft-ref**, never redefined. (Odoo's own DB — not ours.)

## Mechanics
- `redis/cart-cache.ts` — `CartCache` interface; default `InMemoryCartCache`.
  TODO `RedisCartCache` on `ioredis`. A recovery snapshot mirrors the cache value
  so the hot cart can be rebuilt after a loss.
- `redis/redis-client.ts` — **stub** connection holder.
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
- Real Redis wiring (`redis/*` are stubs; `CartRepository` keeps in-memory Maps);
  an Odoo client for reads + writing confirmed carts to `pos_order`.
