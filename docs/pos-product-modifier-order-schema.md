# POS Product, Modifier & Order Schema

Reference for the product, modifier, and order tables as they exist in the two
live POS databases. Written for anyone building against this data (e.g. an
external cart/ordering API) who needs to know how a menu item, its options, and
a placed order are actually represented.

- **Source:** PostgreSQL (`goopter_odoo_docker-db-1`), databases `jadegarden1`
  and `pos_izumisushi`, inspected 2026-07-15.
- **Odoo version:** 19.0 (`point_of_sale` 19.0.1.0.2 in both).
- **Scope:** POS only. `sale.order` / `sale.order.line` are out of scope.

## TL;DR

1. **There is no "modifier" table.** Modifiers are stock Odoo *product
   attributes* configured as `create_variant = 'no_variant'`. Every attribute in
   both databases uses this mode, so attributes never spawn product variants —
   `product_product` is 1:1 with `product_template`.
2. A modifier selection reaches an order line through the many2many
   `pos_order_line_product_template_attribute_value_rel`.
3. The surcharge lives in `product_template_attribute_value.price_extra`. It is
   **per selected option** (not per attribute group) and is **already included in
   `price_unit`** — adding it again double-charges. See
   [Modifier pricing](#modifier-pricing).
4. **The two tenants use modifiers in opposite ways** — Jade Garden's are
   ~all free exclusions, Izumi's are ~all paid surcharges. See
   [Tenant differences](#tenant-differences).
5. The core column sets are **identical** across both databases; only physical
   column ordering differs. Any client can treat them as one schema.
6. **No popularity data exists** anywhere — derive it from `pos_order_line`, and
   rank by qty rather than revenue. See
   [Sales data & popularity](#5-sales-data--popularity).

## The three layers

```
product_template ──< product_template_attribute_line >── product_attribute
       │                        │                              │
       │                        │                        product_attribute_value
       │                        │                              │
       │                 product_template_attribute_value ─────┘   (price_extra)
       │                        │
       │                        │  m2m: pos_order_line_product_template_attribute_value_rel
       │                        │
pos_order ──< pos_order_line >──┘
```

---

## 1. Product

### `product_template` — the menu item

The catalog record. In both databases `product_product` exists 1:1 with
`product_template` (386/386 in Jade Garden, 302/302 in Izumi) because no
attribute creates variants. **For POS work, treat `product_template` as the
product** and use `product_product.id` only where a foreign key demands it
(e.g. `pos_order_line.product_id`).

Key columns:

| Column | Type | Notes |
|---|---|---|
| `id` | integer | PK |
| `name` | **jsonb** | Translated field — read as `name->>'en_US'`, not as text |
| `list_price` | numeric | Base menu price, before modifier `price_extra` |
| `available_in_pos` | boolean | The POS visibility flag; filter on this |
| `active` | boolean | Odoo soft-delete — archived products stay in the table |
| `type` | varchar | `consu` / `service` / `combo` |
| `categ_id` | integer | Accounting category, **not** the POS menu category |
| `to_weight` | boolean | Sold by weight |
| `default_code` | varchar | Internal reference / SKU |
| `alternative_name` | varchar | Custom — kitchen/secondary-language name (see §5) |

Two gotchas worth internalizing:

- **`name` is `jsonb`,** not a string. Odoo 19 stores translations inline.
  `SELECT name FROM product_template` returns JSON.
- **POS menu category is `pos_categ_ids`,** a many2many via
  `pos_category_product_template_rel` — not the scalar `categ_id`.

### Counts

|  | jadegarden1 | pos_izumisushi |
|---|---|---|
| `product_template` | 386 | 302 |
| available in POS | 380 | 299 |
| `product_product` | 386 | 302 |

---

## 2. Modifiers

### How they are modeled

Modifiers are the stock Odoo attribute chain. There is no custom modifier model.
Four tables cooperate:

**`product_attribute`** — the modifier *group* ("No Sauces", "Size").

| Column | Type | Notes |
|---|---|---|
| `id` | integer | PK |
| `name` | jsonb | Translated |
| `display_type` | varchar | `multi` / `radio` / `pills` / `select` / `color` |
| `create_variant` | varchar | **`no_variant` for every attribute in both DBs** |
| `sequence` | integer | Display order |

`display_type` is the field that decides UI behavior and therefore cardinality:

- `radio` / `pills` / `select` → pick exactly one
- `multi` → checkboxes, pick zero or more

Actual usage:

| display_type | jadegarden1 | pos_izumisushi |
|---|---|---|
| `multi` | 7 | 2 |
| `radio` | 7 | – |
| `pills` | 1 | – |

**`product_attribute_value`** — the global option value ("No Peanuts", "Large").
Reusable across products. Has `is_custom` (allows free-text entry) and
`default_extra_price`.

**`product_template_attribute_line` (ptal)** — attaches an attribute group to one
product, with the subset of values offered. This is the "this dish has a Sauces
group" row.

**`product_template_attribute_value` (ptav)** — the per-product option. **This is
the row an order line points at**, and it carries the price:

| Column | Type | Notes |
|---|---|---|
| `id` | integer | PK — referenced by order lines |
| `product_attribute_value_id` | integer | → the global value |
| `attribute_line_id` | integer | → ptal |
| `product_tmpl_id` | integer | Denormalized |
| `price_extra` | numeric | **The surcharge added to the line** |
| `ptav_active` | boolean | Archive flag |

The same option ("Large") has a *different* ptav row per product, so the same
option can cost different amounts on different dishes.

### Reading a product's modifiers

```sql
SELECT pt.name->>'en_US'  AS product,
       pa.name->>'en_US'  AS attribute,
       pa.display_type,
       pav.name->>'en_US' AS value,
       ptav.price_extra
FROM product_template pt
JOIN product_template_attribute_line  ptal ON ptal.product_tmpl_id = pt.id
JOIN product_attribute                pa   ON pa.id   = ptal.attribute_id
JOIN product_template_attribute_value ptav ON ptav.attribute_line_id = ptal.id
JOIN product_attribute_value          pav  ON pav.id  = ptav.product_attribute_value_id
WHERE pt.id = %s AND ptav.ptav_active
ORDER BY pa.sequence, pav.sequence;
```

Real output (Jade Garden, "B. Combination For One B"):

```
product                  | attribute | display_type | value       | price_extra
-------------------------+-----------+--------------+-------------+------------
B. Combination For One B | No Nuts   | multi        | No Peanuts  | 0.0
B. Combination For One B | No Sauces | multi        | no Ginger   | 0.0
```

### Counts

|  | jadegarden1 | pos_izumisushi |
|---|---|---|
| attribute lines (ptal) | 975 | 382 |
| ptav rows | 7,345 | 4,202 |
| `product_attribute_custom_value` | 0 | 0 |

`product_attribute_custom_value` (free-text answers for `is_custom` values) is
**empty in both** — the feature is unused.

### Modifier pricing

**`price_extra` is per selected option, not per attribute group.** Every selected
option contributes its own `price_extra` and they all sum — including multiple
picks within the *same* group, which may be priced differently from each other.

Order line 115 in `pos_izumisushi` is the worked example. One "Addons" group,
five options ticked:

| selected value | price_extra |
|---|---|
| extra ginger and wasabi | 1.10 |
| add avocado | 1.10 |
| side of unagi sauce | 1.10 |
| side of chilli sauce | 1.10 |
| chilli sauce on top | **0.55** |

1.10 × 4 + 0.55 = **4.95**, exactly the line's stored `price_extra`.

The POS sums every selected value with no per-group collapsing
(`product_configurator_popup.js`):

```js
get priceExtra() {
    return this.selectedValues
        .filter((value) => value.attribute_id.create_variant === "no_variant")
        .reduce((acc, val) => acc + val.price_extra, 0);
}
```

(A second path in `pos_store.js` reduces over `values[0].price_extra` — that is
the auto-select case where an attribute line has exactly one possible value and
no configurator opens. It is not the general rule.)

#### How a line total composes

`product_template_accounting.js :: getPrice()` computes:

```js
let price = basePrice + (price_extra || 0);
if (!pricelist) { return price; }   // ← the path both tenants take
```

That result becomes `price_unit`. So:

```
price_unit     = list_price + price_extra          (price_extra ALREADY included)
price_extra    = Σ price_extra of selected ptav rows
price_subtotal = price_unit × qty × (1 - discount/100)
```

> **Do not add `price_extra` to `price_unit`.** The field is a *record* of the
> modifier component for display and line-regrouping — it is already baked into
> `price_unit`. Adding it again double-charges every modifier.

Because the extra lives inside `price_unit`, it is charged **once per unit** and
multiplies by qty. Line 169 (`pos_izumisushi`): `price_unit` 6.45 (including a
2.20 extra) × qty 2 = 12.90 — the customer pays 2.20 twice while the stored
`price_extra` stays 2.20. There is no per-modifier quantity; an option is a
boolean selection.

#### Verification and known exceptions

`price_unit = list_price + price_extra` holds for ~93% of real lines (1,171/1,268
Jade, 950/1,018 Izumi). The exceptions are legitimate, not corruption:

| Cause | Notes |
|---|---|
| `price_type = 'manual'` | Cashier overrode the price. `price_type` is `original` / `manual` / `automatic`; only `original` recomputes from the product. |
| Combo children | Priced from `product_combo_item.extra_price`, not `list_price`. |
| Refund lines | Mirror the refunded line. |
| **Menu price changed since the order** | `list_price` is *today's* price; orders are historical. This is a confound in any reconciliation, not a bug. |

#### Pricing scope

`price_extra` lives on `product_template_attribute_value` — one row per
**product × option** — so the schema permits the same option to cost different
amounts on different products. Neither tenant currently uses that freedom (zero
option values have more than one distinct price across products). The global
`product_attribute_value.default_extra_price` is only the default that seeds a
new ptav row; it is not read at sale time.

#### Latent hazard: pricelists discard the surcharge

**Both databases have zero pricelists** (`product_pricelist` = 0,
`product_pricelist_item` = 0, none attached to any POS config), so `getPrice()`
early-returns and the composition rule above is exact.

If a pricelist is ever introduced, two branches of `getPrice()` **silently drop
the modifier surcharge**:

```js
if (rule.base === "pricelist") {
    price = this.getPrice(rule.base_pricelist_id, quantity, 0, true, variant);
    //                                            ↑ price_extra passed as literal 0
} else if (rule.base === "standard_price") {
    price = standardPrice;   // ← overwrites price entirely; extra lost
}
```

Only `base = 'list_price'` (the default) preserves it. Anything reading
`pos_order.pricelist_id` (currently null everywhere) should treat this as a
correctness risk to re-verify.

---

## 3. Combos

Combos are a distinct mechanism from modifiers: a parent product bundles child
products, rather than decorating one line with options.

**`product_combo`** — a choice group: `name`, `qty_max`, `qty_free`, `sequence`.
**`product_combo_item`** — one selectable child: `combo_id`, `product_id`,
`extra_price`.

On the order line, combos are expressed via `combo_parent_id` (self-reference to
the parent line), `combo_item_id`, and `combo_id`.

| | jadegarden1 | pos_izumisushi |
|---|---|---|
| `product_combo` | 35 | **0** |
| `product_combo_item` | 35 | **0** |

Izumi does not use combos at all. A client must still handle them for Jade
Garden.

### Optional products — unused

`pos_product_optional_rel` (`product.template.pos_optional_product_ids`, from
`point_of_sale`) and `product_optional_rel` (`optional_product_ids`, from `sale`)
are both **stock Odoo** and both hold **0 rows** in both databases. Ignore them;
they are not this system's modifier mechanism.

---

## 4. Orders

### `pos_order`

| Column | Type | Notes |
|---|---|---|
| `id` | integer | PK |
| `name`, `pos_reference` | varchar | Order name / receipt reference |
| `uuid` | varchar | Client-generated idempotency key — **the field to match on for external submission** |
| `state` | varchar | `draft` / `paid` / `done` / `invoiced` / `cancel` |
| `date_order` | timestamp | |
| `session_id`, `config_id` | integer | POS session / config |
| `partner_id` | integer | Customer |
| `amount_total`, `amount_tax`, `amount_paid`, `amount_return` | numeric | Totals |
| `tip_amount`, `is_tipped` | numeric/bool | |
| `is_refund` | boolean | |
| `tracking_number`, `ticket_code` | varchar | |
| `general_customer_note`, `internal_note` | text | |
| `preset_id`, `preset_time` | int/timestamp | Order preset & scheduled time |
| `table_id`, `customer_count` | integer | Restaurant (`pos_restaurant`) |
| `access_token` | varchar | Self-order access |

Custom columns present in both: `active_sub_order_id`, `refund_target_due_id`
(`goopter_pos_split_bill`), `asap_due_time` (`pos_order_type_topbar`),
`original_order_id` (see [Hazards](#hazards)).

### `pos_order_line`

| Column | Type | Notes |
|---|---|---|
| `id` | integer | PK |
| `order_id` | integer | → `pos_order` |
| `product_id` | integer | → **`product_product`**, not `product_template`. `ON DELETE RESTRICT`, so a product that has ever been sold can never be deleted — only archived (`active = false`). Historical lines always resolve. |
| `qty` | numeric | |
| `price_unit` | numeric | |
| `price_extra` | double precision | Modifier surcharge rolled onto the line |
| `price_subtotal`, `price_subtotal_incl` | numeric | Excl./incl. tax |
| `discount` | numeric | Percent |
| `full_product_name` | varchar | **Denormalized name incl. modifier text at sale time** |
| `customer_note`, `note` | varchar | |
| `uuid` | varchar | Client-generated |
| `combo_parent_id`, `combo_item_id`, `combo_id` | integer | Combo linkage |
| `refunded_orderline_id` | integer | Refund source |
| `is_reward_line`, `reward_id`, `coupon_id`, `points_cost` | | Loyalty |
| `sale_order_origin_id`, `sale_order_line_id` | integer | `pos_sale` bridge |

Custom: `payment_due_id`, `reward_source_line_id`, `reward_pinned_qty`
(`goopter_pos_split_bill`).

### Modifiers on an order line

The join table is
**`pos_order_line_product_template_attribute_value_rel`**
(`pos_order_line_id`, `product_template_attribute_value_id`).

```sql
SELECT l.id, l.full_product_name, l.qty, l.price_unit, l.price_extra,
       pav.name->>'en_US' AS modifier, ptav.price_extra AS modifier_price
FROM pos_order_line l
LEFT JOIN pos_order_line_product_template_attribute_value_rel r
       ON r.pos_order_line_id = l.id
LEFT JOIN product_template_attribute_value ptav
       ON ptav.id = r.product_template_attribute_value_id
LEFT JOIN product_attribute_value pav
       ON pav.id = ptav.product_attribute_value_id
WHERE l.order_id = %s;
```

The line's own `price_extra` is the sum of the selected ptav values, and it is
**already included in `price_unit`** — see
[Modifier pricing](#modifier-pricing) for the full composition rule and the
double-charging trap.

### Counts

|  | jadegarden1 | pos_izumisushi |
|---|---|---|
| `pos_order` | 403 | 299 |
| `pos_order_line` | 1,268 | 1,018 |
| lines carrying modifiers | 253 (20%) | 155 (15%) |

---

## 5. Sales data & popularity

### There is no popularity data

Nothing precomputes, stores, or caches product popularity — not in
`point_of_sale`, not in `pos_self_order`, not in any Goopter addon. Ranking must
be derived from `pos_order_line`.

### `product.template.sales_count` is a trap

It looks like the field you want. It is not usable here:

- **Not stored** (`store = False`) — computed on read, so it cannot be sorted or
  filtered in SQL.
- Computes from **`sale.report`** — sale orders, not POS orders — over a rolling
  365 days, and requires the `sales_team.group_sale_salesman` group.
  `pos_sale` does not patch it.
- `sale_order` holds **1 row (Jade) / 0 rows (Izumi)**, so it reads **0 for every
  product** in both databases.

### `report_pos_order` is a live view

A regular SQL **view** over `pos_order_line` (not a table, not a materialized
view, not a cache). It recomputes on every query and exists to back the POS
Analysis UI. Convenient pre-joined shape — product, category, session, margin,
payment method — but no performance advantage over querying the lines directly.

### What is actually stored

| Table | jadegarden1 | pos_izumisushi | Holds |
|---|---|---|---|
| `pos_order` | 403 | 303 | Header: totals, state, date, session, customer |
| `pos_order_line` | 1,268 | 1,065 | **The line-level sales record** |
| `pos_session` | 39 | 93 | Till sessions |
| `pos_payment` | 381 | 179 | Tenders per order |
| `sale_order` | 1 | 0 | Effectively unused |

**Date coverage is thin:** Jade Garden `2026-06-14 → 2026-07-15` (~1 month),
Izumi `2026-05-29 → 2026-07-15` (~7 weeks). Any popularity signal rests on about
a month of trade. Both are live production databases.

### Deriving popularity

```sql
SELECT pt.id, pt.name->>'en_US' AS product, sum(l.qty) AS qty_sold
FROM pos_order_line l
JOIN pos_order o        ON o.id  = l.order_id
JOIN product_product pp ON pp.id = l.product_id
JOIN product_template pt ON pt.id = pp.product_tmpl_id
WHERE o.state IN ('paid','done','invoiced')   -- excludes draft / cancel
  AND NOT l.is_reward_line
  AND pt.id NOT IN (/* tip + cover-charge product ids, per tenant */)
GROUP BY pt.id, pt.name
ORDER BY qty_sold DESC;
```

Refunds net out on their own — refund lines carry negative `qty`.

### Caveats that will bite

**Rank by quantity, never revenue — Izumi is all-you-can-eat.** Its top sellers
are `- A` suffixed items with `list_price = 0.00`: 89 Atlantic Salmon sashimi
sold for **$0.00 revenue**. Diners order them freely; money is collected once via
the "Adult" cover product ($36.99). **96 of Izumi's 299 POS products (32%) are
$0** (Jade: 40 of 380). A revenue-ranked menu puts Izumi's most popular food
last.

**Exclude service and cover products.** "Tips" ranks top-8 in *both* databases
(43 Jade / 26 Izumi) and "Adult" is #2 in Izumi — neither is a dish. Note "Tips"
has `available_in_pos = false`, so filtering on that flag will **not** remove it
from historical lines; exclude it explicitly. The exclusion list is
tenant-specific.

**Join through the variant — don't assume id equality.** `pos_order_line` has no
template column; resolve via `product_product.product_tmpl_id`. `product_id` is
*not* the template id, but it coincidentally matches often enough to hide a bug:
**185 of 302 match in Izumi (61%)** vs **33 of 386 in Jade (9%)**. Shortcut code
looks fine against Izumi and breaks on Jade Garden.

---

## 6. Custom fields added by Goopter addons

Fields these addons add to the core POS models (all installed in both databases
unless noted):

| Model | Addon | Fields |
|---|---|---|
| `product.template` / `product.product` | `pos_product_alternative_name` | `alternative_name` (Char; stored on both; legacy alias `kitchen_name_zh`) |
| `product.template` | `pos_predefined_tip_options` | `is_tip_percentage_product`, `tip_percentage_tax_base`, `tip_flat_min_order_total`, `tip_percentage_values` (jsonb), `tip_flat_values` (jsonb) |
| `pos.order` | `goopter_pos_split_bill` | `guest_ids`, `discount_ids`, `sub_order_ids`, `active_sub_order_id`, `refund_target_due_id` |
| `pos.order` | `pos_order_type_topbar` | `asap_due_time` |
| `pos.order` | `pos_order_history_ext` | `original_order_id` (stored) |
| `pos.order.line` | `goopter_pos_split_bill` | `guest_assignment_ids`, `payment_due_id`, `reward_source_line_id`, `reward_pinned_qty` |

Split-bill adds its own tables: `pos_order_guest`, `pos_order_line_guest`
(per-guest qty allocation), `pos_order_discount` (order-level discounts).

### Module differences between the tenants

Installed in **jadegarden1 only**: `goopter_pos_bypass_global_discount`,
`goopter_pos_escpos_agent`, `pos_customer_search_prefill`, `pos_discount`,
`pos_order_printer_customization`, `pos_receipt_language`.

Installed in **pos_izumisushi only**:
`pos_hide_priceless_products_on_customer_receipt`.

None of these alter the product/modifier/order columns — the core column sets
remain identical.

---

## Tenant differences

The schemas match; the **data conventions do not**. This is the most important
thing for a client to get right.

| | jadegarden1 | pos_izumisushi |
|---|---|---|
| Attribute display types | `multi`, `radio`, `pills` | `multi` only |
| ptav rows with `price_extra > 0` | **16 of 7,345 (0.2%)** | **3,438 of 4,202 (82%)** |
| Combos | 35 | 0 |

**Jade Garden** uses modifiers as *free allergen/sauce exclusions* — "No
Peanuts", "no Ginger", all at `price_extra = 0`. The handful of paid ones are
sizes ("1/2 Carafe" +8.50, "L" +4.00, "Pepperoni" +3.00).

**Izumi** uses modifiers as *paid add-ons* — most values carry a surcharge (e.g.
"$4 charge" +4.00).

Any pricing logic must read `price_extra` per ptav rather than assume modifiers
are free; a client tested only against Jade Garden would appear correct while
silently under-charging every Izumi order.

---

## Hazards

### `original_order_id` is declared twice

Two installed addons define `pos.order.original_order_id` incompatibly:

- `pos_order_history_ext/models/pos_order.py:7` — `Many2one`, **stored**
- `goopter_order_refund_list/models/pos_order.py:33` — `Many2one`, **computed,
  non-stored**

Neither module depends on the other, so the winner follows module load order.
In both live databases the **stored column exists**, i.e. `pos_order_history_ext`
currently wins. `pos_order_history_ext` carries a defensive `read_pos_orders`
override whose docstring cites crashes from missing `original_order_id`, so this
collision has bitten before. Treat the column as present-but-fragile.

### `goopter_pos_attribute_selection_limit` is NOT installed

The addon defines min/max modifier-selection limits on
`product.template.attribute.line` (`attribute_selection_limit_enabled`,
`attribute_min_selection_count`, `attribute_max_selection_count`), but its state
is **`uninstalled` in both databases** and **the columns do not exist**.

There is therefore **no server-side enforcement of how many options may be
chosen** for a `multi` attribute. A client cannot read min/max constraints from
the database, and must not assume the server will reject an invalid selection
count.

### Tables that look relevant but are not

| Table | Reality |
|---|---|
| `product_value` | Stock `stock_account` inventory valuation. Unrelated to modifiers. |
| `update_product_attribute_value` | Stock Odoo transient wizard. 0 rows. |
| `product_variant_combination` | Stock `product` m2m (`product_product` ↔ ptav). Unused here — no variants exist. |
| `Products` | Stock `stock` package relation with an oddly capitalized name. 0 rows. |
| `product_optional_rel`, `pos_product_optional_rel` | Stock optional-products m2m. 0 rows in both. |

---

## Reproducing this inspection

```bash
docker exec goopter_odoo_docker-db-1 psql -U odoo -d jadegarden1 -c "\d product_template"
docker exec goopter_odoo_docker-db-1 psql -U odoo -d pos_izumisushi -c "\d pos_order_line"
```

The ORM view (authoritative, covers core + custom, includes non-stored fields):

```sql
SELECT f.model, f.name, f.ttype, f.relation, f.relation_table, m.module
FROM ir_model_fields f
LEFT JOIN ir_model_data m ON m.model = 'ir.model.fields' AND m.res_id = f.id
WHERE f.model IN ('product.template','product.attribute',
                  'product.template.attribute.value','pos.order','pos.order.line')
ORDER BY f.model, f.name;
```

When checking module state, match `state = 'installed'` exactly — a `LIKE`/grep
on `installed` also matches `uninstalled`.
