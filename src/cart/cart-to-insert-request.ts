import type { Cart } from './cart-types.js';
import type { InsertCartRequest } from '../odoo/insert-cart-request.js';

/**
 * Map our Cart onto the far side's insert contract (SPEC § "Mapping from the external
 * service's `Cart`"). The fields we omit are dropped BY CONTRACT, not by oversight:
 * `name`/`names` would let us print arbitrary text on kitchen tickets (Odoo builds
 * `full_product_name` server-side); `product_id` is only ever sent "if known", so the
 * far side must resolve from template + PTAVs regardless; `*_cents` are ignored because
 * pricing is server-authoritative; `version`/`last_updated` are unnecessary because
 * strict append-only makes the insert commutative and idempotent.
 */
export function toInsertCartRequest(cart: Cart): InsertCartRequest {
  return {
    cart_id: cart.cart_id,
    pos_config_id: cart.pos_config_id,
    items: cart.items.map((line) => ({
      // Sent RAW: the far side namespaces it into `{cart_id}:{line_id}` to build the
      // globally-unique line uuid that carries idempotency. Do not pre-namespace here.
      line_id: line.line_id,
      product_tmpl_id: line.product_tmpl_id,
      quantity: line.quantity,
      // `ptav_id` is the only part of a modifier the far side reads.
      ...(line.modifiers.length > 0 ? { ptav_ids: line.modifiers.map((m) => m.ptav_id) } : {}),
    })),
    // Present → send; absent → omit → untabled order. `preset_id` is deliberately never
    // sent (SPEC § Open questions — resolved #2: every cart is treated as dine-in).
    ...(cart.table_id !== undefined ? { table_id: cart.table_id } : {}),
  };
}
