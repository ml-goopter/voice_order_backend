import type { Redis } from 'ioredis';
import type { DeviceId, PosOrderId, RequestId, RestaurantTableId } from '../shared/types.js';
import type { Cart } from './cart-types.js';
import type { CartCache } from '../redis/cart-cache.js';
import { cartKey } from '../redis/cart-cache.js';
import type { OdooClient } from '../odoo/odoo-client.js';
import { toInsertCartRequest } from '../odoo/cart-to-insert-request.js';
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
  /** Persist a newly created cart and its device/table indexes. No request to mark. */
  commitCreated(cart: Cart): Promise<void>;
  confirmOrder(cart: Cart): Promise<PosOrderId>;
}

/** Idempotency-ledger key. TTL-bounded (see RedisCartRepository) so it never grows without limit. */
function reqKey(request_id: RequestId): string {
  return `cart:req:${request_id}`;
}

/** Traceability index: which carts came from this device. */
export function deviceKey(device_id: DeviceId): string {
  return `device:${device_id}`;
}

/** Traceability index: which carts were ordered at this table. */
export function tableKey(table_id: RestaurantTableId): string {
  return `table:${table_id}`;
}

/**
 * Atomically write the cart blob (KEYS[1]=ARGV[1]), the ledger mark (KEYS[2]=ARGV[2],
 * expiring after ARGV[3] seconds), and the traceability indexes: device (KEYS[3]) and,
 * for dine-in only, table (KEYS[4]) — each a Set gaining the cart_id ARGV[4] and expiring
 * after ARGV[5] seconds.
 *
 * Redis runs a Lua script as one indivisible unit: either every write lands or none does.
 * MULTI/EXEC can't promise this — it does not roll back a per-command failure, so a partial
 * commit could persist the cart without marking the request (double-apply on retry) or mark
 * the request without the cart (silent loss). The same hazard applies to the indexes: an
 * indexed cart that does not exist, or a cart missing from its index. A script error rejects
 * the whole call and commits nothing.
 *
 * Two optional writes, each signalled by an empty KEY / sentinel ARGV rather than a varying
 * numkeys, so the key positions stay fixed:
 *  - ARGV[2] = 'skip' — the create path has no request to mark.
 *  - KEYS[3] = ''     — a cart persisted without identity (the applyProposal fallback builds
 *                       one when no client.connected ever created it) indexes nowhere.
 *  - KEYS[4] = ''     — takeout/untabled: no table index.
 */
const COMMIT_CART_LUA = `
redis.call('SET', KEYS[1], ARGV[1])
if ARGV[2] ~= 'skip' then
  redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
end
if KEYS[3] ~= '' then
  redis.call('SADD', KEYS[3], ARGV[4])
  redis.call('EXPIRE', KEYS[3], ARGV[5])
end
if KEYS[4] ~= '' then
  redis.call('SADD', KEYS[4], ARGV[4])
  redis.call('EXPIRE', KEYS[4], ARGV[5])
end
`;

/**
 * CartRepository backed by Redis. Ledger keys expire after `ttlSeconds` so the
 * idempotency ledger stays bounded, and the device/table indexes after
 * `indexTtlSeconds`. Every commit writes the cart blob, the ledger mark, and both
 * indexes in a single Lua script (see COMMIT_CART_LUA) so a crash or error can't
 * leave the cart persisted but the request un-marked (which would double-apply a
 * non-idempotent add_item on retry) or a cart absent from its own index.
 */
export class RedisCartRepository implements CartRepository {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
    private readonly odoo: OdooClient,
    private readonly indexTtlSeconds: number,
  ) {}

  async wasProcessed(request_id: RequestId): Promise<boolean> {
    return (await this.redis.exists(reqKey(request_id))) === 1;
  }

  async markProcessed(request_id: RequestId, outcome: Outcome): Promise<void> {
    await this.redis.set(reqKey(request_id), outcome, 'EX', this.ttlSeconds);
  }

  async commitApplied(cart: Cart, request_id: RequestId): Promise<void> {
    await this.commit(cart, request_id);
  }

  async commitCreated(cart: Cart): Promise<void> {
    await this.commit(cart, undefined);
  }

  /** `request_id` absent → the create path: index and blob, but nothing to mark. */
  private async commit(cart: Cart, request_id: RequestId | undefined): Promise<void> {
    await this.redis.eval(
      COMMIT_CART_LUA,
      4,
      cartKey(cart.cart_id),
      request_id !== undefined ? reqKey(request_id) : '',
      cart.device_id !== undefined ? deviceKey(cart.device_id) : '',
      cart.table_id !== undefined ? tableKey(cart.table_id) : '',
      JSON.stringify(cart),
      request_id !== undefined ? 'applied' : 'skip',
      String(this.ttlSeconds),
      cart.cart_id,
      String(this.indexTtlSeconds),
    );
  }

  /** Confirm: hand the cart to Odoo, which creates the pos_order (design §9, step 11). */
  async confirmOrder(cart: Cart): Promise<PosOrderId> {
    return await this.odoo.insertCart(toInsertCartRequest(cart));
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

  async commitCreated(cart: Cart): Promise<void> {
    await this.cache.set(cart);
  }

  /** Stub by design — tests must never reach Odoo. Override it to observe confirms. */
  async confirmOrder(cart: Cart): Promise<PosOrderId> {
    logger.warn('cart.confirm_stub', { cart_id: cart.cart_id });
    return 0;
  }
}
