# goopter_cart_api — Spec

Status: **implemented.** Odoo 19. See README.md for the operator's guide.

All open questions are resolved (§ Open questions — resolved). Three were
answered from the deployment data rather than by decision; the rest were product
calls. Where the implementation knowingly deviates from this spec, § Deviations
says so and why.

## Problem

An external service needs to push a cart into the POS, and needs to show the
customer a price before it does. Today there is no external-facing API in this
repo at all.

Two routes:

1. **Insert cart** — create a POS order from a list of items, optionally onto a
   table. If the table already has an order, append the items to it.
2. **Quote** — return the calculated price for a list of items without creating
   anything. Used by the external service to display a price to the customer.

## Scope

**In:**
- Two JSON-RPC routes (insert, quote).
- Append-only insertion onto an existing table order.
- Server-authoritative pricing (client-sent prices are never trusted).
- Making the cart visible in an already-open POS session.
- Rejecting inserts onto a bill a cashier has already taken into the payment
  flow.

**Out (unless raised):**
- Modifying or removing existing lines. The API is strictly additive.
- **Combos.** _Decided._ The schema has no combo fields. This spares us porting
  core's `_compute_combo_price`, which core's own docstring calls *"not correct
  from an accounting perspective"* (`pos_self_order/models/pos_order.py:275-281`).
- Payments, tips, refunds, invoicing.
- Creating/closing POS sessions.
- Loyalty/reward line creation.
- Any POS frontend (JS) changes. This is server-side only.

## API contract

_Decided: the API declares its own request schema. It does not adopt the external
service's `Cart` object as the wire format._

```ts
interface RequestLine {
  line_id: string;          // stable within the cart, e.g. "ln_1"
  product_tmpl_id: number;
  quantity: number;         // > 0
  ptav_ids?: number[];      // product.template.attribute.value ids
}

// POST /goopter_cart_api/v1/quote
interface QuoteRequest {
  pos_config_id: number;
  preset_id?: number | null;   // order type — drives pricelist AND fiscal position
  items: RequestLine[];        // non-empty
}

// POST /goopter_cart_api/v1/cart
interface InsertCartRequest extends QuoteRequest {
  cart_id: string;             // required — the line-uuid namespace
  table_id?: number | null;    // restaurant.table id
}
```

**Insert is quote plus two fields, and that relationship is load-bearing.** Quote
and insert must price identically, so they take identical pricing inputs. If a
field can move the price it belongs in both — enforced by the type relationship
rather than by a comment asking two functions to stay in sync.

Parsing is **tolerant**: unknown keys are ignored, not rejected. The caller may
POST its `Cart` nearly verbatim; the declared contract stays honest and their
schema can evolve without breaking us.

### Mapping from the external service's `Cart`

The external service owns this shape (reproduced for reference):

```ts
interface Cart {
  cart_id, pos_config_id, version, items,
  subtotal_cents, tax_cents, total_cents, last_updated
}
interface CartLine {
  line_id, product_tmpl_id, product_id?, name, names, quantity, modifiers
}
interface CartModifier { ptav_id, name, names? }
```

| `Cart` field | Handling |
|---|---|
| `cart_id` | **Used** — namespace for line uuids (§ Idempotency). Recoverable from any line we create, so it doubles as traceability with no new field. |
| `pos_config_id` | **Used** — resolves the `pos.config`. Session and table validation hang off it. |
| `items[].line_id` | **Used** — second half of the line uuid. |
| `items[].product_tmpl_id` | **Used** — resolved to a `product.product` variant (§ Product resolution). |
| `items[].quantity` | **Used** → `pos.order.line.qty` (Float). |
| `items[].modifiers[].ptav_id` | **Used** → `ptav_ids`. Split between variant resolution and `attribute_value_ids` (§ Product resolution). |
| `items[].product_id` | **Dropped.** _Decided._ It is only sent "if known", so resolution from template + PTAVs is required regardless — it is never a shortcut, only a second source of truth to reconcile. |
| `name`, `names`, `modifiers[].name`, `modifiers[].names` | **Dropped.** See below. |
| `subtotal_cents`, `tax_cents`, `total_cents` | **Dropped.** Server-side computation is the sole source of truth (§ Never trust client prices). |
| `version`, `last_updated` | **Dropped** — and genuinely unnecessary, not merely ignored. See below. |
| — | `table_id` and `preset_id` have **no `Cart` equivalent** and are supplied by the caller alongside it. |

