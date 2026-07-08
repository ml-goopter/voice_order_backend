import type { CartCache } from '../../redis/cart-cache.js';
import type { CartId, PosConfigId } from '../../shared/types.js';
import type { Cart } from '../../cart/cart-types.js';
import { emptyCart } from '../../cart/cart-types.js';
import type { MenuLookup } from '../../menu/menu-service.js';
import type { CartView } from '../schemas/order-graph-input.schema.js';

/** Load the current cart snapshot; the turn's base_version comes from cart.version (§9). */
export async function loadCart(
  carts: CartCache,
  cart_id: CartId,
  pos_config_id: PosConfigId,
): Promise<Cart> {
  return (await carts.get(cart_id)) ?? emptyCart(cart_id, pos_config_id);
}

/**
 * Project the stored cart into a self-describing view for the prompt (Plan A): resolve each
 * line's item (one batched menu read) to its name + menu_item_key + available_modifiers, and
 * map each attached ptav_id to its {modifier_key, name}. Degrades gracefully when an item or
 * ptav_id is missing from the menu (numeric-id fallback, dropped modifier) so a stale line
 * never throws. Keys/names only — no numeric ids reach the model.
 */
export async function buildCartView(menu: MenuLookup, cart: Cart): Promise<CartView> {
  const tmplIds = [...new Set(cart.items.map((l) => l.product_tmpl_id))];
  const items = await menu.getItems(cart.pos_config_id, tmplIds);
  const byTmpl = new Map(items.map((i) => [i.product_tmpl_id, i]));
  return {
    cart_id: cart.cart_id,
    pos_config_id: cart.pos_config_id,
    version: cart.version,
    items: cart.items.map((line) => {
      const item = byTmpl.get(line.product_tmpl_id);
      const avail = item?.modifiers ?? [];
      return {
        line_id: line.line_id,
        menu_item_key: item?.menu_item_key ?? String(line.product_tmpl_id),
        name: item?.names?.en_US ?? Object.values(item?.names ?? {})[0] ?? item?.menu_item_key ?? String(line.product_tmpl_id),
        quantity: line.quantity,
        modifiers: line.modifiers
          .map((m) => avail.find((a) => a.ptav_id === m.ptav_id))
          .filter((a): a is NonNullable<typeof a> => a !== undefined)
          .map((a) => ({ modifier_key: a.modifier_key, name: a.name })),
        available_modifiers: avail.map((a) => ({ modifier_key: a.modifier_key, name: a.name })),
      };
    }),
  };
}
