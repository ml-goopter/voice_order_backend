import { describe, it, expect } from 'vitest';
import { findRequiredModifierViolations } from './required-modifiers.js';
import type { CartOperation } from '../../contracts/cart-operation.schema.js';
import type { CartModifierView, CartView } from '../../contracts/cart-view.js';
import type { CandidateModifier, MenuItem } from '../../menu/menu-types.js';

/** A required (radio/pills) group: "Noodles" — pick exactly one of chow mein / rice noodles. */
const NOODLES: CandidateModifier[] = [
  { modifier_key: '10', ptav_id: 10, name: 'Chow Mein', price_extra_cents: 0, group_key: 'g1', group_name: 'Noodles', required: true },
  { modifier_key: '11', ptav_id: 11, name: 'Rice Noodles', price_extra_cents: 0, group_key: 'g1', group_name: 'Noodles', required: true },
];
/** An optional (multi) group: "add Vegetables". Optional options carry NO group fields at all —
 *  the store omits them, so absent means optional. */
const VEGGIES: CandidateModifier[] = [
  { modifier_key: '20', ptav_id: 20, name: 'Bok Choy', price_extra_cents: 150 },
  { modifier_key: '21', ptav_id: 21, name: 'Broccoli', price_extra_cents: 150 },
];
/** A second required group on the same item: "Spice". */
const SPICE: CandidateModifier[] = [
  { modifier_key: '30', ptav_id: 30, name: 'Mild', price_extra_cents: 0, group_key: 'g3', group_name: 'Spice', required: true },
  { modifier_key: '31', ptav_id: 31, name: 'Hot', price_extra_cents: 0, group_key: 'g3', group_name: 'Spice', required: true },
];

const item = (modifiers: CandidateModifier[], available = true): MenuItem => ({
  product_tmpl_id: 3413,
  menu_item_key: 'mushu_pork',
  names: { en_US: 'A11. Mushu Pork' },
  base_price_cents: 1500,
  available,
  modifiers,
});

const itemsByKey = (modifiers: CandidateModifier[]) => new Map([['mushu_pork', item(modifiers)]]);

const addItem = (...keys: string[]): CartOperation => ({
  action: 'add_item',
  menu_item_key: 'mushu_pork',
  quantity: 1,
  modifiers: keys.map((modifier_key) => ({ modifier_key })),
});

/** Project a menu modifier to its cart-view shape (mirrors load-cart's `toModifierView`). */
const toView = (m: CandidateModifier): CartModifierView => ({
  modifier_key: m.modifier_key,
  name: m.name,
  price_extra_cents: m.price_extra_cents,
  ...(m.group_key !== undefined ? { group_key: m.group_key } : {}),
  ...(m.group_name !== undefined ? { group_name: m.group_name } : {}),
  ...(m.required !== undefined ? { required: m.required } : {}),
});

/** A cart holding one line of the required-group item, currently set to Chow Mein. */
const cartView = (modifierKeys: string[] = ['10']): CartView => ({
  cart_id: 'cart_1',
  pos_config_id: 1,
  version: 1,
  items: [
    {
      line_id: 'L1',
      menu_item_key: 'mushu_pork',
      name: 'A11. Mushu Pork',
      quantity: 1,
      base_price_cents: 1500,
      modifiers: [...NOODLES, ...VEGGIES]
        .filter((m) => modifierKeys.includes(m.modifier_key))
        .map(toView),
      available_modifiers: [...NOODLES, ...VEGGIES].map(toView),
    },
  ],
});

describe('findRequiredModifierViolations — add_item', () => {
  it('rejects an add_item that selects nothing from a required group', () => {
    const v = findRequiredModifierViolations([addItem()], null, itemsByKey(NOODLES));

    expect(v).toHaveLength(1);
    expect(v[0]).toContain('Noodles');
    expect(v[0]).toContain('none was selected');
    // The message must carry the options so the agent can ask the question without re-searching.
    expect(v[0]).toContain('Chow Mein, Rice Noodles');
  });

  it('accepts an add_item selecting exactly one from the required group', () => {
    expect(findRequiredModifierViolations([addItem('10')], null, itemsByKey(NOODLES))).toEqual([]);
  });

  it('rejects two selections in one required group (exactly-one, not at-least-one)', () => {
    const v = findRequiredModifierViolations([addItem('10', '11')], null, itemsByKey(NOODLES));

    expect(v).toHaveLength(1);
    expect(v[0]).toContain('only one choice');
    expect(v[0]).toContain('2 were selected');
  });

  // The Izumi case: a tenant with only `multi` groups must be entirely unaffected.
  it('accepts an item whose groups are all optional, with nothing selected', () => {
    expect(findRequiredModifierViolations([addItem()], null, itemsByKey(VEGGIES))).toEqual([]);
  });

  it('allows several picks in an OPTIONAL group while requiring one in the required group', () => {
    const all = [...NOODLES, ...VEGGIES];
    expect(findRequiredModifierViolations([addItem('10', '20', '21')], null, itemsByKey(all))).toEqual([]);
  });

  // Degrade: a menu miss must never block an order.
  it('skips an add_item whose item did not resolve', () => {
    expect(findRequiredModifierViolations([addItem()], null, new Map())).toEqual([]);
  });

  it('ignores a modifier_key that is not on the item when counting groups', () => {
    const v = findRequiredModifierViolations([addItem('999')], null, itemsByKey(NOODLES));
    expect(v[0]).toContain('none was selected');
  });

  it('reports BOTH unsatisfied groups when an item has two required groups', () => {
    const v = findRequiredModifierViolations([addItem()], null, itemsByKey([...NOODLES, ...SPICE]));

    expect(v).toHaveLength(2);
    expect(v.some((m) => m.includes('Noodles'))).toBe(true);
    expect(v.some((m) => m.includes('Spice'))).toBe(true);
  });

  it('reports only the unsatisfied group when the other is answered', () => {
    const v = findRequiredModifierViolations([addItem('10')], null, itemsByKey([...NOODLES, ...SPICE]));

    expect(v).toHaveLength(1);
    expect(v[0]).toContain('Spice');
  });

  // An unavailable item is the cart's refusal to make; asking about noodles first wastes a turn.
  it('skips the check for an unavailable item', () => {
    const byKey = new Map([['mushu_pork', item(NOODLES, false)]]);

    expect(findRequiredModifierViolations([addItem()], null, byKey)).toEqual([]);
  });

  it('emits one message, not two, for two identical failing add_item ops', () => {
    const v = findRequiredModifierViolations([addItem(), addItem()], null, itemsByKey(NOODLES));

    expect(v).toHaveLength(1);
  });
});

