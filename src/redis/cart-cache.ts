import type { CartId } from '../shared/types.js';
import type { Cart } from '../cart/cart-types.js';

/**
 * Hot store for active carts (design §9). Key: cart:{pos_config_id}:{cart_id}.
 * Redis is the real backing store; this in-memory default keeps the scaffold
 * runnable. TODO: RedisCartCache backed by ioredis.
 */
export interface CartCache {
  get(cart_id: CartId): Promise<Cart | undefined>;
  set(cart: Cart): Promise<void>;
  delete(cart_id: CartId): Promise<void>;
}

export class InMemoryCartCache implements CartCache {
  private readonly store = new Map<CartId, Cart>();

  async get(cart_id: CartId): Promise<Cart | undefined> {
    return this.store.get(cart_id);
  }

  async set(cart: Cart): Promise<void> {
    this.store.set(cart.cart_id, cart);
  }

  async delete(cart_id: CartId): Promise<void> {
    this.store.delete(cart_id);
  }
}