`modifiers: CartModifier[]` flattens to `ptav_ids: number[]` because `ptav_id` is
the only part we read. (A future need for write-in notes — "severe nut allergy" —
would be Odoo's `custom_attribute_value_ids`, a genuinely different field, and
can be added then.)

### Why `version` / `last_updated` are unnecessary

Strict append-only makes the insert route **commutative and idempotent**. A line
is created only if its uuid is unseen, so:

- a replay of the same cart is a no-op;
- an older version arriving *after* a newer one is a no-op, because its lines are
  a subset already inserted;
- delivery order does not matter.

There is nothing for a version counter to protect against. This is a property to
preserve deliberately: any future change that makes the API order-dependent
resurrects the need for versioning.

### Why `name` / `names` are ignored

Odoo derives product names from `product_id`. Accepting caller-supplied names
would let an external service print arbitrary text on kitchen tickets and
customer receipts. This repo already owns receipt naming deliberately —
`pos_receipt_language` forces a configured receipt language, and
`pos_product_alternative_name` substitutes names on kitchen receipts. A
caller-supplied string would cut across both.

**But we cannot simply drop the name.** `pos.order.line.full_product_name`
(`point_of_sale/models/pos_order.py:1569`) is what receipts and kitchen tickets
actually print (`:943`, `:1901`), and it is a plain stored `Char` — nothing
computes it for us on the server path. **We must build it server-side** from the
product's display name plus its selected attribute values, the way the POS
frontend does. Leaving it blank yields blank receipt lines.

### Why `*_cents` needs care even though we ignore the values

The `_cents` naming assumes two decimal places. If any response echoes money back
to the caller, convert via the currency's `decimal_places` rather than a
hardcoded `/100` — `res.currency` supports zero-decimal currencies.

## Authentication

`@http.route(..., type="jsonrpc", auth="bearer")`.

Odoo 19 has built-in bearer auth (`odoo/http.py:746-755`): the caller sends
`Authorization: Bearer <api-key>` where the key is an Odoo API key belonging to
a dedicated integration user. The request executes with that user's permissions,
and is stateless — `auth='bearer'` defaults `save_session=False`
(`odoo/http.py:801-802`), so no session cookie is minted per call.

- The integration user must be in `point_of_sale.group_pos_user` (or manager) so
  ordinary record rules apply. **Do not `sudo()`** except where core does.
- This is the repo's first non-`auth="user"` route.
- Use `type="jsonrpc"`, not `type="json"` — the latter is a deprecated alias in
  19 (`odoo/http.py:786-792`).

**Not** copying core self-order's `pos.config.access_token` bearer scheme
(`pos_self_order/controllers/orders.py:176-186`): that exists to authorize an
untrusted per-table QR client. Our caller is a trusted server, so an API key
tied to a real user is a better fit and gives us audit + record rules for free.

## Target resolution

### POS config
`Cart.pos_config_id` — the `pos.config` database id.

Reject unless `config.current_session_id` is in state `opened`. `pos.order`
requires a `session_id` (`point_of_sale/models/pos_order.py:70` subscripts it
directly), so there is no meaningful "queue it for later" behavior without
inventing storage. Out of scope → **409 / error when no session is open.**

### Table (optional)
A **`restaurant.table` id**, passed as a request parameter alongside the cart —
not a `Cart` field. _Decided: the API keys on table id, not table number._

Rationale — `table_number` was rejected as the key because it is
`fields.Integer(required=True, default=0)` with **no unique constraint of any
kind**, not globally and not per floor (`pos_restaurant/models/pos_restaurant.py:97`;
no `_sql_constraints` and no `@api.constrains` anywhere in the module). Core's
`display_name` is `f"{floor_id.name}, {table_number}"`
(`pos_restaurant/models/pos_restaurant.py:110-113`), which implies per-floor
uniqueness is *intended* but never enforced. Keying on it would make "items on a
stranger's bill" a data-entry mistake away.

`pos_self_order`'s `identifier` token was also rejected: it is a rotating
security token, not an identifier. `pos_config._update_access_token` cascades to
`floor_ids.table_ids._update_identifier()`
(`pos_self_order/models/pos_config.py:117-119`), and `_update_identifier` does
`search([])` — rotating **every table in the database**
(`pos_self_order/models/pos_restaurant.py:24-28`). Any cached external reference
would silently break. It also requires `pos_self_order` to be installed (nothing
in this repo depends on it) and carries no unique constraint.

