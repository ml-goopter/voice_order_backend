import type { CartCache } from '../../redis/cart-cache.js';
import type { CartId, PosConfigId } from '../../shared/types.js';
import type { Cart } from '../../cart/cart-types.js';
import { emptyCart } from '../../cart/cart-types.js';

/** Load the current cart snapshot; the turn's base_version comes from cart.version (§9). */
export async function loadCart(
  carts: CartCache,
  cart_id: CartId,
  pos_config_id: PosConfigId,
): Promise<Cart> {
  return (await carts.get(cart_id)) ?? emptyCart(cart_id, pos_config_id);
}
