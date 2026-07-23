import { describe, it, expect } from 'vitest';
import type { Redis } from 'ioredis';
import { InMemoryCartCache } from '../redis/cart-cache.js';
import { emptyCart } from './cart-types.js';
import { InMemoryCartRepository, RedisCartRepository } from './cart-repository.js';

describe('InMemoryCartRepository', () => {
  it('commitApplied writes the cart to the shared cache and marks the request', async () => {
    const cache = new InMemoryCartCache();
    const repo = new InMemoryCartRepository(cache);
    const cart = emptyCart('cart_1', 1);
    cart.version = 1;

    expect(await repo.wasProcessed('req_1')).toBe(false);
    await repo.commitApplied(cart, 'req_1');

    expect(await cache.get('cart_1')).toEqual(cart);
    expect(await repo.wasProcessed('req_1')).toBe(true);
  });

  it('markProcessed records an outcome without writing a cart', async () => {
    const cache = new InMemoryCartCache();
    const repo = new InMemoryCartRepository(cache);

    await repo.markProcessed('req_2', 'rejected');
    expect(await repo.wasProcessed('req_2')).toBe(true);
    expect(await cache.get('cart_1')).toBeUndefined();
  });

  it('getOrdersByDevice returns only the confirmed carts for the device', async () => {
    const cache = new InMemoryCartCache();
    const repo = new InMemoryCartRepository(cache);
    const confirmed = { ...emptyCart('cart_c1', 1, { device_id: 'dev_d' }), confirmed_at: '2026-07-16T00:00:00Z' };
    const alsoConfirmed = { ...emptyCart('cart_c2', 1, { device_id: 'dev_d' }), confirmed_at: '2026-07-16T00:01:00Z' };
    const unconfirmed = emptyCart('cart_open', 1, { device_id: 'dev_d' });
    await repo.commitCreated(confirmed);
    await repo.commitCreated(alsoConfirmed);
    await repo.commitCreated(unconfirmed);
    await repo.commitCreated(emptyCart('cart_other', 1, { device_id: 'dev_x' }));

    const orders = await repo.getOrdersByDevice('dev_d');

    expect(orders.map((c) => c.cart_id).sort()).toEqual(['cart_c1', 'cart_c2']);
  });

  it('getOrdersByDevice returns an empty array for an unknown device', async () => {
    const repo = new InMemoryCartRepository(new InMemoryCartCache());
    expect(await repo.getOrdersByDevice('dev_none')).toEqual([]);
  });
});

/** Fake ioredis capturing the EVAL writes, sets and EX TTLs — the surface RedisCartRepository uses. */
class FakeRedis {
  readonly store = new Map<string, string>();
  readonly sets = new Map<string, Set<string>>();
  readonly ttl = new Map<string, number>();

  async exists(key: string): Promise<number> {
    return this.store.has(key) ? 1 : 0;
  }

  async set(key: string, value: string, _ex?: string, seconds?: number): Promise<void> {
    this.write(key, value, seconds);
  }

  /** Mirrors COMMIT_CART_LUA, including its empty-KEY / 'skip'-ARGV opt-outs. */
  async eval(_script: string, _numKeys: number, ...args: string[]): Promise<void> {
    const [cartK, reqK, deviceK, tableK, cartVal, mark, seconds, cartId, indexSeconds] = args;
    this.write(cartK!, cartVal!);
    if (mark !== 'skip') this.write(reqK!, mark!, Number(seconds));
    for (const k of [deviceK, tableK]) {
      if (k === '') continue;
      let set = this.sets.get(k!);
      if (!set) {
        set = new Set();
        this.sets.set(k!, set);
      }
      set.add(cartId!);
      this.ttl.set(k!, Number(indexSeconds));
    }
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  async mget(keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => this.store.get(k) ?? null);
  }

  private write(key: string, value: string, seconds?: number): void {
    this.store.set(key, value);
    if (seconds !== undefined) this.ttl.set(key, seconds);
  }
}

/** Repo under test. The OdooClient throws: nothing here should reach Odoo. */
function makeRepo(ttl: number, indexTtl = 86_400): { repo: RedisCartRepository; redis: FakeRedis } {
  const redis = new FakeRedis();
  const odoo = {
    insertCart: async () => {
      throw new Error('odoo must not be called');
    },
    quote: async () => {
      throw new Error('odoo must not be called');
    },
  };
  return { repo: new RedisCartRepository(redis as unknown as Redis, ttl, odoo, indexTtl), redis };
}