Table ids are stable, unique by construction, and survive renumbering. The cost
is that the external service must learn them — that is accepted, and is a
provisioning concern outside this API.

**Resolution and validation:**

1. Browse the `restaurant.table` id; `exists()` → else error (unknown table).
2. Reject if `active = False`.
3. **Reject unless `table.floor_id` is in `config.floor_ids`.** Without this,
   any valid API key could attach a cart to any table in the database,
   cross-config and cross-company.

Step 3 matters: core's own self-order controller **omits this check** —
`orders.py:197` looks the table up by identifier alone and never verifies it
belongs to the authorized config. We should not copy that.

`restaurant.table` has no `name` field, so error messages should use
`display_name` (`"<floor>, <number>"`) for a human-readable reference.

_Open question: does the external service already know Odoo table ids, or does it
need a lookup route (config → tables with id + display_name) to discover them?
If provisioning is manual, no route is needed._

## Insert behavior

### Which order gets appended to
Splitting in this codebase is **one `pos.order` with `pos.sub.order` children**
(`goopter_pos_split_bill/models/pos_order.py:47-51`;
`models/pos_sub_order.py:19-25`), *not* multiple orders sharing a `table_id`. So
a table has at most one live order and "which order?" is not usually ambiguous.

Include `table_id` **and** `state='draft'` in the payload handed to
`sync_from_ui`. That activates the table-merge branch of
`pos_restaurant._get_open_order` (`pos_restaurant/models/pos_order.py:12-22`),
which matches on `('table_id','=',…), ('state','=','draft'), ('config_id','=',…)`.
No match → a new order is created. This is core's own append path.

(Note: core self-order deliberately does *not* do this — it omits `table_id` and
creates a parallel order, overlaid in the UI. We want true append, so we opt in.)

### The lock rule — `state == 'draft'` is NOT a safe green light

This is the most important rule in the spec.

A partially-paid split order stays `state='draft'` indefinitely — one guest pays,
three to go, and the order is still draft (`goopter_pos_split_bill`'s validation
path only calls `finalizeValidation()` once the whole order is settled). The POS
UI blocks all item edits on such an order via `isGuestEditLocked`
(`static/src/app/models/pos_order.js:188-190`), **but that guard lives only in
the frontend** — there is no server-side enforcement. An API that trusts
`state == 'draft'` will happily append items to a bill someone is mid-way
through paying.

**Reject the insert when, on the resolved target order, either:**
- any `sub_order_ids` with `state != 'void'` exist, **or**
- any `payment_ids` exist at all.

**Why both, and what a sub-order actually means.** The moment a cashier taps
Payment and picks *any* mode, the POS mints a `pos.sub.order` — including the
plain, un-split "pay the whole bill" path (`payFull()`,
`static/src/app/screens/split_method_screen/split_method_screen.js:35-42`). So
this condition is not about *splitting*; it means **a cashier is standing at the
payment screen with this bill open**, before any money has moved.

It is also reversible: backing out calls `voidPendingPaymentFlow`, which deletes
the payments and cascade-deletes the sub-order tree
(`static/src/app/services/split_payment_lifecycle.js:317-333`), unlocking the
order. So a sub-order is *not* evidence that money moved — which is exactly why
`payment_ids` is checked separately rather than inferred from sub-orders. The two
conditions catch different things: sub-orders catch "someone is paying right
now," `payment_ids` catches "money has actually been taken."

This is deliberately stricter than the UI. Appending is always safe to refuse
and never safe to get wrong.

Also filter `is_refund = False` when resolving the table's order: refund orders
are created via `copy()` and `pos.order.table_id` has **no `copy=False`**
(`pos_restaurant/models/pos_order.py:8`), so a draft refund can transiently
carry the parent's table.

### Append-only is safe at the ORM level
`_process_order` (`point_of_sale/models/pos_order.py:110-128`) writes the `lines`
o2m with plain Commands. Lines **absent from the payload are left untouched** —
there is no `Command.SET`, no clear, no diff-against-payload. Deletion happens
only if we send `Command.DELETE`/`UNLINK`, which we never do. So sending only the
new lines satisfies "do not update or remove existing items" by construction.

