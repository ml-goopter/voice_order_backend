import { describe, it, expect, beforeEach } from 'vitest';
import type { PosConfigId } from '../shared/types.js';
import type { Result } from '../shared/result.js';
import { CartRejectedError } from '../shared/errors.js';
import { MenuService } from '../menu/menu-service.js';
import type { MenuItem } from '../menu/menu-types.js';
import { applyOperation } from './cart-operation-applier.js';
import { emptyCart, type Cart } from './cart-types.js';

const POS: PosConfigId = 1;

/** Menu fixture: an item with modifiers, a plain item, and an unavailable item. */
function makeMenu(): MenuService {
  const items: MenuItem[] = [
    {
      product_tmpl_id: 100,
      menu_item_key: 'chicken_burger',
      names: { en_US: 'Chicken Burger' },
      base_price_cents: 500,
      available: true,
      popularity: 10,
      modifiers: [
        { modifier_key: 'no_mayo', ptav_id: 900, name: 'No mayo' },
        { modifier_key: 'extra_cheese', ptav_id: 901, name: 'Extra cheese' },
      ],
    },
    {
      product_tmpl_id: 200,
      menu_item_key: 'fries',
      names: { en_US: 'Fries' },
      base_price_cents: 300,
      available: true,
      popularity: 5,
      modifiers: [],
    },
    {
      product_tmpl_id: 300,
      menu_item_key: 'soup',
      names: { en_US: 'Soup' },
      base_price_cents: 400,
      available: false,
      popularity: 1,
      modifiers: [],
    },
  ];
  const menu = new MenuService();
  menu.loadMenu(POS, items);
  return menu;
}

