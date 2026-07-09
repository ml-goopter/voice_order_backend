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

/**
 * A FakeRedis whose MULTI/EXEC reports a per-command failure the ioredis way: exec()
 * RESOLVES to an array of [error, reply] tuples rather than rejecting, and writes nothing.
 */
class PartialFailRedis {
  readonly store = new Map<string, string>();
  async exists(key: string): Promise<number> {
    return this.store.has(key) ? 1 : 0;
  }
  async set(): Promise<void> {}
  multi() {
    const chain = {
      set: () => chain,
      // First queued command "failed" (e.g. WRONGTYPE); nothing is committed.
      exec: async (): Promise<Array<[Error | null, unknown]>> => [
        [new Error('WRONGTYPE'), null],
        [null, 'OK'],
      ],
    };
    return chain;
  }
}

describe('RedisCartRepository — MULTI/EXEC failure handling', () => {
  it('KNOWN GAP (H4): a per-command EXEC error is ignored, so the write is silently lost', async () => {
    const redis = new PartialFailRedis();
    const repo = new RedisCartRepository(redis as unknown as Redis, 3600);
    // commitApplied never inspects exec()'s result (cart-repository.ts:56), so it resolves
    // as if all is well...
    await expect(repo.commitApplied(emptyCart('cart_h4', 1), 'req_h4')).resolves.toBeUndefined();
    // ...even though nothing was actually written.
    expect(redis.store.size).toBe(0);
  });

  // FAILING: commitApplied should detect the [error, _] tuple and throw so the controller
  // treats it as an infra failure (request left unmarked → retriable). Stays RED until fixed.
  it('commitApplied should reject when EXEC reports a per-command error', async () => {
    const repo = new RedisCartRepository(new PartialFailRedis() as unknown as Redis, 3600);
    await expect(repo.commitApplied(emptyCart('cart_h4b', 1), 'req_h4b')).rejects.toThrow();
  });
});
