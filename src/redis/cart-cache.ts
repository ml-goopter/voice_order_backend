import type { Redis } from 'ioredis';
import type { CartId } from '../shared/types.js';
import type { Cart } from '../cart/cart-types.js';
import { logger } from '../config/logger.js';
import { errorMeta } from '../shared/errors.js';

/**
 * Hot store for active carts (design §9). Redis is the real backing store;
 * `InMemoryCartCache` keeps the scaffold runnable without a server.
 */
export interface CartCache {
  get(cart_id: CartId): Promise<Cart | undefined>;
  set(cart: Cart): Promise<void>;
  delete(cart_id: CartId): Promise<void>;
}

/** Redis key for a cart. `cart_id` is a globally-unique text key (see shared/types). */
export function cartKey(cart_id: CartId): string {
  return `cart:${cart_id}`;
}

/** CartCache backed by ioredis — one JSON blob per cart at `cart:{cart_id}`. */
export class RedisCartCache implements CartCache {
  constructor(private readonly redis: Redis) {}

  async get(cart_id: CartId): Promise<Cart | undefined> {
    const raw = await this.redis.get(cartKey(cart_id));
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as Cart;
    } catch (err) {
      logger.error('cart.parse_failed', { cart_id, ...errorMeta(err) });
      return undefined;
    }
  }

  async set(cart: Cart): Promise<void> {
    await this.redis.set(cartKey(cart.cart_id), JSON.stringify(cart));
  }

  async delete(cart_id: CartId): Promise<void> {
    await this.redis.del(cartKey(cart_id));
  }
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
