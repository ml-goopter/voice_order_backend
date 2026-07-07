---
type: Concept
title: Persistence (Redis + Postgres + Odoo)
description: Three stores — Redis hot carts, our Postgres tables, Odoo POS as source of truth.
resource: src/redis, src/db
timestamp: 2026-07-07
---

# Persistence

## Purpose
Durable and hot state for the system (design §9). Three stores:
- **Redis** — live active carts (`cart:{pos_config_id}:{cart_id}`); the sole hot copy.
- **Our Postgres** — voice settings, cart registry + recovery snapshots, sessions,
  transcripts, clarifications, server calls, idempotency ledger, order-confirmation
  bridge.
- **Odoo POS Postgres** — menu, modifiers, categories, combos, tables, restaurants
  (`pos_config`), and confirmed orders (`pos_order`). READ-only; referenced by
  **integer soft-ref**, never redefined.

## Mechanics
- `redis/cart-cache.ts` — `CartCache` interface; default `InMemoryCartCache`.
  TODO `RedisCartCache` on `ioredis`. `cart_snapshots.snapshot` mirrors the cache
  value so Redis can be rebuilt after a loss.
- `redis/redis-client.ts` — **stub** connection holder.
- `db/db.ts` — `Db` interface; **stub** returns empty. TODO `pg` Pool.
- `db/schema/*.sql` — the DDL (see its own README). Our identities are text keys
  (`cart_id`, `session_id`, `line_id`, `request_id`); Odoo identities are integers
  (`pos_config_id`, `product_tmpl_id`, `ptav_id`, `restaurant_table_id`,
  `pos_order_id`). Multi-language uses Odoo jsonb (`res.lang` codes). Money in cents.

## Dependencies
- `cart/cart-types` (`Cart` shape). Schema depends on the Odoo POS database.

## Key files
- `redis/cart-cache.ts`, `redis/redis-client.ts`, `db/db.ts`.
- `db/schema/01_external_odoo.sql` … `07_server_calls.sql` + `db/schema/README.md`.

## Not done yet
- Real Redis/Postgres wiring; migration runner (`scripts/migrate.ts` is a stub);
  writing confirmed carts to Odoo `pos_order`. Schema is unverified against a live DB.
