import { describe, it, expect } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisMenuStore, toMenuItem, toCandidateModifier } from './menu-store.js';

/** Fake ioredis exposing only the read commands RedisMenuStore uses. */
class FakeRedis {
  /** Canned FT.SEARCH replies, one per `call()` invocation (queue). */
  callReplies: unknown[][] = [];
  callCount = 0;
  /** Args of each `call()`, for asserting the FT.SEARCH request we build. */
  calls: unknown[][] = [];

  constructor(private readonly store: Map<string, string>, private readonly sets: Map<string, string[]>) {}

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async smembers(key: string): Promise<string[]> {
    return this.sets.get(key) ?? [];
  }
  async mget(keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => this.store.get(k) ?? null);
  }
  async call(...args: unknown[]): Promise<unknown> {
    this.calls.push(args);
    return this.callReplies[this.callCount++] ?? [0];
  }
}

/** Build an FT.SEARCH reply: [total, docId, [f, v, ...], ...] for the given hits. */
function ftReply(hits: Array<{ tmpl: number; dist: number }>): unknown[] {
  const out: unknown[] = [hits.length];
  for (const h of hits) {
    out.push(`menu:vec:1:${h.tmpl}:0`, ['tmpl', String(h.tmpl), 'vec_score', String(h.dist)]);
  }
  return out;
}

const RECORD = {
  product_tmpl_id: 42,
  menu_item_key: 'chicken_burger',
  names: { en_US: 'Chicken Burger', zh_CN: '鸡肉汉堡' },
  base_price_cents: 1299,
  available: true,
  modifiers: [
    { ptav_id: 5, modifier_key: '5', attribute: 'size', names: { en_US: 'Large' }, price_extra_cents: 100 },
  ],
  vectors: [
    { text: 'Chicken Burger', vector: [0.1, 0.2] },
    { text: '', vector: [] },
  ],
};

function makeStore(record: unknown = RECORD): RedisMenuStore {
  const store = new Map<string, string>([
    ['menu:item:1:42', JSON.stringify(record)],
    ['menu:key:1:chicken_burger', '42'],
    ['menu:meta:1', '{}'],
  ]);
  const sets = new Map<string, string[]>([['menu:items:1', ['42']]]);
  return new RedisMenuStore(new FakeRedis(store, sets) as unknown as Redis);
}

describe('menu record mapping', () => {
  it('maps a stored record to a runtime MenuItem', () => {
    expect(toMenuItem(RECORD)).toEqual({
      product_tmpl_id: 42,
      menu_item_key: 'chicken_burger',
      names: { en_US: 'Chicken Burger', zh_CN: '鸡肉汉堡' },
      base_price_cents: 1299,
      available: true,
      modifiers: [{ modifier_key: '5', ptav_id: 5, name: 'Large', names: { en_US: 'Large' } }],
    });
  });

  it('picks en_US modifier name, falling back to first then attribute', () => {
    expect(toCandidateModifier({ ptav_id: 1, modifier_key: '1', attribute: 'size', names: {}, price_extra_cents: 0 }).name).toBe('size');
    expect(toCandidateModifier({ ptav_id: 1, modifier_key: '1', attribute: 'size', names: { zh_CN: '大' }, price_extra_cents: 0 }).name).toBe('大');
  });
});

describe('RedisMenuStore reads', () => {
  it('gets an item by product_tmpl_id', async () => {
    const item = await makeStore().getItem(1, 42);
    expect(item?.menu_item_key).toBe('chicken_burger');
  });

  it('returns undefined for a missing item', async () => {
    expect(await makeStore().getItem(1, 999)).toBeUndefined();
  });

  it('resolves a menu_item_key via the secondary index', async () => {
    const item = await makeStore().getItemByKey(1, 'chicken_burger');
    expect(item?.product_tmpl_id).toBe(42);
  });

  it('falls back to scanning items when the key index is absent', async () => {
    const store = new Map<string, string>([['menu:item:1:42', JSON.stringify(RECORD)]]);
    const sets = new Map<string, string[]>([['menu:items:1', ['42']]]);
    const repo = new RedisMenuStore(new FakeRedis(store, sets) as unknown as Redis);
    const item = await repo.getItemByKey(1, 'chicken_burger');
    expect(item?.product_tmpl_id).toBe(42);
  });

  it('loads all items for a pos', async () => {
    const items = await makeStore().allItems(1);
    expect(items.map((i) => i.menu_item_key)).toEqual(['chicken_burger']);
  });

  it('returns [] for a pos with no items', async () => {
    expect(await makeStore().allItems(999)).toEqual([]);
  });
});

