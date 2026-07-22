import { describe, it, expect } from 'vitest';
import { toMentionedItem } from './mentioned-items.js';
import type { CandidateItem } from '../menu/menu-types.js';

const candidate = (over: Partial<CandidateItem> = {}): CandidateItem => ({
  menu_item_key: 'chicken_burger',
  product_tmpl_id: 10,
  name: 'Chicken Burger',
  names: { en_US: 'Chicken Burger' },
  matched_text: 'chicken burger',
  score: 0.9,
  base_price_cents: 1000,
  available_modifiers: [{ modifier_key: 'no_mayo', ptav_id: 1, name: 'No mayo', price_extra_cents: 0 }],
  ...over,
});

describe('toMentionedItem', () => {
  it('keeps only the five contract fields, omitting popularity when the candidate has none', () => {
    const result = toMentionedItem(candidate());

    expect(result).toEqual({
      menu_item_key: 'chicken_burger',
      product_tmpl_id: 10,
      name: 'Chicken Burger',
      base_price_cents: 1000,
    });
    expect('popularity' in result).toBe(false);
  });

  it('carries popularity when the candidate has one', () => {
    const result = toMentionedItem(candidate({ popularity: 'top' }));

    expect(result).toEqual({
      menu_item_key: 'chicken_burger',
      product_tmpl_id: 10,
      name: 'Chicken Burger',
      base_price_cents: 1000,
      popularity: 'top',
    });
  });
});
