import { describe, it, expect } from 'vitest';
import type pg from 'pg';
import { PostgresMenuStore, encodeVector, lexicalTerms } from './postgres-menu-store.js';

type Rows = Record<string, unknown>[];

/**
 * Fake pg.Pool: routes each `query()` by the SQL it recognises and returns canned
 * rows. KNN pulls from a per-call queue (one query per phrase vector); everything
 * else returns a fixed set. `throwKnn` simulates a missing pgvector extension.
 */
class FakePool {
  knnQueue: Rows[] = [];
  lexRows: Rows = [];
  itemRows: Rows = [];
  modRows: Rows = [];
  keyRows: Rows = [];
  throwKnn = false;
  calls: Array<{ sql: string; params: unknown[] }> = [];

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Rows }> {
    this.calls.push({ sql, params });
    if (/1 - \(vector <=>/.test(sql)) {
      if (this.throwKnn) throw new Error('operator does not exist: vector <=> vector');
      return { rows: this.knnQueue.shift() ?? [] };
    }
    if (/ILIKE ANY/.test(sql)) return { rows: this.lexRows };
    if (/DISTINCT ON/.test(sql)) return { rows: this.itemRows };
    if (/product_template_attribute_value/.test(sql)) return { rows: this.modRows };
    if (/SELECT product_tmpl_id FROM item_vector/.test(sql)) return { rows: this.keyRows };
    return { rows: [] }; // DDL etc.
  }
}

function makeStore(pool: FakePool, dims = 2): PostgresMenuStore {
  return new PostgresMenuStore(pool as unknown as pg.Pool, dims);
}