### Product resolution — template + PTAVs → variant + attributes

`pos.order.line.product_id` is a **required** m2o to `product.product` — a
*variant* (`point_of_sale/models/pos_order.py:1540`). The schema gives us
`product_tmpl_id` (a *template*) plus a list of `ptav_id`s. So resolution is
mandatory on every line, and it is not a straight lookup.

The PTAVs must be **partitioned by their attribute's `create_variant` mode**
(`product/models/product_attribute.py:24`):

- `create_variant != 'no_variant'` (`always` / `dynamic`) — these **identify the
  variant**. Match them against the template's `product_variant_ids` to find the
  right `product.product`.
- `create_variant == 'no_variant'` — these are **modifiers**. They do not affect
  variant identity; they go on the line's `attribute_value_ids`
  (`point_of_sale/models/pos_order.py:1541`) and contribute `price_extra`.

Restaurant modifiers ("No mayo") are normally `no_variant`, so in practice most
carts will resolve to the template's single variant. But the API must not
*assume* that — a menu item with a variant-creating attribute (say, Size) would
otherwise silently land on the wrong variant, which is a wrong price and a wrong
kitchen ticket.

Rules:
1. Partition `ptav_ids` by `create_variant`.
2. Resolve the variant from the variant-creating subset. Zero or multiple
   matches → reject; do not guess.
3. Every `ptav_id` must belong to `product_tmpl_id`. Reject foreign PTAVs — this
   is the injection vector on this endpoint.
4. `dynamic` attributes may require creating a variant that doesn't exist yet.
   _Open question: does the menu use dynamic attributes? If not, reject and
   simplify._

### Payload hygiene
Build the dict handed to `sync_from_ui` from an **explicit allowlist**, mirroring
`pos_self_order/models/pos_order.py:166-239`. Force server-side, ignoring
anything the caller sent:
- `session_id` = `config.current_session_id.id`
- `company_id`, `pricelist_id`, `fiscal_position_id` from preset-else-config
- `pos_reference` / `tracking_number` from `config._get_next_order_refs()`
- `date_order` = now
- Filter m2m id lists (`attribute_value_ids`, `combo_line_ids`) to ints, to strip
  smuggled ORM commands.

**Always include `uuid` and `access_token` keys — even as `None`.** The
existing-order branch does an unconditional `del order['uuid']` /
`del order['access_token']` (`point_of_sale/models/pos_order.py:130-131`), so
omitting either raises `KeyError`. This is already documented in
`goopter_pos_split_bill/tests/test_process_order.py:51-56`.

Tag the order's `source` field with a new `selection_add` value so external
orders are distinguishable (core's extension hook —
`pos_self_order/models/pos_order.py:41-44` adds `mobile`/`kiosk`). _TBD: value name._

### No free line merging
Merging identical products into one line is **purely client-side**
(`canBeMergedWith`, `point_of_sale/static/src/app/models/pos_order_line.js:325-355`).
Server-side we get only uuid dedupe. So appending the same product twice yields
two lines.

_Decided: don't merge._ A merge is an update, which contradicts strict
append-only. Each cart line becomes its own POS line, keyed by its own uuid.
Ordering the same dish in two separate carts yields two lines on the bill — which
is also the more honest representation of what happened.

### Making it visible in an open POS session

One call after the order is saved:

```
config.notify_synchronisation(config.current_session_id.id, 0)
```

(`point_of_sale/models/pos_config.py:222-243`.) This is what core's
`sync_from_ui` already does at `point_of_sale/models/pos_order.py:1275-1277`, so
we may get it for free — **verify** whether it fires on our path before adding a
second call.

Mechanics, for whoever maintains this: `_notify` sends over `bus.bus` on the
channel `pos.config.access_token`, message `f"{token}-SYNCHRONISATION"`
(`point_of_sale/models/pos_bus_mixin.py:26-40`). The message carries **no order
data** — it's a ping. The POS frontend then pulls via
`pos.config.read_config_open_orders` (`models/pos_config.py:245-274`), whose
domain includes "any draft order on this config I don't already have"
(`static/src/app/utils/devices_synchronisation.js:227-235`). That clause is what
makes a foreign order appear.

The frontend drops the ping unless `session_id` equals the cashier's live session
**and** `device_identifier` differs from that browser's device id
(`devices_synchronisation.js:66-67`). Pass `0`, the sentinel core uses.

