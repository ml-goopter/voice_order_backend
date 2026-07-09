---
type: Concept
title: Cart Module
description: Deterministic sole writer — apply lock, optimistic version/rebase, idempotency.
resource: src/cart
timestamp: 2026-07-07
---

# Cart Module

## Purpose
The only module that mutates cart state (design §9). Consumes
`order.operations_proposed`, validates + applies operations, assigns `line_id`s,
bumps the version, persists, and broadcasts `cart.updated`. Rejected ops surface as
`cart.operation_rejected`.

## Mechanics
- **Applier** (`cart-operation-applier.ts`) is validate-and-apply in one: resolves
  `menu_item_key`→`product_tmpl_id` and `modifier_key`→`ptav_id`, assigns a fresh
  `line_id` on `add_item` and captures display `name`s on the line and each modifier
  (snapshot at add time), edits target an existing `line_id`, and returns a new
  priced `Cart` or a `CartRejectedError` (`unavailable_item` / `line_gone` /
  `invalid_modifier` / `invalid_quantity`). `cart-validator.ts` is a dry-run of the
  applier so validation and application never drift.
- **Controller** (`cart-controller.ts`) is the writer — Tier-2 guard (design §9):
  - **Idempotency** — skip if `request_id` already processed.
  - **Apply lock** — per-`cart_id` critical section (`shared/async-lock`) makes the
    batch atomic (single writer per cart).
  - **Rebase per op** — every op is re-validated against the **current** cart, not
    the stale `base_version`; `add_item` always applies, stale edits reject
    individually, the rest apply.
  - Bumps `version`, then `commitApplied` writes the cart blob AND the idempotency
    mark in one Redis `MULTI` (so a crash can't leave the cart persisted but the
    request un-marked → double-apply on retry), snapshots, emits `cart.updated`;
    emits `cart.operation_rejected` per failed op.
  - **Infra failure** — the compute-and-persist section is wrapped in try/catch. An
    unexpected throw (Redis/menu down) aborts before any persist, leaves the
    `request_id` un-marked (so a retry reprocesses), and emits one
    `cart.operation_rejected` with reason `internal_error`. The `cart.updated` and
    per-op rejection emits run **outside** the try (after a successful persist) so a
    throwing event listener can't be misread as an infra failure and trigger a
    spurious `internal_error` for an already-committed cart. `register-handlers` also
    `.catch`es as a last-resort guard.
  - `confirm()` writes the cart to Odoo `pos_order` (stub).
- **Pricing** currently sums item base prices only (TODO modifier deltas + tax).
  The applier is async and reads prices from the Redis-backed `MenuLookup`; repricing
  batches every line through one `getItems` (MGET) rather than a lookup per line.

## Dependencies
- `persistence` (CartCache, CartRepository — both Redis-backed, with in-memory
  doubles for tests), `menu` (resolution + prices), `events` (EventBus).
  `register-handlers.ts` binds `order.operations_proposed`.

## Key files
- `cart-controller.ts`, `cart-operation-applier.ts`, `cart-validator.ts`,
  `cart-repository.ts`, `cart-types.ts`, `register-handlers.ts`.

## Not done yet
- `CartRepository` is Redis-backed: the idempotency ledger lives at `cart:req:{request_id}`
  with a TTL (`CART_IDEMPOTENCY_TTL_SECONDS`, default 24h) so it stays bounded.
  `confirmOrder` (Odoo pos_order) and modifier/tax pricing are still stubs.
