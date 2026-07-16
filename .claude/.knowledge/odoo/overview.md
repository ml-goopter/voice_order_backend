---
type: Concept
title: Odoo Cart API Client
description: Inserts confirmed carts into the POS over goopter_cart_api's JSON-RPC route.
resource: src/odoo
timestamp: 2026-07-15
---

# Odoo Cart API Client

## Purpose
The one place this service **writes** to Odoo. When a cart is confirmed, the Cart Module's
`confirmOrder` maps it onto the `goopter_cart_api` addon's insert contract and POSTs it;
Odoo creates the `pos_order` and returns its id.

**`SPEC.md` (repo root) is the far side's contract.** That addon is already implemented and
lives in a different repo — do not reimplement, second-guess, or port it here. It exposes
two routes; we call only the first:

| Route | Us |
|---|---|
| `POST /goopter_cart_api/v1/cart` | **Called** — append-only insert. |
| `POST /goopter_cart_api/v1/quote` | **Not built.** Price without creating. |

## Mechanics
- `cart-to-insert-request.ts` — pure, unit-tested mapping (SPEC § "Mapping from the
  external service's `Cart`"). What it **drops is contractual**, not accidental:
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
  which is the Postgres/pgvector menu *read* path), `shared/errors` (`AppError`),
  `cart/cart-types` (the `Cart` being mapped). Consumed by `cart/cart-repository`.

## Key files
- `odoo-client.ts` — `OdooClient` interface, `HttpOdooClient`, `OdooError`.
- `cart-to-insert-request.ts` — `toInsertCartRequest`, `InsertCartRequest`, `RequestLine`.

## Operational notes (SPEC — expect these, they are not our bugs)
- The integration user must be an **internal user AND a POS user**: `group_pos_user` alone
  cannot read `product.template.attribute.value`, so it cannot resolve a product at all.
- Odoo 19 **requires every API key to carry an expiration date** — the key needs rotating
  before it lapses.
- A POS session in `opening_control` is **not** usable; carts are refused until the cashier
  confirms the opening cash count. Expect `no open session` in dev.

## Not done yet
- No `/quote`. The route **exists and works** on the addon (verified: returns per-line
  prices + totals, creates nothing), but this repo has no client method for it — we never
  ask Odoo for a price before confirming. Whoever adds it: SPEC § "Quote/insert consistency"
  requires both routes to share **one** pricing function.
- We ignore the insert response's `inserted_line_ids`/`skipped_line_ids` and
  server-authoritative totals — a future "what did Odoo actually charge?" reconciliation
  would read them.
- Never call Odoo's `recompute_prices()` or reach into the addon — SPEC warns a wholesale
  recompute silently erases happy-hour discounts. That is the far side's concern, handled.
