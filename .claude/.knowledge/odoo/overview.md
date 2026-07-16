---
type: Concept
title: Odoo Cart API Client
description: Inserts confirmed carts into the POS over goopter_cart_api's JSON-RPC route.
resource: src/odoo
timestamp: 2026-07-16
---

# Odoo Cart API Client

## Purpose
The one place this service **writes** to Odoo. When a cart is confirmed, the Cart Module's
`confirmOrder` maps it onto the `goopter_cart_api` addon's insert contract and POSTs it;
Odoo creates the `pos_order` and returns its id.

**`SPEC.md` is the far side's contract.** That addon is already implemented and lives in a
different repo — do not reimplement, second-guess, or port it here. It exposes two routes; we
now call **both**:

| Route | Us |
|---|---|
| `POST /goopter_cart_api/v1/cart` | **Called** — append-only insert (`insertCart`), on confirm. |
| `POST /goopter_cart_api/v1/quote` | **Called** — price without creating (`quote`), on each cart apply. |

## Mechanics
- The pure `Cart`→`InsertCartRequest` mapping lives in **`cart/cart-to-insert-request.ts`** (moved
  there so odoo doesn't import `cart`; odoo owns only the wire *types*). What it **drops is
  contractual**, not accidental:
  | Dropped | Why |
  |---|---|
  | `name`, `names`, `modifiers[].name(s)` | Caller-supplied names would print arbitrary text on kitchen tickets; Odoo builds `full_product_name` server-side. |
  | `product_id` | Only ever sent "if known", so the far side resolves from template + PTAVs regardless — never a shortcut, only a second source of truth. |
  | `subtotal_cents`, `tax_cents`, `total_cents` | Pricing is server-authoritative (SPEC § Never trust client prices). |
  | `version`, `last_updated` | Genuinely unnecessary: strict append-only makes the insert commutative and idempotent, so there is nothing for a version to protect. |

  It **flattens** `modifiers[].ptav_id` → `ptav_ids` (the only part read), **omits**
  `table_id` when absent (→ untabled order), and sends `line_id` **raw** — the far side
  namespaces it into `{cart_id}:{line_id}` to build the globally-unique line uuid that
  carries idempotency. Pre-namespacing here would produce `cart_1:cart_1:ln_1`.
  `preset_id` is deliberately never sent.
- `odoo-client.ts` — `HttpOdooClient.insertCart` POSTs a `type="jsonrpc"` envelope
  (`{jsonrpc, method: "call", params}`) with `Authorization: Bearer {ODOO_API_KEY}`, an
  optional `X-Odoo-Database` header (`ODOO_API_DATABASE`) and a 10s timeout. Failures
  (transport, non-JSON body, Odoo error, missing/non-numeric `order_id`) throw `OdooError`,
  which the API layer maps to **502**.
- `HttpOdooClient.quote` POSTs the same envelope to `/goopter_cart_api/v1/quote` with a
  `QuoteRequest` (`{pos_config_id, items}` — no `cart_id`/`table_id`/`preset_id`; quote creates
  nothing and prices dine-in like insert). It shares the private `call<T>` transport, so the
  same 200-on-error handling applies, and validates the three order `amount_*` are finite
  numbers (a malformed price → `OdooError`, never an `undefined`/NaN total written to the
  cart). **Verified against the live addon:** the response is
  `{currency, decimal_places, lines[{line_id, product_id, full_product_name, quantity,
  price_unit, price_subtotal, price_subtotal_incl}], amount_subtotal, amount_tax,
  amount_total}` — decimals, not cents (SPEC § resolved #5). The cart module (not a REST route)
  drives this: `CartController.applyProposal` → `repo.quoteCart` → `quote`, then
  `applyQuoteToCart` folds `amount_*` into the cart's `*_cents`. Best-effort — a quote failure
  keeps the local estimate (see the cart bundle).
- **Response shape (verified against the live addon):** insert returns
  `{order_id, pos_reference, tracking_number, table_id, inserted_line_ids,
  skipped_line_ids, currency, decimal_places, amount_subtotal, amount_tax, amount_total}`.
  We read only `order_id` (the `pos_order.id`); the rest — the server-authoritative totals
  and the idempotency signal `inserted_line_ids`/`skipped_line_ids` — are ignored for now.
  On a replay `inserted_line_ids` is empty and `order_id` is unchanged, so a re-confirm is a
  clean no-op.
- **Database selection:** an Odoo host serving several databases with no `dbfilter` cannot
  pick one and answers `"No database is selected"` as an HTML 404 — regardless of the bearer
  key. `X-Odoo-Database` names it. Neither SPEC nor the original plan mentioned this; it was
  found by testing against the live instance (5 databases, no filter). Omitted when
  `ODOO_API_DATABASE` is empty, for a single-db instance or one whose `dbfilter` resolves
  itself.

## The one thing that must not be got wrong
**JSON-RPC returns HTTP 200 on failure**, with the error in the body (SPEC § "Found during
implementation"). So the client branches on **`body.error`, never on `res.ok`/`res.status`**
— a 200 carrying an `error` member is a failure. Branching on the status would mark a cart
confirmed that Odoo never accepted. `odoo-client.test.ts` pins this; it is the regression
test for the whole integration.

## Dependencies
- `config/env` (`ODOO_API_URL`, `ODOO_API_KEY` — **unrelated** to `ODOO_DATABASE_URL`,
  which is the Postgres/pgvector menu *read* path), `shared/errors` (`AppError`). Imports
  **nothing** from `cart` (the `Cart`→request mappers live on the cart side). Consumed by
  `cart/cart-repository`, which calls `insertCart`/`quote` with the mapped requests.

## Key files
- `odoo-client.ts` — `OdooClient` interface (`insertCart`, `quote`), `HttpOdooClient`, `OdooError`.
- `insert-cart-request.ts` — the wire types `InsertCartRequest`, `RequestLine` (mapper
  `toInsertCartRequest` lives in `cart/cart-to-insert-request.ts`).
- `quote-request.ts` — the wire types `QuoteRequest` (reuses `RequestLine`), `QuoteResponse`,
  `QuoteLine` (mapper `toQuoteRequest` lives in `cart/cart-to-quote-request.ts`).

## Operational notes (SPEC — expect these, they are not our bugs)
- The integration user must be an **internal user AND a POS user**: `group_pos_user` alone
  cannot read `product.template.attribute.value`, so it cannot resolve a product at all.
- Odoo 19 **requires every API key to carry an expiration date** — the key needs rotating
  before it lapses.
- A POS session in `opening_control` is **not** usable; carts are refused until the cashier
  confirms the opening cash count. Expect `no open session` in dev.

## Not done yet
- We ignore the insert response's `inserted_line_ids`/`skipped_line_ids` and
  server-authoritative totals — a future "what did Odoo actually charge?" reconciliation
  would read them.
- Never call Odoo's `recompute_prices()` or reach into the addon — SPEC warns a wholesale
  recompute silently erases happy-hour discounts. That is the far side's concern, handled.