Do not invent a channel or push order data over the bus.

## Quote behavior

Purpose: the external service displays this price to the customer. It must
therefore agree with what the POS will actually charge.

- Creates nothing and must not write. Prefer a `readonly=True` route.
- Same pricing inputs as the insert path: config's pricelist, fiscal position,
  company, currency, partner (if supplied).
- Return per-line prices plus order totals (subtotal, tax, total). _TBD (schema):
  exact response shape._

There is **no ready-made "product + qty → taxed totals" method** in core.
(`product.template.get_product_info_pos` looks close but takes the price as an
*input* and ignores fiscal position — it's a product-info-popup helper, not a
pricing API.) Compose it the way core does in
`pos_self_order/models/pos_order.py:263-273`:

```
product = product.with_context(product._get_product_price_context(attribute_value_ids))
price   = pricelist._get_product_price(product, qty, currency=currency)
taxes   = fiscal_position.map_tax(product.taxes_id._filter_taxes_by_company(company)) \
              .compute_all(price, currency, qty, product=product, partner=partner)
```

### Quote/insert consistency
The two routes must not disagree. Core's `_compute_line_price` passes **`qty=1.0`**
to `_get_product_price` while passing the real `qty` to `compute_all`
(`pos_self_order/models/pos_order.py:267,270`) — so quantity-break pricelist
rules are silently ignored there. If our quote passes the real qty and the insert
follows core, a customer quoted a qty-break price gets charged a different one.

**Both routes must share one pricing function.** Not two implementations that
"should" match. This is the main correctness risk in the quote feature.

_Open question: do any of your pricelists actually use quantity breaks? If yes,
we must decide which convention is correct and deviate from core knowingly._

Attribute `price_extra` enters via `_get_product_price_context(ptavs)`, which
folds it into the pricelist result — so the `no_variant` modifier PTAVs from
§ Product resolution must be passed into that context, or every modifier's
surcharge is silently dropped from both the quote and the charge.

### Happy hour does not exist server-side — needs a product decision

_Investigated and confirmed._ `pos_happy_hour_discount` is **JS-only**. Rules
live in `pos.happy.hour.rule` and are shipped to the browser; the window check
uses the **browser's local clock** (`happy_hour_utils.js:17-19`, `:67` — via
`getHours()` / `getDay()`), and the discount is applied in a `getPrice` patch
(`happy_hour_pricing_patch.js:7-40`). There is **no Python application path**.

Therefore, as specced, **both routes price at full list during happy hour**. A
customer ordering through the external service pays more than a walk-in ordering
the same item at the same moment.

This is not necessarily wrong — happy hour is often deliberately dine-in only.
But it must be a **decision**, not an accident:

- **Happy hour should NOT apply to this channel** → current design is correct;
  document the exclusion so nobody "fixes" it later.
- **Happy hour SHOULD apply** → we must reimplement matching and the time window
  in Python against `pos.happy.hour.rule`. That is not a mechanical port. The
  addon **defines no timezone** — today's semantics are literally "whatever clock
  the cashier's tablet has." Server-side we have UTC, so we would have to *choose*
  a timezone the addon never specified, and the two implementations would disagree
  at window boundaries whenever the device tz differs. It also means duplicating
  the `pos.category` ancestor walk (`happy_hour_utils.js:96-108`), which Python
  does not replicate.

Note the tz problem is pre-existing and not ours to solve; we only need to avoid
making it worse. See also § Never trust client prices, where the same JS-only
design creates a destructive-recompute hazard.

### Other interactions
- **Combos** — out of scope (see § Scope). The pricing function should still be
  structured so a combo pass could be added later without restructuring.
- **`goopter_pos_bypass_global_discount`** — also JS-only for enforcement, but
  it does not interact with happy hour and only affects whole-order discounts,
  which this API never applies. No impact.
- **Loyalty** (`pos_loyalty` is a dep of split bill) — assumed out of scope.

## Never trust client prices

_Decided: the caller's `subtotal_cents` / `tax_cents` / `total_cents` are ignored
outright — not compared, not stored, not echoed. Server-side computation is the
sole source of truth._

