import type { Redis } from 'ioredis';
import type { PosOrderId, RequestId } from '../shared/types.js';
import type { Cart } from './cart-types.js';
import type { CartCache } from '../redis/cart-cache.js';
import { cartKey } from '../redis/cart-cache.js';
import { logger } from '../config/logger.js';

export type Outcome = 'applied' | 'rejected' | 'duplicate' | 'superseded';

/**
 * Durability for the Cart Module (design §9): the idempotency ledger, recovery
 * snapshots, and hand-off of confirmed carts to Odoo pos_order. Two implementations
 * behind one interface (mirrors CartCache): Redis for the app, in-memory for tests.
 */
export interface CartRepository {
  /** Has this request already been applied/rejected? (idempotency, §9/§11) */
  wasProcessed(request_id: RequestId): Promise<boolean>;
  /** Record a request's terminal outcome in the ledger — ledger only, no cart write. */
  markProcessed(request_id: RequestId, outcome: Outcome): Promise<void>;
  /** Persist the applied cart AND mark the request processed in one atomic step. */
  commitApplied(cart: Cart, request_id: RequestId): Promise<void>;
  saveSnapshot(cart: Cart): Promise<void>;
  confirmOrder(cart: Cart): Promise<PosOrderId>;
}

/** Idempotency-ledger key. TTL-bounded (see RedisCartRepository) so it never grows without limit. */
function reqKey(request_id: RequestId): string {
  return `cart:req:${request_id}`;
}

/**
 * CartRepository backed by Redis. Ledger keys expire after `ttlSeconds` so the
 * idempotency ledger stays bounded. `commitApplied` writes the cart blob and the
 * ledger mark in a single MULTI so a crash can't leave the cart persisted but the
 * request un-marked (which would double-apply a non-idempotent add_item on retry).
 */
export class RedisCartRepository implements CartRepository {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
  ) {}

  async wasProcessed(request_id: RequestId): Promise<boolean> {
    return (await this.redis.exists(reqKey(request_id))) === 1;
  }

  async markProcessed(request_id: RequestId, outcome: Outcome): Promise<void> {
    await this.redis.set(reqKey(request_id), outcome, 'EX', this.ttlSeconds);
  }

  async commitApplied(cart: Cart, request_id: RequestId): Promise<void> {
    await this.redis
      .multi()
      .set(cartKey(cart.cart_id), JSON.stringify(cart))
      .set(reqKey(request_id), 'applied', 'EX', this.ttlSeconds)
      .exec();
  }

  async saveSnapshot(cart: Cart): Promise<void> {
    // The live cart already persists at cartKey (via commitApplied). TODO: a
    // versioned recovery snapshot keyed by cart_id + version for rollback.
    logger.debug('cart.snapshot', { cart_id: cart.cart_id, version: cart.version });
  }

  /** Confirm: write the cart as an Odoo pos_order (design §9, step 11). */
  async confirmOrder(cart: Cart): Promise<PosOrderId> {
    // TODO: create pos_order / pos_order_line via an Odoo client; record the confirmation.
    logger.warn('cart.confirm_stub', { cart_id: cart.cart_id });
    return 0;
  }
}

/**
 * In-memory CartRepository for tests. It shares the CartCache instance so
 * `commitApplied` is observable to the controller's cart reads, exactly as the
 * shared Redis key is in production.
 */
export class InMemoryCartRepository implements CartRepository {
  private readonly processed = new Map<RequestId, Outcome>();

  constructor(private readonly cache: CartCache) {}

  async wasProcessed(request_id: RequestId): Promise<boolean> {
    return this.processed.has(request_id);
  }

  async markProcessed(request_id: RequestId, outcome: Outcome): Promise<void> {
    this.processed.set(request_id, outcome);
  }

  async commitApplied(cart: Cart, request_id: RequestId): Promise<void> {
    await this.cache.set(cart);
    this.processed.set(request_id, 'applied');
  }

  async saveSnapshot(cart: Cart): Promise<void> {
    logger.debug('cart.snapshot', { cart_id: cart.cart_id, version: cart.version });
  }

  async confirmOrder(cart: Cart): Promise<PosOrderId> {
    logger.warn('cart.confirm_stub', { cart_id: cart.cart_id });
    return 0;
  }
}