describe('RedisCartRepository', () => {
  it('commitApplied writes the cart + ledger keys atomically with a TTL', async () => {
    const { repo, redis } = makeRepo(3600);
    const cart = emptyCart('cart_9', 1);
    cart.version = 2;

    await repo.commitApplied(cart, 'req_9');

    expect(redis.store.get('cart:cart_9')).toBe(JSON.stringify(cart));
    expect(redis.store.get('cart:req:req_9')).toBe('applied');
    expect(redis.ttl.get('cart:req:req_9')).toBe(3600);
    expect(await repo.wasProcessed('req_9')).toBe(true);
  });

  it('commitApplied lands the cart, ledger and BOTH indexes together', async () => {
    const { repo, redis } = makeRepo(3600, 60);
    const cart = emptyCart('cart_t', 1, { device_id: 'dev_a', table_id: 12 });

    await repo.commitApplied(cart, 'req_t');

    expect(redis.store.get('cart:cart_t')).toBe(JSON.stringify(cart));
    expect(redis.store.get('cart:req:req_t')).toBe('applied');
    expect(redis.sets.get('device:dev_a')).toEqual(new Set(['cart_t']));
    expect(redis.sets.get('table:12')).toEqual(new Set(['cart_t']));
    expect(redis.ttl.get('device:dev_a')).toBe(60);
    expect(redis.ttl.get('table:12')).toBe(60);
  });

  it('writes only the device index for a takeout cart (no table_id)', async () => {
    const { repo, redis } = makeRepo(3600, 60);

    await repo.commitCreated(emptyCart('cart_to', 1, { device_id: 'dev_b' }));

    expect(redis.sets.get('device:dev_b')).toEqual(new Set(['cart_to']));
    // No table key at all — an untabled order indexes nowhere by table.
    expect([...redis.sets.keys()]).toEqual(['device:dev_b']);
  });

  it('commitCreated writes the cart and index but marks no request', async () => {
    const { repo, redis } = makeRepo(3600, 60);
    const cart = emptyCart('cart_c', 1, { device_id: 'dev_c' });

    await repo.commitCreated(cart);

    expect(redis.store.get('cart:cart_c')).toBe(JSON.stringify(cart));
    expect(redis.sets.get('device:dev_c')).toEqual(new Set(['cart_c']));
    // The create path has no request_id; the 'skip' sentinel must leave the ledger alone.
    expect([...redis.store.keys()]).toEqual(['cart:cart_c']);
  });

  it('a device accumulates one cart per order in its index (Set, not overwrite)', async () => {
    const { repo, redis } = makeRepo(3600, 60);

    await repo.commitCreated(emptyCart('cart_1', 1, { device_id: 'dev_d' }));
    await repo.commitCreated(emptyCart('cart_2', 1, { device_id: 'dev_d' }));

    expect(redis.sets.get('device:dev_d')).toEqual(new Set(['cart_1', 'cart_2']));
  });

  it('getOrdersByDevice loads the device index and returns only confirmed carts', async () => {
    const { repo } = makeRepo(3600, 60);
    await repo.commitCreated({ ...emptyCart('cart_1', 1, { device_id: 'dev_d' }), confirmed_at: '2026-07-16T00:00:00Z' });
    await repo.commitCreated({ ...emptyCart('cart_2', 1, { device_id: 'dev_d' }), confirmed_at: '2026-07-16T00:01:00Z' });
    await repo.commitCreated(emptyCart('cart_open', 1, { device_id: 'dev_d' })); // never confirmed
    await repo.commitCreated({ ...emptyCart('cart_z', 1, { device_id: 'dev_z' }), confirmed_at: '2026-07-16T00:02:00Z' });

    const orders = await repo.getOrdersByDevice('dev_d');

    expect(orders.map((c) => c.cart_id).sort()).toEqual(['cart_1', 'cart_2']);
  });

  it('getOrdersByDevice drops a stale index member whose cart blob is gone', async () => {
    const { repo, redis } = makeRepo(3600, 60);
    await repo.commitCreated({ ...emptyCart('cart_live', 1, { device_id: 'dev_s' }), confirmed_at: '2026-07-16T00:00:00Z' });
    await repo.commitCreated({ ...emptyCart('cart_evicted', 1, { device_id: 'dev_s' }), confirmed_at: '2026-07-16T00:00:00Z' });
    redis.store.delete('cart:cart_evicted'); // blob expired/evicted, still in the device Set

    const orders = await repo.getOrdersByDevice('dev_s');

    expect(orders.map((c) => c.cart_id)).toEqual(['cart_live']);
  });

  it('getOrdersByDevice returns an empty array for an unknown device', async () => {
    const { repo } = makeRepo(3600, 60);
    expect(await repo.getOrdersByDevice('dev_none')).toEqual([]);
  });

  it('indexes nowhere when the cart has no identity (applyProposal fallback)', async () => {
    const { repo, redis } = makeRepo(3600, 60);

    // emptyCart with no identity — never `device:undefined`.
    await repo.commitApplied(emptyCart('cart_orphan', 1), 'req_o');

    expect(redis.store.get('cart:cart_orphan')).toBeDefined();
    expect(redis.sets.size).toBe(0);
  });

  it('confirmOrder maps the cart and hands it to Odoo, returning the pos_order_id', async () => {
    const redis = new FakeRedis();
    const seen: unknown[] = [];
    const odoo = {
      insertCart: async (req: unknown) => {
        seen.push(req);
        return 42;
      },
      quote: async () => {
        throw new Error('odoo.quote must not be called');
      },
    };
    const repo = new RedisCartRepository(redis as unknown as Redis, 3600, odoo, 60);
    const cart = emptyCart('cart_x', 7, { device_id: 'dev_x', table_id: 3 });

    expect(await repo.confirmOrder(cart)).toBe(42);
    expect(seen).toEqual([{ cart_id: 'cart_x', pos_config_id: 7, items: [], table_id: 3 }]);
  });

  it('quoteCart maps the cart and hands it to Odoo, returning the priced totals', async () => {
    const redis = new FakeRedis();
    const seen: unknown[] = [];
    const priced = {
      currency: 'CAD',
      decimal_places: 2,
      lines: [],
      amount_subtotal: 22.45,
      amount_tax: 1.13,
      amount_total: 23.58,
    };
    const odoo = {
      insertCart: async () => {
        throw new Error('odoo.insertCart must not be called');
      },
      quote: async (req: unknown) => {
        seen.push(req);
        return priced;
      },
    };
    const repo = new RedisCartRepository(redis as unknown as Redis, 3600, odoo, 60);
    const cart = emptyCart('cart_q', 7, { device_id: 'dev_q', table_id: 3 });
    cart.items = [
      { line_id: 'ln_1', product_tmpl_id: 100, names: {}, name: 'x', quantity: 2, modifiers: [{ ptav_id: 900, name: 'm' }], price_cents: 1000 },
    ];

    expect(await repo.quoteCart(cart)).toEqual(priced);
    // No cart_id / table_id (quote creates nothing); modifiers flattened to ptav_ids.
    expect(seen).toEqual([
      { pos_config_id: 7, items: [{ line_id: 'ln_1', product_tmpl_id: 100, quantity: 2, ptav_ids: [900] }] },
    ]);
  });

  it('markProcessed sets a TTL-bounded ledger key', async () => {
    const { repo, redis } = makeRepo(60);

    await repo.markProcessed('req_x', 'rejected');
    expect(redis.store.get('cart:req:req_x')).toBe('rejected');
    expect(redis.ttl.get('cart:req:req_x')).toBe(60);
  });

  it('wasProcessed is false for an unknown request', async () => {
    const { repo } = makeRepo(60);
    expect(await repo.wasProcessed('never')).toBe(false);
  });
});

/**
 * A FakeRedis whose EVAL rejects, standing in for a Lua script error (or Redis being
 * unreachable mid-commit). Because the whole call rejects, nothing is committed — the
 * atomicity MULTI/EXEC could not guarantee, since it does not roll back a per-command
 * failure (H4). The controller leaves the request un-marked, so the commit is retriable.
 */
class ThrowingEvalRedis {
  readonly store = new Map<string, string>();
  async exists(key: string): Promise<number> {
    return this.store.has(key) ? 1 : 0;
  }
  async set(): Promise<void> {}
  async eval(): Promise<never> {
    throw new Error('script error');
  }
}

describe('RedisCartRepository — EVAL failure handling', () => {
  it('commitApplied rejects and writes nothing when the script errors', async () => {
    const redis = new ThrowingEvalRedis();
    const odoo = {
      insertCart: async () => 0,
      quote: async () => {
        throw new Error('odoo.quote must not be called');
      },
    };
    const repo = new RedisCartRepository(redis as unknown as Redis, 3600, odoo, 86_400);
    await expect(repo.commitApplied(emptyCart('cart_h4', 1), 'req_h4')).rejects.toThrow();
    expect(redis.store.size).toBe(0);
  });
});
