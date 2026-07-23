import type {
  CartId,
  Cents,
  DeviceId,
  LangCode,
  LineId,
  PosConfigId,
  PosOrderId,
  ProductId,
  ProductTmplId,
  PtavId,
  RestaurantTableId,
} from '../shared/types.js';

/** A selected modifier on a cart line — an Odoo product_template_attribute_value. */
export interface CartModifier {
  ptav_id: PtavId;
  name: string; // default display name captured at add time (see CartLine.name)
  /** All translatable names by res.lang code, snapshotted at add time; the client picks a locale. */
  names?: Record<LangCode, string>;
}

/** One line in the cart. `line_id` is stable and assigned by the Cart Module (§8). */
export interface CartLine {
  line_id: LineId;
  product_tmpl_id: ProductTmplId;
  product_id?: ProductId; // resolved sellable variant, if known
  name: string; // default display name captured at add time (en_US, falling back per §menu)
  // All translatable names by Odoo res.lang code, snapshotted at add time (e.g.
  // { en_US: "Chicken Burger", zh_CN: "鸡肉汉堡" }). The client picks which to
  // display; `name` above is the single-string fallback.
  names: Record<LangCode, string>;
  quantity: number;
  modifiers: CartModifier[];
  /**
   * This line's subtotal in integer cents, **ex-tax**: (base + Σ modifier surcharge) × quantity.
   * Server-authoritative when priced by the POS quote (`applyQuoteToCart`), otherwise the
   * applier's local estimate. Untaxed — unlike the cart's tax-included `total_cents`.
   */
  price_cents: Cents;
}

/** The full cart snapshot — mirrors the Redis value. */
export interface Cart {
  cart_id: CartId;
  pos_config_id: PosConfigId;
  /**
   * The device that CREATED this cart. Stable across reconnects (session_id is not).
   * Optional on the type but guaranteed by the write path: only CartController.ensureCart
   * creates a persisted cart, and it always stamps one. The other emptyCart callers build
   * throwaway carts for prompt views and resume snapshots that are never written.
   */
  device_id?: DeviceId;
  /** restaurant_table.id — dine-in only. Absent = takeout/untabled (SPEC allows untabled orders). */
  table_id?: RestaurantTableId;
  version: number;
  items: CartLine[];
  subtotal_cents: Cents;
  tax_cents: Cents;
  total_cents: Cents;
  last_updated: string; // ISO
  /** Set once when the cart is inserted into Odoo. Never cleared — this is the confirmation lock. */
  confirmed_at?: string; // ISO
  pos_order_id?: PosOrderId;
}

export function emptyCart(
  cart_id: CartId,
  pos_config_id: PosConfigId,
  identity?: { device_id?: DeviceId; table_id?: RestaurantTableId },
): Cart {
  return {
    cart_id,
    pos_config_id,
    ...(identity?.device_id !== undefined ? { device_id: identity.device_id } : {}),
    ...(identity?.table_id !== undefined ? { table_id: identity.table_id } : {}),
    version: 0,
    items: [],
    subtotal_cents: 0,
    tax_cents: 0,
    total_cents: 0,
    last_updated: new Date().toISOString(),
  };
}
