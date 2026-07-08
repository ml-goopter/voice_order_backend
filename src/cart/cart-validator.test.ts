import { describe, it, expect } from 'vitest';
import type { PosConfigId } from '../shared/types.js';
import { CartRejectedError } from '../shared/errors.js';
import { MenuService } from '../menu/menu-service.js';
import { InMemoryMenuStore } from '../menu/in-memory-menu-store.js';
import type { MenuItem } from '../menu/menu-types.js';
import { validateOperation } from './cart-validator.js';
import { emptyCart } from './cart-types.js';

const POS: PosConfigId = 1;

function makeMenu(): MenuService {
  const items: MenuItem[] = [
    {
      product_tmpl_id: 100,
      menu_item_key: 'chicken_burger',
      names: { en_US: 'Chicken Burger' },
      base_price_cents: 500,
      available: true,
      modifiers: [{ modifier_key: 'no_mayo', ptav_id: 900, name: 'No mayo' }],
    },
  ];
  return new MenuService(InMemoryMenuStore.of(POS, items));
}

describe('validateOperation', () => {
  it('returns ok(void) for a valid operation without keeping a cart', async () => {
    const menu = makeMenu();
    const cart = emptyCart('cart_1', POS);
    const r = await validateOperation(cart, { action: 'add_item', menu_item_key: 'chicken_burger', quantity: 1, modifiers: [] }, menu, POS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeUndefined();
  });

  it('surfaces the same rejection the applier would (dry-run, never drifts)', async () => {
    const menu = makeMenu();
    const cart = emptyCart('cart_1', POS);
    const r = await validateOperation(cart, { action: 'remove_item', line_id: 'ln_missing' }, menu, POS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(CartRejectedError);
      expect((r.error as CartRejectedError).reason).toBe('line_gone');
    }
  });

  it('does not mutate the cart', async () => {
    const menu = makeMenu();
    const cart = emptyCart('cart_1', POS);
    await validateOperation(cart, { action: 'add_item', menu_item_key: 'chicken_burger', quantity: 1, modifiers: [] }, menu, POS);
    expect(cart.items).toHaveLength(0);
  });
});
