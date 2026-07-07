/**
 * Cross-cutting identifier and value types.
 *
 * Two families (see src/db/schema/README.md):
 *  - OUR identities are opaque text keys (cart, session, request, line).
 *  - ODOO identities are integer primary keys referenced as soft refs.
 */

// Our identities
export type CartId = string; // e.g. "cart_456"; MUST be globally unique — it is the Redis cart key (`cart:{cart_id}`), which is not namespaced by pos_config_id.
export type SessionId = string; // e.g. "voice_session_123"
export type RequestId = string; // e.g. "voice_final_abc123" (idempotency key)
export type LineId = string; // e.g. "ln_1" (assigned by the Cart Module)

// Odoo (POS) identities — integer primary keys
export type PosConfigId = number; // pos_config.id (the "restaurant")
export type ProductTmplId = number; // product_template.id (menu item)
export type ProductId = number; // product_product.id (sellable variant)
export type PtavId = number; // product_template_attribute_value.id (a modifier)
export type RestaurantTableId = number; // restaurant_table.id
export type PosOrderId = number; // pos_order.id (confirmed order)

// Values
export type LangCode = string; // Odoo res.lang code, e.g. "en_US"
export type Cents = number; // integer minor units
