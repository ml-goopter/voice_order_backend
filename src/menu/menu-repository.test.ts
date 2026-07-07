import { describe, it, expect } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisMenuRepository, toMenuItem, toCandidateModifier } from './menu-repository.js';

/** Fake ioredis exposing only scan/smembers/mget over a plain key map. */
class FakeRedis {
  constructor(private readonly store: Map<string, string>, private readonly sets: Map<string, string[]>) {}

  async scan(cursor: string, _m: string, pattern: string, _c: string, _n: number): Promise<[string, string[]]> {
    const prefix = pattern.replace(/\*$/, '');
    const keys = [...this.store.keys(), ...this.sets.keys()].filter((k) => k.startsWith(prefix));
    return ['0', keys];
  }
  async smembers(key: string): Promise<string[]> {
    return this.sets.get(key) ?? [];
  }
  async mget(keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => this.store.get(k) ?? null);
  }
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
    { text: '', vector: [] }, // empty vectors are dropped
  ],
};

function makeRepo(record: unknown = RECORD): RedisMenuRepository {
  const store = new Map<string, string>([
    ['menu:item:1:42', JSON.stringify(record)],
    ['menu:meta:1', '{}'],
    ['menu:meta:2', '{}'],
  ]);
  const sets = new Map<string, string[]>([['menu:items:1', ['42']]]);
  return new RedisMenuRepository(new FakeRedis(store, sets) as unknown as Redis);
}

describe('menu record mapping', () => {
  it('maps a stored record to a runtime MenuItem', () => {
    expect(toMenuItem(RECORD)).toEqual({
      product_tmpl_id: 42,
      menu_item_key: 'chicken_burger',
      names: { en_US: 'Chicken Burger', zh_CN: '鸡肉汉堡' },
      base_price_cents: 1299,
      available: true,
      modifiers: [{ modifier_key: '5', ptav_id: 5, name: 'Large' }],
    });
  });

  it('picks en_US modifier name, falling back to first then attribute', () => {
    expect(toCandidateModifier({ ptav_id: 1, modifier_key: '1', attribute: 'size', names: {}, price_extra_cents: 0 }).name).toBe('size');
    expect(toCandidateModifier({ ptav_id: 1, modifier_key: '1', attribute: 'size', names: { zh_CN: '大' }, price_extra_cents: 0 }).name).toBe('大');
  });
});

describe('RedisMenuRepository', () => {
  it('loads items with non-empty vectors', async () => {
    const indexed = await makeRepo().load(1);
    expect(indexed).toHaveLength(1);
    expect(indexed[0]!.item.menu_item_key).toBe('chicken_burger');
    expect(indexed[0]!.vectors).toEqual([{ text: 'Chicken Burger', vector: [0.1, 0.2] }]);
  });

  it('returns [] for a pos with no items', async () => {
    expect(await makeRepo().load(999)).toEqual([]);
  });

  it('discovers pos_config_ids from menu:meta keys', async () => {
    expect((await makeRepo().listPosConfigIds()).sort()).toEqual([1, 2]);
  });
});