This is not merely policy; core makes it a requirement.
`price_subtotal`, `price_subtotal_incl`, `amount_tax`, `amount_total` are stored,
required, **client-supplied** fields with no `@api.depends` recompute
(`point_of_sale/models/pos_order.py:334-335,1548-1551`). `_compute_amount_line_all`
and `_compute_prices` are `@api.onchange` helpers only — they do not fire on
create/write.

Core's post-sync recompute (`pos_self_order/controllers/orders.py:20-28`) is
`sync_from_ui` → `recompute_prices()` → overwrite `amount_tax`/`amount_total`.

### ⚠ Recompute MUST be scoped to our own new lines

**Do not call `recompute_prices()` on the whole order.** It is safe for core
self-order, which always owns a brand-new order. It is **destructive** for us,
because we append to orders a cashier rang up.

`pos_happy_hour_discount` applies its discount **only in the browser**, by
multiplying the unit price inside a `getPrice` patch
(`pos_happy_hour_discount/static/src/js/happy_hour_pricing_patch.js:7-40`):

```js
return basePrice * (1 - discountPercent / 100);   // discount BAKED INTO price_unit
```

It never sets `pos.order.line.discount`, never adds a discount line, and never
touches a pricelist. The addon's Python side stores and validates rules and ships
them to the browser — there is no server-side application path at all.

The consequence is severe: a happy-hour line is stored as a bare `price_unit`
with `discount = 0`, **indistinguishable from a stale price**. Calling
`recompute_prices()` re-derives `price_unit` from the pricelist and **silently
erases the discount**, turning a legitimately discounted bill into a full-price
one. That is both a data-destroying bug and a direct violation of "do not update
existing items."

**Rule:**
1. Compute prices for **only the lines we created** (identified by our uuid
   prefix — see § Idempotency).
2. Recompute order totals across all lines afterwards. This is safe: order-level
   computation reads the lines' stored base values rather than re-deriving them
   from the pricelist, so other lines' prices pass through untouched.

Never let a line we did not create enter a pricing recompute.

## Concurrency

`_get_open_order` is a bare `search(..., limit=1)` with **no locking**
(`pos_restaurant/models/pos_order.py:12-22`). Two concurrent inserts on one table
can resolve the same target order, or both miss and create two orders.

Additionally the lock check (§ "The lock rule") and the append are not atomic: a
cashier can start a payment between our check and our write.

_Open question — needs a decision:_ take a `FOR UPDATE` row lock on the resolved
order for the duration of the request, or serialize per table. Recommendation:
row lock; it's cheap and the contention window is a single table.

## Idempotency and strict append-only

The caller sends the **whole cart** on every call, with a `version` that
increments as the customer edits. Retries and re-sends are expected.

### The line uuid is the idempotency key

```
pos.order.line.uuid = f"{cart_id}:{line_id}"
```

`pos.order.line.uuid` is a `Char` with a **unique constraint**
(`point_of_sale/models/pos_order.py:1574`, `:1585`). Deriving it from
`cart_id` + `line_id` makes it deterministic, so a replay maps to the same
records, and it needs no new field or model — `cart_id` is recoverable from any
line we created, which gives traceability for free.

**The namespacing is not cosmetic.** `line_id` is documented as stable *within a
cart* (`"ln_1"`), but the uuid constraint is **global**. Using `line_id` raw
means the second cart ever created sends `"ln_1"` and hits a unique-constraint
violation on an unrelated order. The `cart_id:` prefix is what makes the key
globally unique.

### Strict append-only — we must override core's default

_Decided: a re-sent cart never modifies a line we already inserted._ Only
`line_id`s we have not seen before are created. Quantity edits, and removals, do
not propagate once a line has landed in the POS.

**Core does not do this for us — it does the opposite.** `_process_order`
silently rewrites a `Command.CREATE` whose uuid already exists into an in-place
`Command.UPDATE` (`point_of_sale/models/pos_order.py:118-123`). Handing it the
full cart would quietly update quantities on lines already sent to the kitchen.

So the insert path must, **before** building the payload:

1. Compute `f"{cart_id}:{line_id}"` for every cart line.
2. Query `pos.order.line` for those uuids (globally, not just on the target
   order — the constraint is global).
3. **Drop every line whose uuid already exists.**
4. Emit `Command.CREATE` for the remainder only.

If nothing remains, the call is a successful no-op.

Consequence to be aware of: `version` and `last_updated` become inert. This is
intentional — it is what "do not update or remove existing items" means when the
caller re-sends a mutable cart. A customer who edits a quantity after their items
reach the kitchen must be handled by staff, not by this API.