/** Unwrap an ok Result or fail loudly. */
function expectOk<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error.message}`);
  return r.value;
}

/** Assert a Result rejected the op with the given reason (design §11.3 stage 4). */
function expectReject<T>(r: Result<T>, reason: string): CartRejectedError {
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error('unreachable');
  expect(r.error).toBeInstanceOf(CartRejectedError);
  const e = r.error as CartRejectedError;
  expect(e.reason).toBe(reason);
  return e;
}

/** add_item helper — returns the new cart and the line_id it assigned. */
function addItem(
  cart: Cart,
  menu: MenuService,
  menu_item_key: string,
  quantity = 1,
  modifiers: string[] = [],
): { cart: Cart; line_id: string } {
  const next = expectOk(
    applyOperation(
      cart,
      { action: 'add_item', menu_item_key, quantity, modifiers: modifiers.map((m) => ({ modifier_key: m })) },
      menu,
      POS,
    ),
  );
  const line_id = next.items[next.items.length - 1]!.line_id;
  return { cart: next, line_id };
}

describe('applyOperation', () => {
  let menu: MenuService;
  let cart: Cart;

  beforeEach(() => {
    menu = makeMenu();
    cart = emptyCart('cart_1', POS);
  });

  describe('add_item', () => {
    it('adds a line, assigns a line_id, and prices it', () => {
      const next = expectOk(
        applyOperation(cart, { action: 'add_item', menu_item_key: 'chicken_burger', quantity: 2, modifiers: [] }, menu, POS),
      );
      expect(next.items).toHaveLength(1);
      const line = next.items[0]!;
      expect(line.line_id).toMatch(/^ln_/);
      expect(line.product_tmpl_id).toBe(100);
      expect(line.quantity).toBe(2);
      expect(line.modifiers).toEqual([]);
      // 2 × 500 = 1000
      expect(next.subtotal_cents).toBe(1000);
      expect(next.total_cents).toBe(1000);
    });

    it('resolves modifier keys to ptav_ids', () => {
      const next = expectOk(
        applyOperation(
          cart,
          { action: 'add_item', menu_item_key: 'chicken_burger', quantity: 1, modifiers: [{ modifier_key: 'no_mayo' }] },
          menu,
          POS,
        ),
      );
      expect(next.items[0]!.modifiers).toEqual([{ ptav_id: 900 }]);
    });

    it('does not mutate the input cart', () => {
      addItem(cart, menu, 'chicken_burger');
      expect(cart.items).toHaveLength(0);
      expect(cart.subtotal_cents).toBe(0);
    });

    it('assigns a fresh line_id per add — two of the same item are distinct lines', () => {
      const one = addItem(cart, menu, 'chicken_burger');
      const two = addItem(one.cart, menu, 'chicken_burger');
      expect(two.cart.items).toHaveLength(2);
      expect(two.cart.items[0]!.line_id).not.toBe(two.cart.items[1]!.line_id);
    });

    it('rejects an unknown menu_item_key', () => {
      expectReject(
        applyOperation(cart, { action: 'add_item', menu_item_key: 'nope', quantity: 1, modifiers: [] }, menu, POS),
        'unavailable_item',
      );
    });

    it('rejects an unavailable item', () => {
      expectReject(
        applyOperation(cart, { action: 'add_item', menu_item_key: 'soup', quantity: 1, modifiers: [] }, menu, POS),
        'unavailable_item',
      );
    });

    it('rejects a modifier the item does not offer', () => {
      expectReject(
        applyOperation(
          cart,
          { action: 'add_item', menu_item_key: 'fries', quantity: 1, modifiers: [{ modifier_key: 'no_mayo' }] },
          menu,
          POS,
        ),
        'invalid_modifier',
      );
    });
  });

  describe('remove_item', () => {
    it('removes an existing line and reprices', () => {
      const { cart: withItem, line_id } = addItem(cart, menu, 'chicken_burger');
      const next = expectOk(applyOperation(withItem, { action: 'remove_item', line_id }, menu, POS));
      expect(next.items).toHaveLength(0);
      expect(next.subtotal_cents).toBe(0);
    });

    it('rejects removing a line that is not in the cart', () => {
      expectReject(applyOperation(cart, { action: 'remove_item', line_id: 'ln_missing' }, menu, POS), 'line_gone');
    });
  });

  describe('update_quantity', () => {
    it('updates quantity and reprices', () => {
      const { cart: withItem, line_id } = addItem(cart, menu, 'chicken_burger', 1);
      const next = expectOk(applyOperation(withItem, { action: 'update_quantity', line_id, quantity: 3 }, menu, POS));
      expect(next.items[0]!.quantity).toBe(3);
      expect(next.subtotal_cents).toBe(1500);
    });

    it('rejects a non-positive quantity', () => {
      const { cart: withItem, line_id } = addItem(cart, menu, 'chicken_burger');
      expectReject(applyOperation(withItem, { action: 'update_quantity', line_id, quantity: 0 }, menu, POS), 'invalid_quantity');
      expectReject(applyOperation(withItem, { action: 'update_quantity', line_id, quantity: -2 }, menu, POS), 'invalid_quantity');
    });

    it('rejects updating a line that is gone', () => {
      expectReject(applyOperation(cart, { action: 'update_quantity', line_id: 'ln_missing', quantity: 2 }, menu, POS), 'line_gone');
    });
  });

  describe('add_modifier', () => {
    it('adds a modifier to an existing line', () => {
      const { cart: withItem, line_id } = addItem(cart, menu, 'chicken_burger');
      const next = expectOk(applyOperation(withItem, { action: 'add_modifier', line_id, modifier_key: 'extra_cheese' }, menu, POS));
      expect(next.items[0]!.modifiers).toEqual([{ ptav_id: 901 }]);
    });

    it('is idempotent — adding the same modifier twice does not duplicate it', () => {
      const { cart: withItem, line_id } = addItem(cart, menu, 'chicken_burger', 1, ['no_mayo']);
      const next = expectOk(applyOperation(withItem, { action: 'add_modifier', line_id, modifier_key: 'no_mayo' }, menu, POS));
      expect(next.items[0]!.modifiers).toEqual([{ ptav_id: 900 }]);
    });

    it('rejects a modifier not valid for the item', () => {
      const { cart: withItem, line_id } = addItem(cart, menu, 'fries');
      expectReject(applyOperation(withItem, { action: 'add_modifier', line_id, modifier_key: 'no_mayo' }, menu, POS), 'invalid_modifier');
    });

    it('rejects when the line is gone', () => {
      expectReject(applyOperation(cart, { action: 'add_modifier', line_id: 'ln_missing', modifier_key: 'no_mayo' }, menu, POS), 'line_gone');
    });
  });

  describe('remove_modifier', () => {
    it('removes a present modifier', () => {
      const { cart: withItem, line_id } = addItem(cart, menu, 'chicken_burger', 1, ['no_mayo', 'extra_cheese']);
      const next = expectOk(applyOperation(withItem, { action: 'remove_modifier', line_id, modifier_key: 'no_mayo' }, menu, POS));
      expect(next.items[0]!.modifiers).toEqual([{ ptav_id: 901 }]);
    });

    it('is a no-op when the modifier is valid but not present', () => {
      const { cart: withItem, line_id } = addItem(cart, menu, 'chicken_burger');
      const next = expectOk(applyOperation(withItem, { action: 'remove_modifier', line_id, modifier_key: 'no_mayo' }, menu, POS));
      expect(next.items[0]!.modifiers).toEqual([]);
    });

    it('rejects a modifier not valid for the item', () => {
      const { cart: withItem, line_id } = addItem(cart, menu, 'fries');
      expectReject(applyOperation(withItem, { action: 'remove_modifier', line_id, modifier_key: 'no_mayo' }, menu, POS), 'invalid_modifier');
    });

    it('rejects when the line is gone', () => {
      expectReject(applyOperation(cart, { action: 'remove_modifier', line_id: 'ln_missing', modifier_key: 'no_mayo' }, menu, POS), 'line_gone');
    });
  });
});