describe('encodeVector / lexicalTerms', () => {
  it('encodes a vector as a pgvector literal', () => {
    expect(encodeVector([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]');
  });

  it('builds %word% ILIKE terms, dropping metacharacters and short words', () => {
    expect(lexicalTerms(['chicken burger', 'a', 'no-onions']).sort()).toEqual(
      ['%burger%', '%chicken%', '%noonions%'].sort(),
    );
    expect(lexicalTerms([' ', '!'])).toEqual([]);
  });
});

describe('PostgresMenuStore.knnSearch', () => {
  it('keeps the best cosine per distinct item across phrases, top-k, clamped', async () => {
    const pool = new FakePool();
    // Two phrase vectors → two queued replies. Item 42 appears in both; keep the best.
    pool.knnQueue = [
      [
        { product_tmpl_id: 42, sim: '0.7' },
        { product_tmpl_id: 7, sim: '1.4' }, // >1 → clamped to 1
      ],
      [{ product_tmpl_id: 42, sim: '0.9' }],
    ];
    const best = await makeStore(pool).knnSearch(1, [[0.1, 0.2], [0.3, 0.4]], 5);
    expect(best.get(42)).toBe(0.9);
    expect(best.get(7)).toBe(1);
  });

  it('trims to the k nearest', async () => {
    const pool = new FakePool();
    pool.knnQueue = [[
      { product_tmpl_id: 1, sim: '0.9' },
      { product_tmpl_id: 2, sim: '0.8' },
      { product_tmpl_id: 3, sim: '0.7' },
    ]];
    const best = await makeStore(pool).knnSearch(1, [[0.1, 0.2]], 2);
    expect([...best.keys()].sort()).toEqual([1, 2]);
  });

  it('degrades to an empty map when the query errors (no pgvector)', async () => {
    const pool = new FakePool();
    pool.throwKnn = true;
    const best = await makeStore(pool).knnSearch(1, [[0.1, 0.2]], 5);
    expect(best.size).toBe(0);
  });
});

describe('PostgresMenuStore hydration (JOIN to Odoo)', () => {
  const itemRow = {
    product_tmpl_id: 42,
    menu_item_key: 'chicken_burger',
    names: { en_US: 'Chicken Burger', zh_CN: '鸡肉汉堡' },
    list_price: '12.99',
    available: true,
  };
  const modRow = {
    product_tmpl_id: 42,
    ptav_id: 5,
    price_extra: '1.50',
    names: { en_US: 'Large' },
    attr_name: { en_US: 'Size' },
    attribute_line_id: 7,
    display_type: 'multi',
  };

  it('maps a joined item + modifier to a runtime MenuItem', async () => {
    const pool = new FakePool();
    pool.itemRows = [itemRow];
    pool.modRows = [modRow];
    const item = await makeStore(pool).getItem(1, 42);
    expect(item).toEqual({
      product_tmpl_id: 42,
      menu_item_key: 'chicken_burger',
      names: { en_US: 'Chicken Burger', zh_CN: '鸡肉汉堡' },
      base_price_cents: 1299, // list_price 12.99 → cents
      available: true,
      modifiers: [
        // price_extra 1.50 → cents, mirroring base_price_cents.
        // display_type 'multi' ⇒ optional ⇒ NO group fields at all (absent means optional), so an
        // all-multi tenant's payload is unchanged by the required-group feature.
        { modifier_key: '5', ptav_id: 5, price_extra_cents: 150, name: 'Large', names: { en_US: 'Large' } },
      ],
    });
  });

  // Requiredness is inferred from display_type alone (docs/pos-product-modifier-order-schema.md
  // §Required modifiers): anything that is not 'multi' is a pick-exactly-one group. Optional
  // groups carry no group fields at all, so `required` is `true` or absent — never `false`.
  it.each([
    ['radio', true],
    ['pills', true],
    ['select', true],
    ['multi', undefined],
  ])('maps display_type %s to required=%s', async (display_type, required) => {
    const pool = new FakePool();
    pool.itemRows = [itemRow];
    pool.modRows = [{ ...modRow, display_type }];
    const item = await makeStore(pool).getItem(1, 42);
    expect(item?.modifiers[0]?.required).toBe(required);
  });

  it('carries group_key/group_name only on a required group', async () => {
    const pool = new FakePool();
    pool.itemRows = [itemRow];
    pool.modRows = [{ ...modRow, display_type: 'radio' }];
    const item = await makeStore(pool).getItem(1, 42);
    expect(item?.modifiers[0]).toMatchObject({ group_key: '7', group_name: 'Size', required: true });
  });

  // Degrade OPEN in every direction: requiredness inferred from missing or archived data would
  // make the item unorderable. An ungrouped option can never join a required group, so it never
  // blocks. `attr_active: false` is the live jadegarden1 "Sides" case (an archived attribute).
  it.each([
    ['a null display_type', { display_type: null }],
    ['a null attribute_line_id', { attribute_line_id: null }],
    ['an archived attribute', { display_type: 'radio', attr_active: false }],
  ])('treats %s as ungrouped and NOT required', async (_label, overrides) => {
    const pool = new FakePool();
    pool.itemRows = [itemRow];
    pool.modRows = [{ ...modRow, display_type: 'radio', ...overrides }];
    const item = await makeStore(pool).getItem(1, 42);
    expect(item?.modifiers[0]?.required).toBeUndefined();
    expect(item?.modifiers[0]?.group_key).toBeUndefined();
  });

  it('maps a null price_extra to a zero surcharge', async () => {
    const pool = new FakePool();
    pool.itemRows = [itemRow];
    pool.modRows = [{ ...modRow, price_extra: null }];
    const item = await makeStore(pool).getItem(1, 42);
    expect(item?.modifiers[0]?.price_extra_cents).toBe(0);
  });

  it('resolves a menu_item_key to its item', async () => {
    const pool = new FakePool();
    pool.keyRows = [{ product_tmpl_id: 42 }];
    pool.itemRows = [itemRow];
    pool.modRows = [];
    const item = await makeStore(pool).getItemByKey(1, 'chicken_burger');
    expect(item?.product_tmpl_id).toBe(42);
    expect(item?.modifiers).toEqual([]);
  });

  it('returns undefined for an unknown key', async () => {
    const pool = new FakePool();
    pool.keyRows = [];
    expect(await makeStore(pool).getItemByKey(1, 'nope')).toBeUndefined();
  });

  it('falls back to the attribute name when a modifier value has no name', async () => {
    const pool = new FakePool();
    pool.itemRows = [itemRow];
    pool.modRows = [{ product_tmpl_id: 42, ptav_id: 9, price_extra: '0', names: {}, attr_name: { en_US: 'Spice' } }];
    const item = await makeStore(pool).getItem(1, 42);
    expect(item?.modifiers[0]?.name).toBe('Spice');
    // The all-language map falls back to the attribute's names too.
    expect(item?.modifiers[0]?.names).toEqual({ en_US: 'Spice' });
  });

  it('getItems short-circuits on an empty id list (no query)', async () => {
    const pool = new FakePool();
    expect(await makeStore(pool).getItems(1, [])).toEqual([]);
    expect(pool.calls).toHaveLength(0);
  });
});

describe('PostgresMenuStore.lexicalSearch', () => {
  it('returns the distinct matched ids', async () => {
    const pool = new FakePool();
    pool.lexRows = [{ product_tmpl_id: 1 }, { product_tmpl_id: 2 }];
    const ids = await makeStore(pool).lexicalSearch(1, ['burger']);
    expect([...ids].sort()).toEqual([1, 2]);
  });

  it('does no query when no usable term remains', async () => {
    const pool = new FakePool();
    const ids = await makeStore(pool).lexicalSearch(1, ['!', ' ']);
    expect(ids.size).toBe(0);
    expect(pool.calls).toHaveLength(0);
  });
});

describe('PostgresMenuStore.ensureIndex', () => {
  it('no-ops when dims <= 0 (stub embedder)', async () => {
    const pool = new FakePool();
    await makeStore(pool, 0).ensureIndex();
    expect(pool.calls).toHaveLength(0);
  });

  it('creates the extension, table, and indexes', async () => {
    const pool = new FakePool();
    await makeStore(pool, 1024).ensureIndex();
    const sql = pool.calls.map((c) => c.sql).join('\n');
    expect(sql).toMatch(/CREATE EXTENSION IF NOT EXISTS vector/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS item_vector/);
    expect(sql).toMatch(/vector\(1024\)/);
    expect(sql).toMatch(/USING hnsw/);
  });
});