_Open question: should a re-sent cart whose line content changed be silently
accepted (current spec) or logged as a warning? Silent acceptance hides a real
divergence between the customer's app and the bill._

## Settled

- Auth: `auth="bearer"` + Odoo API key (§ Authentication).
- Table keyed on `restaurant.table` id, passed as a separate request param.
- Combos out of scope.
- Idempotency via `f"{cart_id}:{line_id}"` line uuids.
- Strict append-only; `version` / `last_updated` inert (and unnecessary).
- API declares its own request schema rather than adopting `Cart`.
- `product_id` dropped from the line schema.
- Caller-supplied prices and names ignored.
- Recompute scoped to our own lines only (§ Never trust client prices).

## Open questions — resolved

1. **Should happy hour apply to this channel?** **No.** Product decision: happy
   hour stays dine-in only, and both routes price at full list. Documented as an
   exclusion in README.md and in the `pos.cart.api` module docstring so it reads
   as a decision rather than an oversight.
2. **Do presets differ on `fiscal_position_id` / `pricelist_id`?** **Yes, they
   do** — answered from the data: at `pos_izumisushi` the Takeout preset carries
   fiscal position 3 ("Manitoba (MB)", which has live tax mappings) while Dine In
   and Delivery carry none and the config default is NULL. At `jadegarden1` all
   three presets are empty. **Superseded by a product decision: every cart is
   treated as dine in**, so the request carries no `preset_id` and the config's
   default preset is used. The consequence is accepted and documented: a takeout
   cart pushed through this API at izumisushi is taxed dine-in.
   Note the implementation must still resolve the preset explicitly, because
   core's `_complete_values_from_session` fills `fiscal_position_id` from the
   *config*, never from the preset (`point_of_sale/models/pos_order.py:571-576`).
3. **Do any pricelists use quantity breaks?** **No** — answered from the data:
   `product_pricelist_item` is empty in both deployments, so there is not a
   single pricelist rule, let alone a quantity break. We nonetheless pass the
   real qty rather than core's `1.0` (§ Deviations).
4. **Does the menu use `dynamic` attributes?** **No** — answered from the data:
   every `product_attribute` row in both deployments is `no_variant`. Dynamic
   attributes are rejected; variant-creating (`always`) ones are still resolved
   properly, since an admin could add a Size attribute tomorrow.
5. **Response shape.** Decimals plus a currency code and `decimal_places`, never
   cents (§ Why `*_cents` needs care).
6. **Is a table mandatory?** **No** — optional, per § Scope. No table yields a
   new untabled order.
7. **Concurrency.** A transaction-scoped **advisory lock** per (config, table),
   not the row lock originally recommended (§ Deviations).
8. **Log a warning on a changed re-send?** **Yes** — a re-sent cart whose
   quantities disagree with what already landed logs a warning. Silence would
   hide a real divergence between the customer's app and the bill.
9. **Does the caller know table ids?** Provisioning concern, out of scope for
   the API. No lookup route in v1.
10. **`source` value.** `external_cart`.

## Deviations from this spec

Three places where the implementation knowingly departs from the text above.

### `table_id` is not handed to `sync_from_ui`

§ Insert behavior says to put `table_id` and `state='draft'` in the payload so
that `_get_open_order`'s table-merge branch does the resolution. That branch
cannot be reconciled with this spec's own `is_refund` requirement two paragraphs
later: its domain ORs `('uuid','=',…)` with the table clause, orders by
`id desc`, and does not filter `is_refund` — so a draft refund carrying the
parent's table, being newer, wins. You cannot both delegate resolution to core
and filter refunds.

So the implementation resolves the target itself (refund-filtered, floor-checked,
lock-checked), then passes **only that order's `uuid`** and omits `table_id`,
which keeps core on the deterministic uuid branch and makes it resolve exactly
the order we vetted. On the create path `table_id` is written immediately after.

Passing a real order uuid rather than `None` also avoids `('uuid','=',False)`
matching an order with a null uuid.

### Advisory lock, not a row lock

§ Concurrency recommends a `FOR UPDATE` row lock. A row lock cannot cover the
case it most needs to: when no order exists yet there is no row to lock, which is
exactly when two concurrent carts both miss and create two orders. A
`pg_advisory_xact_lock(config_id, table_id)` has no such gap, is released
automatically on commit or rollback, and confines contention to one table.