describe('RedisMenuStore.knnSearch', () => {
  it('parses FT.SEARCH hits into similarity (1 - distance), best per item across queries', async () => {
    const redis = new FakeRedis(new Map(), new Map());
    // One call per non-empty query vector, in order.
    redis.callReplies = [
      ftReply([{ tmpl: 10, dist: 0.2 }, { tmpl: 12, dist: 0.4 }]), // sims .8 / .6
      ftReply([{ tmpl: 10, dist: 0.05 }]), // sim .95 → beats .8 for item 10
    ];
    const store = new RedisMenuStore(redis as unknown as Redis, 4);

    const sims = await store.knnSearch(1, [[1, 0, 0, 0], [0, 1, 0, 0]], 10);
    expect(redis.callCount).toBe(2);
    expect(sims.get(10)).toBeCloseTo(0.95, 5);
    expect(sims.get(12)).toBeCloseTo(0.6, 5);
  });

  it('skips empty query vectors (no FT.SEARCH call) and returns an empty map', async () => {
    const redis = new FakeRedis(new Map(), new Map());
    const store = new RedisMenuStore(redis as unknown as Redis, 4);
    const sims = await store.knnSearch(1, [[]], 10);
    expect(redis.callCount).toBe(0);
    expect(sims.size).toBe(0);
  });

  it('clamps a >1 COSINE distance to similarity 0 (never negative)', async () => {
    const redis = new FakeRedis(new Map(), new Map());
    redis.callReplies = [ftReply([{ tmpl: 7, dist: 1.5 }])];
    const store = new RedisMenuStore(redis as unknown as Redis, 4);
    const sims = await store.knnSearch(1, [[1, 0, 0, 0]], 10);
    expect(sims.get(7)).toBe(0);
  });

  it('filters by pos but NOT by availability (rechecked from the live blob)', async () => {
    const redis = new FakeRedis(new Map(), new Map());
    const store = new RedisMenuStore(redis as unknown as Redis, 4);
    await store.knnSearch(3, [[1, 0, 0, 0]], 10);
    const query = String(redis.calls[0]?.[2]);
    expect(query).toContain('@pos:{3}');
    expect(query).not.toContain('available');
  });

  it('returns an empty map when FT.SEARCH errors (→ matcher falls back to fuzzy)', async () => {
    const redis = new FakeRedis(new Map(), new Map());
    redis.call = async () => {
      throw new Error('idx:menuvec: no such index');
    };
    const store = new RedisMenuStore(redis as unknown as Redis, 4);
    const sims = await store.knnSearch(1, [[1, 0, 0, 0]], 10);
    expect(sims.size).toBe(0);
  });
});

describe('RedisMenuStore.lexicalSearch', () => {
  it('queries @name for phrase words and collects distinct tmpls', async () => {
    const redis = new FakeRedis(new Map(), new Map());
    redis.callReplies = [ftReply([{ tmpl: 10, dist: 0 }, { tmpl: 12, dist: 0 }])];
    const store = new RedisMenuStore(redis as unknown as Redis, 4);
    const ids = await store.lexicalSearch(1, ['chicken burger']);
    expect(redis.callCount).toBe(1);
    const query = String(redis.calls[0]?.[2]);
    expect(query).toContain('@pos:{1}');
    expect(query).toContain('@name:');
    expect([...ids].sort()).toEqual([10, 12]);
  });

  it('makes no request and returns an empty set when no usable term remains', async () => {
    const redis = new FakeRedis(new Map(), new Map());
    const store = new RedisMenuStore(redis as unknown as Redis, 4);
    const ids = await store.lexicalSearch(1, ['a', '!']);
    expect(redis.callCount).toBe(0);
    expect(ids.size).toBe(0);
  });

  it('returns an empty set when FT.SEARCH errors', async () => {
    const redis = new FakeRedis(new Map(), new Map());
    redis.call = async () => {
      throw new Error('no such index');
    };
    const store = new RedisMenuStore(redis as unknown as Redis, 4);
    expect((await store.lexicalSearch(1, ['burger'])).size).toBe(0);
  });
});
