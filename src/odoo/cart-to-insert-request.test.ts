import { describe, it, expect } from 'vitest';
import type { Cart } from '../cart/cart-types.js';
import { emptyCart } from '../cart/cart-types.js';
import { toInsertCartRequest } from './cart-to-insert-request.js';

/** A cart carrying every field the far side drops, so the mapping's omissions are observable. */
function fullCart(): Cart {
  return {
    ...emptyCart('cart_1', 7, { device_id: 'dev_1', table_id: 12 }),
    version: 5,
    subtotal_cents: 1000,
    tax_cents: 130,
    total_cents: 1130,
    items: [
      {
        line_id: 'ln_1',
        product_tmpl_id: 100,
        product_id: 555,
        name: 'Chicken Burger',
        names: { en_US: 'Chicken Burger', zh_CN: '鸡肉汉堡' },
        quantity: 2,
        modifiers: [
          { ptav_id: 900, name: 'No mayo' },
          { ptav_id: 901, name: 'Extra cheese', names: { en_US: 'Extra cheese' } },
        ],
      },
    ],
  };
}

describe('toInsertCartRequest', () => {
  it('maps the fields the far side uses', () => {
    expect(toInsertCartRequest(fullCart())).toEqual({
      cart_id: 'cart_1',
      pos_config_id: 7,
      table_id: 12,
      items: [{ line_id: 'ln_1', product_tmpl_id: 100, quantity: 2, ptav_ids: [900, 901] }],
    });
  });

  it('drops name/names/product_id, the *_cents totals, version and last_updated', () => {
    const req = toInsertCartRequest(fullCart()) as unknown as Record<string, unknown>;
    const line = req.items as Array<Record<string, unknown>>;

    // Prices are server-authoritative; version/last_updated are unnecessary under strict
    // append-only; names would print arbitrary text on kitchen tickets.
    for (const dropped of ['subtotal_cents', 'tax_cents', 'total_cents', 'version', 'last_updated', 'device_id']) {
      expect(req).not.toHaveProperty(dropped);
    }
    for (const dropped of ['name', 'names', 'product_id', 'modifiers']) {
      expect(line[0]!).not.toHaveProperty(dropped);
    }
  });

  it('flattens modifiers to ptav_ids and omits them entirely when there are none', () => {
    const cart = emptyCart('cart_2', 1, { device_id: 'dev_1' });
    cart.items = [
      { line_id: 'ln_1', product_tmpl_id: 100, name: 'Fries', names: { en_US: 'Fries' }, quantity: 1, modifiers: [] },
    ];

    expect(toInsertCartRequest(cart).items[0]).toEqual({ line_id: 'ln_1', product_tmpl_id: 100, quantity: 1 });
  });

  it('omits table_id when absent → an untabled (takeout) order', () => {
    const req = toInsertCartRequest(emptyCart('cart_3', 1, { device_id: 'dev_1' }));

    expect(req).not.toHaveProperty('table_id');
  });

  it('never sends preset_id — every cart is treated as dine-in by the far side', () => {
    expect(toInsertCartRequest(fullCart())).not.toHaveProperty('preset_id');
  });

  it('sends line_id raw — the far side namespaces it into the line uuid', () => {
    const req = toInsertCartRequest(fullCart());

    // Pre-namespacing here would produce "cart_1:cart_1:ln_1" on the far side.
    expect(req.items[0]!.line_id).toBe('ln_1');
  });
});
