import { describe, it, expect } from 'vitest';
import { buildCartView } from './load-cart.node.js';
import type { MenuLookup } from '../../menu/menu-service.js';
import type { MenuItem } from '../../menu/menu-types.js';
import type { Cart, CartLine, CartModifier } from '../../cart/cart-types.js';

const CHICKEN: MenuItem = {
  product_tmpl_id: 10,
  menu_item_key: 'sweet_sour_chicken',
  names: { en_US: 'Sweet and Sour Chicken' },
  base_price_cents: 1200,
  available: true,
  modifiers: [
    { modifier_key: 'add_broccoli', ptav_id: 100, name: 'Add broccoli' },
    { modifier_key: 'no_broccoli', ptav_id: 101, name: 'No broccoli' },
  ],
};

/** A MenuLookup that only answers getItems from a fixed catalog. */
function fakeMenu(catalog: MenuItem[]): MenuLookup {
  return {
    getItems: async (_pos, ids) => catalog.filter((i) => ids.includes(i.product_tmpl_id)),
    resolveItemKey: async () => undefined,
    findByTmplId: async () => undefined,
  };
}

/** A stored line/modifier carries display names snapshotted at add time, but `buildCartView`
 * never reads them — it re-resolves every name from the menu — so these fixtures fill the
 * required fields with a placeholder that would be obvious if it ever surfaced in a view. */
const mod = (ptav_id: CartModifier['ptav_id']): CartModifier => ({ ptav_id, name: 'SNAPSHOT_UNREAD' });
const cartLine = (l: Omit<CartLine, 'name' | 'names'>): CartLine => ({ ...l, name: 'SNAPSHOT_UNREAD', names: {} });

function cartWith(items: Cart['items']): Cart {
  return {
    cart_id: 'cart_1',
    pos_config_id: 1,
    version: 3,
    items,
    subtotal_cents: 0,
    tax_cents: 0,
    total_cents: 0,
    last_updated: '2026-07-08T00:00:00.000Z',
  };
}

describe('buildCartView (Plan A self-describing cart)', () => {
  it('enriches a line with name, key, resolved current modifiers, and available_modifiers', async () => {
    const cart = cartWith([
      cartLine({ line_id: 'ln_1', product_tmpl_id: 10, quantity: 2, modifiers: [mod(100)] }),
    ]);
    const view = await buildCartView(fakeMenu([CHICKEN]), cart);

    expect(view.version).toBe(3);
    expect(view.items).toHaveLength(1);
    const line = view.items[0]!;
    expect(line.line_id).toBe('ln_1');
    expect(line.menu_item_key).toBe('sweet_sour_chicken');
    expect(line.name).toBe('Sweet and Sour Chicken');
    expect(line.quantity).toBe(2);
    expect(line.modifiers).toEqual([{ modifier_key: 'add_broccoli', name: 'Add broccoli' }]);
    expect(line.available_modifiers).toEqual([
      { modifier_key: 'add_broccoli', name: 'Add broccoli' },
      { modifier_key: 'no_broccoli', name: 'No broccoli' },
    ]);
    // No numeric ids leak into the prompt view.
    expect(JSON.stringify(line)).not.toMatch(/product_tmpl_id|ptav_id|"100"|"10"/);
  });

  it('degrades gracefully when the item is missing from the menu', async () => {
    const cart = cartWith([
      cartLine({ line_id: 'ln_x', product_tmpl_id: 999, quantity: 1, modifiers: [mod(5)] }),
    ]);
    const view = await buildCartView(fakeMenu([CHICKEN]), cart);
    const line = view.items[0]!;
    expect(line.name).toBe('999');
    expect(line.menu_item_key).toBe('999');
    expect(line.modifiers).toEqual([]);
    expect(line.available_modifiers).toEqual([]);
  });

  it('falls back to a non-en_US name (never the numeric id) when en_US is absent', async () => {
    const zhChicken: MenuItem = { ...CHICKEN, names: { zh_CN: '甜酸鸡' } };
    const cart = cartWith([
      cartLine({ line_id: 'ln_1', product_tmpl_id: 10, quantity: 1, modifiers: [] }),
    ]);
    const view = await buildCartView(fakeMenu([zhChicken]), cart);
    // The line still names itself (localized), so the model can match "the chicken" → line_id.
    expect(view.items[0]!.name).toBe('甜酸鸡');
    expect(view.items[0]!.name).not.toBe('10');
  });

  it('drops an attached ptav_id that is not a modifier of the item', async () => {
    const cart = cartWith([
      cartLine({ line_id: 'ln_1', product_tmpl_id: 10, quantity: 1, modifiers: [mod(999)] }),
    ]);
    const view = await buildCartView(fakeMenu([CHICKEN]), cart);
    expect(view.items[0]!.modifiers).toEqual([]);
  });
});
