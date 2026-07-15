import type {
  CartId,
  Cents,
  LangCode,
  LineId,
  PosConfigId,
  ProductId,
  ProductTmplId,
  PtavId,
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
}

/** The full cart snapshot — mirrors the Redis value. */
export interface Cart {
  cart_id: CartId;
  pos_config_id: PosConfigId;
  version: number;
  items: CartLine[];
  subtotal_cents: Cents;
  tax_cents: Cents;
  total_cents: Cents;
  last_updated: string; // ISO
}

export function emptyCart(cart_id: CartId, pos_config_id: PosConfigId): Cart {
  return {
    cart_id,
    pos_config_id,
    version: 0,
    items: [],
    subtotal_cents: 0,
    tax_cents: 0,
    total_cents: 0,
    last_updated: new Date().toISOString(),
  };
}
