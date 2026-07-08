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
});

/** Fake ioredis capturing MULTI writes and EX TTLs — the surface RedisCartRepository uses. */
class FakeRedis {
  readonly store = new Map<string, string>();
  readonly ttl = new Map<string, number>();

  async exists(key: string): Promise<number> {
    return this.store.has(key) ? 1 : 0;
  }

  async set(key: string, value: string, _ex?: string, seconds?: number): Promise<void> {
    this.write(key, value, seconds);
  }

  multi() {
    const pending: Array<[string, string, number | undefined]> = [];
    const chain = {
      set: (key: string, value: string, _ex?: string, seconds?: number) => {
        pending.push([key, value, seconds]);
        return chain;
      },
      exec: async () => {
        for (const [key, value, seconds] of pending) this.write(key, value, seconds);
        return [];
      },
    };
    return chain;
  }

  private write(key: string, value: string, seconds?: number): void {
    this.store.set(key, value);
    if (seconds !== undefined) this.ttl.set(key, seconds);
  }
}

function makeRepo(ttl: number): { repo: RedisCartRepository; redis: FakeRedis } {
  const redis = new FakeRedis();
  return { repo: new RedisCartRepository(redis as unknown as Redis, ttl), redis };
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
