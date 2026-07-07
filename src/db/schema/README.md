# Data Reference (external Odoo POS)

The app has **no local Postgres**. Our own durable state (cart registry + recovery
snapshots, sessions, transcripts, clarifications, server calls, idempotency ledger,
order-confirmation bridge) lives in **Redis**; wiring is pending (`redis/*` are
stubs). This directory now holds only the **read-only Odoo POS reference**
(`01_external_odoo.sql`, no DDL). Design references point at `design.cleaned.md`;
the menu/restaurant source of truth is `menu_restaurant_schema.md` (Odoo POS).

## Two data stores

| Store | Holds | Ownership |
|---|---|---|
| **Redis** | live active carts (`cart:{pos_config_id}:{cart_id}`) **and** our durable app state (settings, cart registry + snapshots, sessions, transcripts, clarifications, server calls, idempotency ledger, order-confirmation bridge) | ours |
| **Odoo POS Postgres** | menu (`product_template`/`product_product`), modifiers (`product_attribute*`), categories, combos, floors/tables (`restaurant_table`), restaurants (`pos_config`), **confirmed orders** (`pos_order`) | Odoo ORM — we READ, never alter |

Our records reference Odoo rows by their **integer primary key** as a *soft*
reference (no cross-schema FK — Odoo owns those tables' lifecycle). Our own
identities (`cart_id`, `session_id`, `line_id`, `request_id`) stay as text keys.

## Identity mapping (design §8 keys → Odoo ids)

| Contract term | Data-layer identity (Odoo) |
|---|---|
| `restaurant_id` | `pos_config.id` (`pos_config_id`, int) |
| `menu_item_key` | `product_template.id` (`product_tmpl_id`) / `product_product.id` (`product_id`) |
| `modifier_key` | `product_template_attribute_value.id` (`ptav_id`, carries `price_extra`) |
| table | `restaurant_table.id` (`restaurant_table_id`) |
| confirmed order | `pos_order.id` (`pos_order_id`) |
| `line_id` | ours — assigned by the Cart Module, unrelated to Odoo |

The Menu Candidate Matcher maps between Odoo rows and the LLM/cart payload.

## Functional requirement → coverage

| FR | Requirement | Covered by |
|---|---|---|
| FR1 | Initiate a voice order | voice session + cart registry (Redis) |
| FR2 | Transcribe & show live | transcripts (finals only; partials display-only, §3/§5) — Redis |
| FR3 | Voice → structured records | active cart (Redis, Odoo ids) → Odoo `pos_order` on confirm |
| FR4 | Edit an order in a later session | stable `cart_id` + `line_id`; cart + snapshot persist in Redis; session re-attaches by `cart_id` |
| FR5 | Order in any supported language | Odoo jsonb `name`/`description` translations + in-memory multi-language embeddings (Menu Candidate Matcher) + per-POS `supported_languages` |
| FR6 | Cart always visible | optimistic cart `version` (§9) + snapshot drive the `cart.updated` broadcast |
| FR7 | Call server to table | server-call records (Redis) + Odoo `restaurant_table` |

Cross-cutting: **idempotency** (processed-request ledger), **versioning** (cart
`version`), **clarification loop** (one open clarification per cart, §6/§9).

## Redis active-cart shape

```
key:  cart:{pos_config_id}:{cart_id}
value: {
  cart_id, pos_config_id, version,
  items: [ { line_id, product_tmpl_id, product_id, quantity,
             modifiers: [ { ptav_id } ],
             combo_id, combo_choices: [ product_id ] } ],
  subtotal_cents, tax_cents, total_cents, last_updated
}
```

A recovery snapshot mirrors this JSON so the hot cart can be rebuilt after a loss.

## Conventions

- **Odoo entities → integer soft references** (`pos_config_id`, `product_tmpl_id`,
  `ptav_id`, `restaurant_table_id`, `pos_order_id`); no FK into Odoo tables.
- **Our identities → text keys** (`cart_id`, `session_id`, `line_id`, `request_id`).
- **Multi-language** comes from Odoo jsonb (`{"en_US":…,"zh_CN":…}`); language codes
  are Odoo `res.lang` style (`en_US`, `zh_CN`), **not** bare `en`.
- **Money** in integer minor units (`*_cents`, `bigint`). Odoo `list_price` /
  `price_extra` are `numeric` — convert on read.
- Confirmed order history lives in **Odoo `pos_order`**, not re-normalized here.
```
