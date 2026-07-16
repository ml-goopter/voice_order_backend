import type { Cart } from './cart-types.js';
import type { QuoteRequest } from '../odoo/quote-request.js';

/**
 * Map our Cart onto the far side's quote contract (SPEC § Quote behavior). Same item shape as
 * the insert mapper (`cart-to-insert-request.ts`) so the two price identically, minus the two
 * insert-only fields: quote creates nothing, so it carries no `cart_id` (no line-uuid
 * namespace) and no `table_id`. `preset_id` is deliberately never sent — every cart is priced
 * as dine-in (SPEC § Open questions — resolved #2), matching what confirm inserts.
 */
export function toQuoteRequest(cart: Cart): QuoteRequest {
  return {
    pos_config_id: cart.pos_config_id,
    items: cart.items.map((line) => ({
      line_id: line.line_id,
      product_tmpl_id: line.product_tmpl_id,
      quantity: line.quantity,
      // `ptav_id` is the only part of a modifier the far side reads.
      ...(line.modifiers.length > 0 ? { ptav_ids: line.modifiers.map((m) => m.ptav_id) } : {}),
    })),
  };
}
