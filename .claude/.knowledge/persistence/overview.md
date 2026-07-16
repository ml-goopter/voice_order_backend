---
type: Concept
title: Persistence (Redis + Odoo)
description: Redis for hot/durable app state, Postgres/pgvector (in the Odoo DB) for the menu, Odoo POS as read-only source of truth.
resource: src/redis, src/db
timestamp: 2026-07-15
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
- `cart/cart-repository.ts` — Redis-backed. Every commit runs ONE Lua script
  (`COMMIT_CART_LUA`) writing the cart blob, the idempotency mark and both traceability
  indexes together. Lua, not `MULTI`: `MULTI/EXEC` does not roll back a per-command
  failure, so a partial commit could persist a cart without its ledger mark (double-apply
  on retry) or a cart missing from its own index. `commitApplied` (has a `request_id`) and
  `commitCreated` (the create path, no request to mark) share it; the create path passes
  the `'skip'` sentinel. `confirmOrder` hands the mapped cart to `OdooClient.insertCart`.
- **Redis keys** —
  | Key | Type | TTL | Holds |
  |---|---|---|---|
  | `cart:{cart_id}` | String (JSON) | **none** | The cart blob. |
  | `cart:req:{request_id}` | String | `CART_IDEMPOTENCY_TTL_SECONDS` (24h) | Idempotency ledger mark. |
  | `device:{device_id}` | Set of `cart_id` | `DEVICE_INDEX_TTL_SECONDS` (24h) | Carts created by a device. |
  | `table:{table_id}` | Set of `cart_id` | `DEVICE_INDEX_TTL_SECONDS` (24h) | Carts ordered at a table. |

  The indexes are **Sets, not pointers**: with the confirmation lock a cart's life is
  create → mutate → confirm → frozen, so a device/table accumulates one cart per order and
  a Set gives history where a String could only answer "current cart". TTL is refreshed on
  every cart write, so an active device refreshes its **whole** set and an idle one's
  history expires all at once. A cart with no identity (the `applyProposal` fallback, when
  no `client.connected` ever created it) is indexed nowhere rather than under
  `device:undefined`. Note `cart:{cart_id}` has no TTL, so the indexes expire while the
  carts they point at do not.
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
- The LangGraph checkpointer is still `MemorySaver`. `confirmOrder` now really inserts into
  Odoo over its JSON-RPC API (see the [odoo](../odoo/overview.md) bundle) — but there is
  still no Odoo client for *reads*; the menu read path is Postgres/pgvector, not the API.
- Nothing reads the `device:`/`table:` indexes yet — they are written for traceability, but
  no route or tool queries them.
- `InMemoryCartRepository.confirmOrder` stays a stub by design, so tests never reach Odoo.
