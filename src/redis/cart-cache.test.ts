import { describe, it, expect } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisCartCache } from './cart-cache.js';
import { emptyCart } from '../cart/cart-types.js';

/** Minimal in-memory stand-in for the ioredis methods RedisCartCache uses. */
class FakeRedis {
  readonly store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function makeCache(): { cache: RedisCartCache; redis: FakeRedis } {
  const redis = new FakeRedis();
  return { cache: new RedisCartCache(redis as unknown as Redis), redis };
}

describe('RedisCartCache', () => {
  it('round-trips a cart under cart:{cart_id}', async () => {
    const { cache, redis } = makeCache();
    const cart = emptyCart('cart_1', 7);
    cart.version = 3;

    await cache.set(cart);
    expect(redis.store.has('cart:cart_1')).toBe(true);
    expect(await cache.get('cart_1')).toEqual(cart);
  });

  it('returns undefined for a missing cart', async () => {
    const { cache } = makeCache();
    expect(await cache.get('nope')).toBeUndefined();
  });

  it('deletes a cart', async () => {
    const { cache } = makeCache();
    await cache.set(emptyCart('cart_2', 1));
    await cache.delete('cart_2');
    expect(await cache.get('cart_2')).toBeUndefined();
  });

  it('returns undefined (not throw) on corrupt JSON', async () => {
    const { cache, redis } = makeCache();
    redis.store.set('cart:bad', '{not json');
    expect(await cache.get('bad')).toBeUndefined();
  });

  it('propagates a transport error from redis.get — only corrupt JSON is swallowed', async () => {
    // Only JSON.parse is inside the try (cart-cache.ts:28-33); a thrown get (connection
    // drop) propagates uncaught, and the controller's own try/catch maps it to internal_error.
    const redis = {
      get: async (): Promise<string> => {
        throw new Error('connection reset');
      },
      set: async (): Promise<void> => {},
      del: async (): Promise<void> => {},
    };
    const cache = new RedisCartCache(redis as unknown as Redis);
    await expect(cache.get('cart_1')).rejects.toThrow('connection reset');
  });
});
