import { describe, it, expect, vi, afterEach } from 'vitest';
import { toMentionedItem, resolveMentionedItems } from './mentioned-items.js';
import type { CandidateItem } from '../menu/menu-types.js';
import type { MentionedItem } from '../contracts/mentioned-item.js';
import { logger } from '../config/logger.js';
import { LIMITS } from '../config/constants.js';

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
  it('keeps only the contract fields, omitting popularity when the candidate has none', () => {
    const result = toMentionedItem(candidate());

    expect(result).toEqual({
      menu_item_key: 'chicken_burger',
      product_tmpl_id: 10,
      name: 'Chicken Burger',
      names: { en_US: 'Chicken Burger' },
      base_price_cents: 1000,
    });
    expect('popularity' in result).toBe(false);
  });

  it('carries every translation the menu holds, not just the display one', () => {
    const names = { en_US: 'Chicken Burger', zh_CN: '鸡肉汉堡' };

    expect(toMentionedItem(candidate({ names })).names).toEqual(names);
  });

  // `names` is `{}` for an item the menu carries no translation for. `name` is the fallback, so the
  // map is left off entirely rather than shipped empty.
  it('omits names when the menu carries no translations, leaving name as the fallback', () => {
    const result = toMentionedItem(candidate({ names: {}, name: 'Chicken Burger' }));

    expect('names' in result).toBe(false);
    expect(result.name).toBe('Chicken Burger');
  });

  it('carries popularity when the candidate has one', () => {
    const result = toMentionedItem(candidate({ popularity: 'top' }));

    expect(result).toEqual({
      menu_item_key: 'chicken_burger',
      product_tmpl_id: 10,
      name: 'Chicken Burger',
      names: { en_US: 'Chicken Burger' },
      base_price_cents: 1000,
      popularity: 'top',
    });
  });
});

const item = (menu_item_key: string): MentionedItem => ({
  menu_item_key,
  product_tmpl_id: 1,
  name: menu_item_key,
  base_price_cents: 100,
});

const ctx = { request_id: 'req_1', cart_id: 'cart_1' };

describe('resolveMentionedItems', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns nothing for empty input', () => {
    expect(resolveMentionedItems([], {}, ctx)).toEqual([]);
  });

  it('dedupes while preserving first-mention order', () => {
    const known = { burger: item('burger'), coke: item('coke') };

    const result = resolveMentionedItems(['coke', 'burger', 'coke'], known, ctx);

    expect(result).toEqual([item('coke'), item('burger')]);
  });

  it('drops a key absent from the known map, reporting the turn\'s losses in one line', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const known = { burger: item('burger') };

    const result = resolveMentionedItems(['burger', 'ghost'], known, ctx);

    expect(result).toEqual([item('burger')]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('order.mentioned_items_dropped', {
      declared: 2,
      resolved: 1,
      unresolved_count: 1,
      unresolved: ['ghost'],
      request_id: 'req_1',
      cart_id: 'cart_1',
    });
  });

  it('says nothing when every declared key resolved', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    resolveMentionedItems(['burger', 'burger'], { burger: item('burger') }, ctx);

    expect(warn).not.toHaveBeenCalled();
  });

  // The list is model-controlled: a model that dumps its scratchpad must cost one log line, not one
  // per key, and the count must still distinguish "it named 40" from "it named 8".
  it('logs once for a flood of unknown keys, keeping the full declared count', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const keys = Array.from({ length: 40 }, (_, i) => `ghost_${i}`);

    expect(resolveMentionedItems(keys, {}, ctx)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ declared: 40, resolved: 0, unresolved_count: 40 });
    expect((warn.mock.calls[0]?.[1] as { unresolved: string[] }).unresolved).toHaveLength(
      LIMITS.maxMentionedItems,
    );
  });

  it('caps the result at LIMITS.maxMentionedItems', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const keys = Array.from({ length: LIMITS.maxMentionedItems + 5 }, (_, i) => `item_${i}`);
    const known: Record<string, MentionedItem> = {};
    for (const key of keys) known[key] = item(key);

    const result = resolveMentionedItems(keys, known, ctx);

    expect(result).toHaveLength(LIMITS.maxMentionedItems);
    expect(result).toEqual(keys.slice(0, LIMITS.maxMentionedItems).map(item));
    // Truncation is a loss too — it must not look like a clean turn.
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      declared: LIMITS.maxMentionedItems + 5,
      resolved: LIMITS.maxMentionedItems,
      unresolved_count: 0,
    });
  });
});
