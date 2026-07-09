import { describe, it, expect, beforeEach } from 'vitest';
import type { PosConfigId } from '../shared/types.js';
import type { Result } from '../shared/result.js';
import { CartRejectedError } from '../shared/errors.js';
import { MenuService } from '../menu/menu-service.js';
import { InMemoryMenuStore } from '../menu/in-memory-menu-store.js';
import type { MenuItem } from '../menu/menu-types.js';
import { applyOperation } from './cart-operation-applier.js';
import { emptyCart, type Cart } from './cart-types.js';
import type { MenuLookup } from '../menu/menu-service.js';
import type { CartOperation } from '../ordering/schemas/cart-operation.schema.js';

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
      modifiers: [],
    },
    {
      product_tmpl_id: 300,
      menu_item_key: 'soup',
      names: { en_US: 'Soup' },
      base_price_cents: 400,
      available: false,
      modifiers: [],
    },
  ];
  return new MenuService(InMemoryMenuStore.of(POS, items));
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
async function addItem(
  cart: Cart,
  menu: MenuService,
  menu_item_key: string,
  quantity = 1,
  modifiers: string[] = [],
): Promise<{ cart: Cart; line_id: string }> {
  const next = expectOk(
    await applyOperation(
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
    it('adds a line, assigns a line_id, and prices it', async () => {
      const next = expectOk(
        await applyOperation(cart, { action: 'add_item', menu_item_key: 'chicken_burger', quantity: 2, modifiers: [] }, menu, POS),
      );
      expect(next.items).toHaveLength(1);
      const line = next.items[0]!;
      expect(line.line_id).toMatch(/^ln_/);
      expect(line.product_tmpl_id).toBe(100);
      expect(line.name).toBe('Chicken Burger');
      expect(line.quantity).toBe(2);
      expect(line.modifiers).toEqual([]);
      // 2 × 500 = 1000
      expect(next.subtotal_cents).toBe(1000);
      expect(next.total_cents).toBe(1000);
    });

    it('resolves modifier keys to ptav_ids', async () => {
      const next = expectOk(
        await applyOperation(
          cart,
          { action: 'add_item', menu_item_key: 'chicken_burger', quantity: 1, modifiers: [{ modifier_key: 'no_mayo' }] },
          menu,
          POS,
        ),
      );
      expect(next.items[0]!.modifiers).toEqual([{ ptav_id: 900, name: 'No mayo' }]);
    });

    it('does not mutate the input cart', async () => {
      await addItem(cart, menu, 'chicken_burger');
      expect(cart.items).toHaveLength(0);
      expect(cart.subtotal_cents).toBe(0);
    });

    it('assigns a fresh line_id per add — two of the same item are distinct lines', async () => {
      const one = await addItem(cart, menu, 'chicken_burger');
      const two = await addItem(one.cart, menu, 'chicken_burger');
      expect(two.cart.items).toHaveLength(2);
      expect(two.cart.items[0]!.line_id).not.toBe(two.cart.items[1]!.line_id);
    });

    it('rejects an unknown menu_item_key', async () => {
      expectReject(
        await applyOperation(cart, { action: 'add_item', menu_item_key: 'nope', quantity: 1, modifiers: [] }, menu, POS),
        'unavailable_item',
      );
    });

    it('rejects an unavailable item', async () => {
      expectReject(
        await applyOperation(cart, { action: 'add_item', menu_item_key: 'soup', quantity: 1, modifiers: [] }, menu, POS),
        'unavailable_item',
      );
    });

    it('rejects a modifier the item does not offer', async () => {
      expectReject(
        await applyOperation(
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
    it('removes an existing line and reprices', async () => {
      const { cart: withItem, line_id } = await addItem(cart, menu, 'chicken_burger');
      const next = expectOk(await applyOperation(withItem, { action: 'remove_item', line_id }, menu, POS));
      expect(next.items).toHaveLength(0);
      expect(next.subtotal_cents).toBe(0);
    });

    it('rejects removing a line that is not in the cart', async () => {
      expectReject(await applyOperation(cart, { action: 'remove_item', line_id: 'ln_missing' }, menu, POS), 'line_gone');
    });
  });

  describe('update_quantity', () => {
    it('updates quantity and reprices', async () => {
      const { cart: withItem, line_id } = await addItem(cart, menu, 'chicken_burger', 1);
      const next = expectOk(await applyOperation(withItem, { action: 'update_quantity', line_id, quantity: 3 }, menu, POS));
      expect(next.items[0]!.quantity).toBe(3);
      expect(next.subtotal_cents).toBe(1500);
    });

    it('rejects a non-positive quantity', async () => {
      const { cart: withItem, line_id } = await addItem(cart, menu, 'chicken_burger');
      expectReject(await applyOperation(withItem, { action: 'update_quantity', line_id, quantity: 0 }, menu, POS), 'invalid_quantity');
      expectReject(await applyOperation(withItem, { action: 'update_quantity', line_id, quantity: -2 }, menu, POS), 'invalid_quantity');
    });

    it('rejects updating a line that is gone', async () => {
      expectReject(await applyOperation(cart, { action: 'update_quantity', line_id: 'ln_missing', quantity: 2 }, menu, POS), 'line_gone');
    });
  });

  describe('add_modifier', () => {
    it('adds a modifier to an existing line', async () => {
      const { cart: withItem, line_id } = await addItem(cart, menu, 'chicken_burger');
      const next = expectOk(await applyOperation(withItem, { action: 'add_modifier', line_id, modifier_key: 'extra_cheese' }, menu, POS));
      expect(next.items[0]!.modifiers).toEqual([{ ptav_id: 901, name: 'Extra cheese' }]);
    });

    it('is idempotent — adding the same modifier twice does not duplicate it', async () => {
      const { cart: withItem, line_id } = await addItem(cart, menu, 'chicken_burger', 1, ['no_mayo']);
      const next = expectOk(await applyOperation(withItem, { action: 'add_modifier', line_id, modifier_key: 'no_mayo' }, menu, POS));
      expect(next.items[0]!.modifiers).toEqual([{ ptav_id: 900, name: 'No mayo' }]);
    });

    it('rejects a modifier not valid for the item', async () => {
      const { cart: withItem, line_id } = await addItem(cart, menu, 'fries');
      expectReject(await applyOperation(withItem, { action: 'add_modifier', line_id, modifier_key: 'no_mayo' }, menu, POS), 'invalid_modifier');
    });

    it('rejects when the line is gone', async () => {
      expectReject(await applyOperation(cart, { action: 'add_modifier', line_id: 'ln_missing', modifier_key: 'no_mayo' }, menu, POS), 'line_gone');
    });
  });

  describe('remove_modifier', () => {
    it('removes a present modifier', async () => {
      const { cart: withItem, line_id } = await addItem(cart, menu, 'chicken_burger', 1, ['no_mayo', 'extra_cheese']);
      const next = expectOk(await applyOperation(withItem, { action: 'remove_modifier', line_id, modifier_key: 'no_mayo' }, menu, POS));
      expect(next.items[0]!.modifiers).toEqual([{ ptav_id: 901, name: 'Extra cheese' }]);
    });

    it('is a no-op when the modifier is valid but not present', async () => {
      const { cart: withItem, line_id } = await addItem(cart, menu, 'chicken_burger');
      const next = expectOk(await applyOperation(withItem, { action: 'remove_modifier', line_id, modifier_key: 'no_mayo' }, menu, POS));
      expect(next.items[0]!.modifiers).toEqual([]);
    });

    it('rejects a modifier not valid for the item', async () => {
      const { cart: withItem, line_id } = await addItem(cart, menu, 'fries');
      expectReject(await applyOperation(withItem, { action: 'remove_modifier', line_id, modifier_key: 'no_mayo' }, menu, POS), 'invalid_modifier');
    });

    it('rejects when the line is gone', async () => {
      expectReject(await applyOperation(cart, { action: 'remove_modifier', line_id: 'ln_missing', modifier_key: 'no_mayo' }, menu, POS), 'line_gone');
    });
  });
});

describe('applyOperation — pricing and menu edge cases', () => {
  /** A menu that has forgotten every item (as if the products were delisted). */
  const emptyMenu: MenuLookup = {
    resolveItemKey: async () => undefined,
    findByTmplId: async () => undefined,
    getItems: async () => [],
  };

  /** A cart already holding one line for product_tmpl_id 100, priced at 2 × 500 = 1000. */
  function cartWithLine(): Cart {
    return {
      cart_id: 'cart_x',
      pos_config_id: POS,
      version: 1,
      items: [{ line_id: 'ln_1', product_tmpl_id: 100, quantity: 2, modifiers: [] }],
      subtotal_cents: 1000,
      tax_cents: 0,
      total_cents: 1000,
      last_updated: '2026-01-01T00:00:00.000Z',
    };
  }

  it('KNOWN GAP (H3): a line whose product left the menu silently reprices to 0', async () => {
    // There is no per-line price snapshot, so priced() falls back to `?? 0`
    // (cart-operation-applier.ts:22): the subtotal deflates with NO rejection. Pinning
    // current behavior — revisit when line-level price snapshots land.
    const next = expectOk(
      await applyOperation(cartWithLine(), { action: 'update_quantity', line_id: 'ln_1', quantity: 3 }, emptyMenu, POS),
    );
    expect(next.items[0]!.quantity).toBe(3);
    expect(next.subtotal_cents).toBe(0);
    expect(next.total_cents).toBe(0);
  });

  it('KNOWN GAP (H5): a delisted item is reported as invalid_modifier, not as unavailable', async () => {
    // findByTmplId → undefined means the line's product vanished from the menu, but the
    // applier collapses that into the same 'invalid_modifier' reason as a genuinely wrong
    // key (cart-operation-applier.ts:74-76), giving a misleading customer message.
    expectReject(
      await applyOperation(cartWithLine(), { action: 'add_modifier', line_id: 'ln_1', modifier_key: 'no_mayo' }, emptyMenu, POS),
      'invalid_modifier',
    );
  });

  it('KNOWN GAP (C2): an unknown action falls through the switch and resolves to undefined', async () => {
    // applyOperation has no `default` branch (cart-operation-applier.ts:39-86). An action
    // that skips schema validation returns undefined, which the controller reads as
    // `undefined.ok` → TypeError → surfaced as internal_error. Pinning the fall-through.
    const r = await applyOperation(cartWithLine(), { action: 'frobnicate', line_id: 'ln_1' } as unknown as CartOperation, emptyMenu, POS);
    expect(r).toBeUndefined();
  });
});
