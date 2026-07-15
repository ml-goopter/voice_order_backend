import { describe, it, expect } from 'vitest';
import { InMemoryMenuStore } from './in-memory-menu-store.js';
import { CandidateMatcher } from './candidate-matcher.js';
import { StubEmbeddingService } from './embedding-service.js';
import type { EmbeddingService } from './embedding-service.js';
import type { MenuItem } from './menu-types.js';
import { LIMITS } from '../config/constants.js';

const POS = 1;

function item(
  fields: Pick<MenuItem, 'product_tmpl_id' | 'menu_item_key' | 'names'> & Partial<MenuItem>,
): MenuItem {
  return { base_price_cents: 1000, available: true, modifiers: [], ...fields };
}

const MENU: MenuItem[] = [
  item({
    product_tmpl_id: 10,
    menu_item_key: 'chicken_burger',
    names: { en_US: 'Chicken Burger' },
    modifiers: [{ modifier_key: 'no_mayo', ptav_id: 1, name: 'No mayo', price_extra_cents: 0 }],
  }),
  item({ product_tmpl_id: 11, menu_item_key: 'caesar_salad', names: { en_US: 'Caesar Salad' } }),
  item({ product_tmpl_id: 12, menu_item_key: 'coke', names: { en_US: 'Coke' } }),
  item({
    product_tmpl_id: 13,
    menu_item_key: 'fried_rice',
    names: { en_US: 'Chicken Fried Rice', zh_CN: '鸡肉炒饭' },
  }),
  item({
    product_tmpl_id: 14,
    menu_item_key: 'sold_out_pizza',
    names: { en_US: 'Pepperoni Pizza' },
    available: false,
  }),
];

async function matcherWith(embedder: EmbeddingService, menu: MenuItem[] = MENU) {
  const store = new InMemoryMenuStore();
  await store.load(POS, menu, embedder);
  return new CandidateMatcher(store, embedder);
}

/**
 * Deterministic embedder: each concept is a list of surface forms across
 * languages; a text's vector marks which concepts it mentions. Same concept in
 * any language → same vector, so cross-language matching works.
 */
function conceptEmbedder(concepts: string[][]): EmbeddingService {
  const embed = async (text: string): Promise<number[]> => {
    const t = text.toLowerCase();
    return concepts.map((surfaces) => (surfaces.some((s) => t.includes(s.toLowerCase())) ? 1 : 0));
  };
  return {
    model: 'fake',
    dimensions: concepts.length,
    embed,
    embedBatch: (texts: string[]) => Promise.all(texts.map((t) => embed(t))),
  };
}

describe('CandidateMatcher — fuzzy/modifier signals (stub embedder)', () => {
  it('splits a multi-item transcript and surfaces each item', async () => {
    const m = await matcherWith(new StubEmbeddingService());
    const { items } = await m.match(POS, 'I want a chicken burger and a coke');
    const keys = items.map((i) => i.menu_item_key);
    expect(keys).toContain('chicken_burger');
    expect(keys).toContain('coke');
  });

  it('excludes unavailable items', async () => {
    const m = await matcherWith(new StubEmbeddingService());
    const { items } = await m.match(POS, 'pepperoni pizza');
    expect(items.map((i) => i.menu_item_key)).not.toContain('sold_out_pizza');
  });

  it('surfaces an item whose modifier is referenced, carrying its modifiers', async () => {
    const m = await matcherWith(new StubEmbeddingService());
    const { items } = await m.match(POS, 'chicken burger no mayo');
    const cb = items.find((i) => i.menu_item_key === 'chicken_burger');
    expect(cb).toBeDefined();
    expect(cb?.available_modifiers.map((x) => x.modifier_key)).toContain('no_mayo');
  });

  it('cannot match a cross-language synonym with no embeddings (fuzzy only)', async () => {
    // French for the fried-rice item, sharing no characters with its stored names.
    const m = await matcherWith(new StubEmbeddingService());
    const { items } = await m.match(POS, 'riz au poulet');
    expect(items.map((i) => i.menu_item_key)).not.toContain('fried_rice');
  });

  it('caps the candidate set at LIMITS.maxCandidatesToLlm', async () => {
    const many = Array.from({ length: LIMITS.maxCandidatesToLlm + 4 }, (_, i) =>
      item({ product_tmpl_id: 100 + i, menu_item_key: `combo_${i}`, names: { en_US: `Combo ${i}` } }),
    );
    const m = await matcherWith(new StubEmbeddingService(), many);
    const { items } = await m.match(POS, 'combo');
    expect(items.length).toBe(LIMITS.maxCandidatesToLlm);
  });
});

describe('CandidateMatcher — embedding signal', () => {
  it('matches a cross-language synonym via embedding similarity (design §7/§15)', async () => {
    // Same French query that fuzzy alone cannot match now surfaces the item,
    // because the embedder knows 'riz au poulet' ≈ 'Chicken Fried Rice' / '鸡肉炒饭'.
    const embedder = conceptEmbedder([
      ['鸡肉炒饭', 'chicken fried rice', 'riz au poulet'],
      ['coke', 'coca'],
    ]);
    const m = await matcherWith(embedder);
    const { items } = await m.match(POS, 'riz au poulet');
    expect(items.map((i) => i.menu_item_key)).toContain('fried_rice');
  });
});