describe('findRequiredModifierViolations — edits to an existing line', () => {
  it('rejects a remove_modifier that empties a required group', () => {
    const ops: CartOperation[] = [{ action: 'remove_modifier', line_id: 'L1', modifier_key: '10' }];

    const v = findRequiredModifierViolations(ops, cartView(['10']), new Map());

    expect(v).toHaveLength(1);
    expect(v[0]).toContain('Noodles');
    expect(v[0]).toContain('none was selected');
  });

  // The swap: remove + add in ONE batch nets to exactly one. Validating op-by-op would have
  // rejected the intermediate state and blocked a perfectly normal "change it to rice noodles".
  it('accepts a remove+add swap within the same required group in one batch', () => {
    const ops: CartOperation[] = [
      { action: 'remove_modifier', line_id: 'L1', modifier_key: '10' },
      { action: 'add_modifier', line_id: 'L1', modifier_key: '11' },
    ];

    expect(findRequiredModifierViolations(ops, cartView(['10']), new Map())).toEqual([]);
  });

  it('rejects a bare add_modifier that leaves two chosen in a required group', () => {
    const ops: CartOperation[] = [{ action: 'add_modifier', line_id: 'L1', modifier_key: '11' }];

    const v = findRequiredModifierViolations(ops, cartView(['10']), new Map());

    expect(v).toHaveLength(1);
    expect(v[0]).toContain('only one choice');
  });

  it('accepts adding an OPTIONAL modifier to a compliant line', () => {
    const ops: CartOperation[] = [{ action: 'add_modifier', line_id: 'L1', modifier_key: '20' }];

    expect(findRequiredModifierViolations(ops, cartView(['10']), new Map())).toEqual([]);
  });

  it('does not validate a line the batch removes', () => {
    const ops: CartOperation[] = [
      { action: 'remove_modifier', line_id: 'L1', modifier_key: '10' },
      { action: 'remove_item', line_id: 'L1' },
    ];

    expect(findRequiredModifierViolations(ops, cartView(['10']), new Map())).toEqual([]);
  });

  // An unrelated edit must not be blocked by a line that was already non-compliant.
  it('does not validate a line no modifier op touched', () => {
    const ops: CartOperation[] = [{ action: 'update_quantity', line_id: 'L1', quantity: 3 }];

    expect(findRequiredModifierViolations(ops, cartView([]), new Map())).toEqual([]);
  });

  // A line can arrive with an unsatisfied required group (created before this check shipped, or via
  // the degraded add_item path, or because a ptav was archived out of available_modifiers). Adding
  // a side must not turn into an interrogation about a group the customer never mentioned.
  it('does not judge a required group the batch never touched, even on a non-compliant line', () => {
    const ops: CartOperation[] = [{ action: 'add_modifier', line_id: 'L1', modifier_key: '20' }];

    // L1 has NO noodle selected — pre-existing violation — and the batch only adds a vegetable.
    expect(findRequiredModifierViolations(ops, cartView([]), new Map())).toEqual([]);
  });

  it('still judges the required group the batch DID touch on a non-compliant line', () => {
    const ops: CartOperation[] = [{ action: 'add_modifier', line_id: 'L1', modifier_key: '10' }];
    // Starts with both noodle options set (non-compliant); adding a third touches the group.
    const v = findRequiredModifierViolations(ops, cartView(['10', '11']), new Map());

    expect(v).toHaveLength(1);
    expect(v[0]).toContain('only one choice');
  });

  it('validates add_item and line edits together in one batch', () => {
    const ops: CartOperation[] = [
      { action: 'add_item', menu_item_key: 'mushu_pork', quantity: 1, modifiers: [] },
      { action: 'remove_modifier', line_id: 'L1', modifier_key: '10' },
    ];

    const v = findRequiredModifierViolations(ops, cartView(['10']), itemsByKey(NOODLES));

    // One from the add_item, one from the line edit — deduped to a single message per distinct text.
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('Noodles');
  });

  // The channel defaults to null in production, but a caller passing undefined must not throw.
  it('degrades instead of throwing when the cart view is undefined', () => {
    const ops: CartOperation[] = [{ action: 'remove_modifier', line_id: 'L1', modifier_key: '10' }];

    expect(() =>
      findRequiredModifierViolations(ops, undefined as unknown as CartView, new Map()),
    ).not.toThrow();
  });

  it('skips an unknown line_id', () => {
    const ops: CartOperation[] = [{ action: 'remove_modifier', line_id: 'ghost', modifier_key: '10' }];

    expect(findRequiredModifierViolations(ops, cartView(['10']), new Map())).toEqual([]);
  });

  it('skips edit validation entirely when there is no cart view', () => {
    const ops: CartOperation[] = [{ action: 'remove_modifier', line_id: 'L1', modifier_key: '10' }];

    expect(findRequiredModifierViolations(ops, null, new Map())).toEqual([]);
  });
});