### The real qty is passed to `_get_product_price`

§ Quote/insert consistency notes that core passes `qty=1.0`, silently ignoring
quantity-break rules. We pass the real qty, matching what the POS frontend
charges (`getPrice(pricelist, quantity, …)`). Since no pricelist item exists in
either deployment this is a no-op today, and a correctness fix the day a
quantity break is added. Both routes share one pricing function, so they cannot
disagree with each other either way.

## Found during implementation

Facts worth keeping, each verified against the source or the database.

- **`notify_synchronisation` needs no second call.** `sync_from_ui` already
  fires it for every synced order (`point_of_sale/models/pos_order.py:1273-1277`)
  and defaults `device_identifier` to `0` — the same sentinel § Making it visible
  wanted to pass.
- **`group_pos_user` is not sufficient for the integration user.** It declares no
  `implied_ids`, and `product.template.attribute.value` is readable only by
  `base.group_user` (`product/security/ir.model.access.csv:12`), so a POS-only
  user cannot resolve a product at all. The user must be an internal user *and*
  a POS user. § Authentication understates this.
- **Odoo 19 requires every API key to carry an expiration date.** The integration
  key must be rotated before it lapses.
- **A session is not usable the moment it exists.** `open_ui()` leaves it in
  `opening_control` and `action_pos_session_open()` does *not* move it; only
  `set_opening_control` reaches `opened` (`pos_session.py:1694`). Since we accept
  only `opened`, carts are refused until the cashier confirms the opening cash
  count.
- **JSON-RPC returns HTTP 200 on failure**, with the error in the body. Callers
  must not branch on the status code.
- **Core self-order takes `full_product_name` from the client**
  (`pos_self_order/models/pos_order.py:155`). We build it server-side instead,
  porting `constructFullProductName` (`point_of_sale/static/src/utils.js:36-72`).
- **An empty pricelist is safe.** `_get_product_price` guards with
  `self and self.ensure_one()` and falls through to list price — which is the
  path both deployments take, since neither has a pricelist.

## Verification

Repo convention: `tests/` per addon, `CommonPosTest` from
`odoo.addons.point_of_sale.tests.common`, `@tagged('post_install', '-at_install')`.
`run-tests.sh` picks up a new addon directory automatically. Payload-building
helpers to copy: `goopter_pos_split_bill/tests/test_process_order.py:44-90`.

Cases that must pass:
- Insert with no table → new draft order, correct totals.
- Insert with table, no existing order → new order on that table.
- Insert with table + existing draft order → lines appended; **pre-existing lines
  unchanged and none removed**.
- Insert onto an order with a non-void `sub_order_id` → rejected.
- Insert onto an order with any payment → rejected.
- Table id whose floor is not in `config.floor_ids` → rejected (cross-config
  isolation).
- Unknown table id → rejected.
- Archived (`active = False`) table id → rejected.
- No open session → rejected.
- Same cart replayed verbatim → no duplicate lines (idempotency).
- **Two different carts both using `line_id: "ln_1"` → both insert cleanly.**
  This is the regression test for uuid namespacing; without the `cart_id:`
  prefix it raises a unique-constraint violation.
- **Cart re-sent at v2 with a new line C** → only C is inserted; A and B are
  untouched.
- **Cart re-sent at v2 with A's quantity changed** → A's qty in the POS is
  **unchanged** (strict append-only). This is the test that catches core's
  CREATE→UPDATE rewrite leaking through.
- Cart re-sent at v2 with a line removed → the line remains in the POS.
- Quote totals == totals of the order created by insert, for the same items
  (the consistency guarantee), including a qty > 1 case and a case with a
  `price_extra`-bearing modifier.
- Client-supplied `*_cents` disagreeing wildly with reality → ignored; order is
  priced correctly.
- Client-supplied `name` / `names` → ignored; `full_product_name` matches what
  the POS itself would produce for the same product + modifiers.
- A `ptav_id` not belonging to `product_tmpl_id` → rejected.
- **Append to an order containing a happy-hour-discounted line → that line's
  `price_unit` is unchanged.** This is the regression test for the recompute
  scoping rule below; a wholesale `recompute_prices()` erases the discount and
  this test is the only thing that catches it.
