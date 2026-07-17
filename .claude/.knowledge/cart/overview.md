---
type: Concept
title: Cart Module
description: Deterministic sole writer — apply lock, optimistic version/rebase, idempotency.
resource: src/cart
timestamp: 2026-07-16
---

# Cart Module

## Purpose
The only module that mutates cart state (design §9). Consumes `client.connected` (to
create the cart with its durable identity) and `order.operations_proposed`, validates +
applies operations, assigns `line_id`s, bumps the version, persists, and broadcasts
`cart.updated`. Rejected ops surface as `cart.operation_rejected`. Re-prices each apply
against the POS's authoritative quote, and confirms carts, via the
[odoo](../odoo/overview.md) client.

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
  - Bumps `version`, then — **best-effort authoritative pricing** — `repo.quoteCart` asks
    Odoo to price the post-apply cart (`OdooClient.quote` → `/goopter_cart_api/v1/quote`) and
    `applyQuoteToCart` overwrites the cart's `*_cents` with the returned **tax-included**
    totals (decimals → cents). A quote failure (Odoo down, an item pulled mid-flow) is
    swallowed with a `cart.quote_failed` warning and the **local estimate is kept**, so a
    pricing outage never loses a valid edit; the next successful edit re-quotes. Then
    `commitApplied` writes the cart blob, the idempotency mark AND the device/table indexes in
    one Redis Lua script (so a crash can't leave the cart persisted but the request un-marked →
    double-apply on retry), snapshots, emits `cart.updated`; emits `cart.operation_rejected`
    per failed op.
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
  - **`ordersByDevice(device_id)`** — read-through to `repo.getOrdersByDevice`: reads the
    Redis device index (`SMEMBERS device:{device_id}`), loads each cart blob (`MGET`), and
    returns only the **confirmed** ones (`confirmed_at` set). No cart write, so no apply lock;
    `[]` when the device is unknown or its index has expired (index TTL bounds it while cart
    blobs do not), and a member whose blob is gone/unparseable is dropped. Exposed as
    `GET /v1/devices/:device_id/orders` (see the `platform` bundle).
  - **Crash safety at confirm** — if Odoo accepts the insert but the Redis write fails, the
    cart is not marked confirmed and a retry re-sends. That is safe rather than a hole: the
    far side's line uuid `{cart_id}:{line_id}` makes the insert idempotent (SPEC
    § Idempotency), so a replay creates no duplicate lines. We inherit idempotency from
    the far side rather than implementing our own.
- **Pricing** is two-layer. The applier computes a **local estimate** —
  `(base_price_cents + Σ modifier price_extra_cents) × quantity` per line, surcharge per unit,
  **no tax** — read live from the `MenuLookup` on every reprice (never from the line's
  snapshot, which is `name`/`names` for display only; batched through one `getItems` MGET).
  Then the controller replaces that estimate with the **POS's server-authoritative quote**
  (`applyQuoteToCart`, see above): the persisted `*_cents` are Odoo's tax-included totals on a
  successful quote, and fall back to the local (untaxed) estimate only when the quote fails.
  So `cart.updated` now carries the real charge, not just our guess.

## Dependencies
- `persistence` (CartCache, CartRepository — both Redis-backed, with in-memory
  doubles for tests), `menu` (resolution + prices), `events` (EventBus), `odoo`
  (`OdooClient` + the `Cart` → `InsertCartRequest`/`QuoteRequest` mappings). `register-handlers.ts`
  binds `client.connected` and `order.operations_proposed`.

## Key files
- `cart-controller.ts`, `cart-operation-applier.ts`, `cart-validator.ts`,
  `cart-repository.ts`, `cart-types.ts`, `register-handlers.ts`.
- `cart-to-insert-request.ts` / `cart-to-quote-request.ts` — the `Cart`→`InsertCartRequest` /
  `Cart`→`QuoteRequest` mappers, kept here so odoo doesn't depend on cart; the wire types stay
  in `odoo/insert-cart-request.ts` / `odoo/quote-request.ts`.
- `apply-quote.ts` — `applyQuoteToCart`: folds a `QuoteResponse`'s `amount_*` decimals into the
  cart's integer `*_cents` (×100; guards `decimal_places === 2`).

## Not done yet
- **Local pricing is now a fallback, not the number of record.** Each successful apply
  re-prices via the Odoo quote and stores the tax-included total; the untaxed
  `(base + Σ modifier price_extra) × qty` estimate is used **only** when the quote call fails.
  Two consequences remain: (1) a customer editing while Odoo is unreachable sees the untaxed
  estimate until the next successful quote; (2) `applyQuoteToCart` assumes a 2-decimal currency
  (CAD in both deployments) and throws otherwise — a non-2dp currency needs the `*_cents`
  contract revisited end-to-end.
- **Takeout is not usable end-to-end** even though `table_id?` makes this side ready: the
  far side treats every cart as dine-in and takes no `preset_id`, so a takeout cart is
  taxed dine-in (SPEC § Open questions — resolved #2). The blocker is `preset_id`, not
  the identity model. `toQuoteRequest` likewise never sends `preset_id`, so the quote matches
  the dine-in charge insert produces.
