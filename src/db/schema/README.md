# Data Schema

PostgreSQL DDL for Voice-Based Ordering. Files run in numeric order (`00` → `07`);
apply them via `scripts/migrate.ts`. Design references point at `design.cleaned.md`;
the menu/restaurant source of truth is `menu_restaurant_schema.md` (Odoo POS).

## Three data stores

| Store | Holds | Ownership |
|---|---|---|
| **Odoo POS Postgres** | menu (`product_template`/`product_product`), modifiers (`product_attribute*`), categories, combos, floors/tables (`restaurant_table`), restaurants (`pos_config`), **confirmed orders** (`pos_order`) | Odoo ORM — we READ, never alter |
| **Redis** | live active carts (`cart:{pos_config_id}:{cart_id}`) | ours — sole hot copy |
| **This schema (Postgres)** | voice settings, cart registry + recovery snapshots, sessions, transcripts, clarifications, server calls, idempotency ledger, order-confirmation bridge | ours |

The voice-ordering tables reference Odoo rows by their **integer primary key** as a
*soft* reference (no cross-schema FK — Odoo owns those tables' lifecycle). Our own
identities (`cart_id`, `session_id`, `line_id`, `request_id`) stay as text keys.

## Files

| File | Content |
|---|---|
| `00_extensions.sql` | `vector` (optional, pgvector) |
| `01_external_odoo.sql` | **reference only** — maps concepts to the Odoo tables we read (no DDL) |
| `02_settings.sql` | `voice_restaurant_settings` (per-POS voice config) |
| `03_embeddings.sql` | `menu_embeddings` (optional; keyed to Odoo product/attribute/combo ids) |
| `04_carts.sql` | `carts`, `cart_snapshots`, `processed_requests` |
| `05_order_confirmations.sql` | `voice_order_confirmations` (cart → Odoo `pos_order` bridge) |
| `06_voice.sql` | `voice_sessions`, `transcripts`, `clarifications` |
| `07_server_calls.sql` | `server_calls` |

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
| FR1 | Initiate a voice order | `voice_sessions`, `carts` |
| FR2 | Transcribe & show live | `transcripts` (finals only; partials display-only, §3/§5) |
| FR3 | Voice → structured records | `carts`/`cart_snapshots` (active, Odoo ids) → Odoo `pos_order` via `voice_order_confirmations` |
| FR4 | Edit an order in a later session | stable `cart_id` + `line_id`; `carts`/`cart_snapshots` persist; `voice_sessions.cart_id` re-attaches |
| FR5 | Order in any supported language | Odoo jsonb `name`/`description` translations + `menu_embeddings` (multi-vector) + `voice_restaurant_settings.supported_languages` |
| FR6 | Cart always visible | `carts.version` (optimistic version, §9) + `cart_snapshots` drive the `cart.updated` broadcast |
| FR7 | Call server to table | `server_calls` + Odoo `restaurant_table` |

Cross-cutting: **idempotency** (`processed_requests`; `voice_order_confirmations.request_id`),
**versioning** (`carts.version`), **clarification loop** (`clarifications`, one open per cart, §6/§9).

## Redis active-cart shape (reference — not Postgres)

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

`cart_snapshots.snapshot` mirrors this JSON so Redis can be rebuilt after a loss.

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
