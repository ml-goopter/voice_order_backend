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
  `line_id` on `add_item`, edits target an existing `line_id`, and returns a new
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
  - Bumps `version`, writes the cache, snapshots, marks processed, emits
    `cart.updated`; emits `cart.operation_rejected` per failed op.
  - `confirm()` writes the cart to Odoo `pos_order` (stub).
- **Pricing** currently sums item base prices only (TODO modifier deltas + tax).

## Dependencies
- `persistence` (CartCache, CartRepository), `menu` (resolution + prices),
  `events` (EventBus). `register-handlers.ts` binds `order.operations_proposed`.

## Key files
- `cart-controller.ts`, `cart-operation-applier.ts`, `cart-validator.ts`,
  `cart-repository.ts`, `cart-types.ts`, `register-handlers.ts`.

## Not done yet
- Persistence is in-memory (`CartRepository` idempotency/snapshots), to be backed
  by Redis; `confirmOrder` and modifier/tax pricing are stubs.
