---
type: Concept
title: Cart Module
description: Deterministic sole writer — apply lock, optimistic version/rebase, idempotency.
resource: src/cart
timestamp: 2026-07-15
---

# Cart Module

## Purpose
The only module that mutates cart state (design §9). Consumes `client.connected` (to
create the cart with its durable identity) and `order.operations_proposed`, validates +
applies operations, assigns `line_id`s, bumps the version, persists, and broadcasts
`cart.updated`. Rejected ops surface as `cart.operation_rejected`. Confirms carts into
Odoo via the [odoo](../odoo/overview.md) client.

## Mechanics
- **Applier** (`cart-operation-applier.ts`) is validate-and-apply in one: resolves
  `menu_item_key`→`product_tmpl_id` and `modifier_key`→`ptav_id`, assigns a fresh
  `line_id` on `add_item` and captures display `name`s on the line and each modifier
  (snapshot at add time). Both the line and each modifier also snapshot their full `names`
  map (all `res.lang` translations) so the client can display in any locale; `name` stays
  the en_US-fallback default. Modifiers use a `toCartModifier` helper to carry `names`
  through both the `add_item` and `add_modifier` paths.
  Edits target an existing `line_id`, and the applier returns a new
  priced `Cart` or a `CartRejectedError` (`unavailable_item` / `line_gone` /
  `invalid_modifier` / `invalid_quantity`). `cart-validator.ts` is a dry-run of the
  applier so validation and application never drift.
- **Controller** (`cart-controller.ts`) is the writer — Tier-2 guard (design §9):
  - **Identity** — `ensureCart` (bound to `client.connected`) creates the cart with its
    `device_id` (the device that CREATED it) and, for dine-in, `table_id`, before any
    ordering happens. Identity is **set-once**: a reconnect or a second device on the same
    cart never rewrites it. Stamping at connect (not at confirm) is what keeps in-flight
    carts in the device/table indexes.
  - **Idempotency** — skip if `request_id` already processed.
  - **Apply lock** — per-`cart_id` critical section (`shared/async-lock`) makes the
    batch atomic (single writer per cart). `applyProposal`, `ensureCart` and `confirm`
    all take it, so they are mutually exclusive — there is no check-then-act race
    between "is it confirmed?" and "append to it".
  - **Confirmation lock** — once `confirmed_at` is set the cart is frozen: every op in a
    proposal is rejected with reason `cart_confirmed`, nothing persists, and `version`
    never bumps. Its position is load-bearing — **after** the idempotency check (so a
    replayed request stays a silent no-op rather than a spurious rejection) and **before**
    the op loop (so nothing applies). `confirmed_at` is never cleared.
  - **Rebase per op** — every op is re-validated against the **current** cart, not
    the stale `base_version`; `add_item` always applies, stale edits reject
    individually, the rest apply.
  - Bumps `version`, then `commitApplied` writes the cart blob, the idempotency mark AND
    the device/table indexes in one Redis Lua script (so a crash can't leave the cart
    persisted but the request un-marked → double-apply on retry), snapshots, emits
    `cart.updated`; emits `cart.operation_rejected` per failed op.
  - **Infra failure** — the compute-and-persist section is wrapped in try/catch. An
    unexpected throw (Redis/menu down) aborts before any persist, leaves the
    `request_id` un-marked (so a retry reprocesses), and emits one
    `cart.operation_rejected` with reason `internal_error`. The `cart.updated` and
    per-op rejection emits run **outside** the try (after a successful persist) so a
    throwing event listener can't be misread as an infra failure and trigger a
    spurious `internal_error` for an already-committed cart. `register-handlers` also
    `.catch`es as a last-resort guard.
  - **`confirm(cart_id)`** inserts the cart into Odoo (`repo.confirmOrder` →
    `OdooClient.insertCart`), then persists `confirmed_at` + `pos_order_id`. Idempotent:
    a second confirm returns the stored id without re-inserting. Throws `NotFoundError`
    for an unknown cart and `OdooError` when the insert fails — the API layer maps those
    to 404/502. Exposed as `POST /v1/carts/:cart_id/confirm` (see the `platform` bundle).
    It emits no `cart.updated`: the frontend that called confirm clears its own cart view
    on the 200.
  - **Crash safety at confirm** — if Odoo accepts the insert but the Redis write fails, the
    cart is not marked confirmed and a retry re-sends. That is safe rather than a hole: the
    far side's line uuid `{cart_id}:{line_id}` makes the insert idempotent (SPEC
    § Idempotency), so a replay creates no duplicate lines. We inherit idempotency from
    the far side rather than implementing our own.
- **Pricing** sums `(base_price_cents + Σ modifier price_extra_cents) × quantity` per
  line — the surcharge is per unit (TODO tax). Both the base price and the modifier
  surcharges are read live from the `MenuLookup` on every reprice, never from the
  line's snapshot: the line snapshots `name`/`names` for display only. The applier is
  async; repricing batches every line through one `getItems` (MGET) rather than a
  lookup per line, and builds the ptav→surcharge map from that same read.

## Dependencies
- `persistence` (CartCache, CartRepository — both Redis-backed, with in-memory
  doubles for tests), `menu` (resolution + prices), `events` (EventBus), `odoo`
  (`OdooClient` + the `Cart` → `InsertCartRequest` mapping). `register-handlers.ts` binds
  `client.connected` and `order.operations_proposed`.

## Key files
- `cart-controller.ts`, `cart-operation-applier.ts`, `cart-validator.ts`,
  `cart-repository.ts`, `cart-types.ts`, `register-handlers.ts`.

## Not done yet
- **Tax pricing is still a stub.** This module prices a cart itself
  (`(base + Σ modifier price_extra) × qty`, tax TODO), while Odoo reprices
  server-authoritatively and ignores our numbers by contract (SPEC § Never trust client
  prices). **So the total the customer hears can differ from the bill — tax alone
  guarantees it today.** Accepted deliberately; do not "fix" it by sending our `*_cents`
  to Odoo, which drops them.
- **Takeout is not usable end-to-end** even though `table_id?` makes this side ready: the
  far side treats every cart as dine-in and takes no `preset_id`, so a takeout cart is
  taxed dine-in (SPEC § Open questions — resolved #2). The blocker is `preset_id`, not
  the identity model.
- No `/quote` route — we never ask Odoo for a price before confirming.
