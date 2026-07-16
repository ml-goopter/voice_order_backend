import { describe, it, expect } from 'vitest';
import { applyQuoteToCart } from './apply-quote.js';
import { emptyCart } from './cart-types.js';
import type { QuoteResponse } from '../odoo/quote-request.js';

const quote = (over: Partial<QuoteResponse> = {}): QuoteResponse => ({
  currency: 'CAD',
  decimal_places: 2,
  lines: [],
  amount_subtotal: 22.45,
  amount_tax: 1.13,
  amount_total: 23.58,
  ...over,
});

describe('applyQuoteToCart', () => {
  it('overwrites the three total fields with the quote amounts as cents', () => {
    const cart = { ...emptyCart('c1', 7), subtotal_cents: 500, tax_cents: 0, total_cents: 500, version: 3 };

    const priced = applyQuoteToCart(cart, quote());

    expect(priced).toMatchObject({ subtotal_cents: 2245, tax_cents: 113, total_cents: 2358 });
  });

  it('leaves everything else (items, version, identity) untouched', () => {
    const cart = { ...emptyCart('c1', 7, { device_id: 'd1', table_id: 4 }), version: 3 };
    cart.items = [{ line_id: 'ln_1', product_tmpl_id: 100, name: 'x', names: {}, quantity: 1, modifiers: [] }];

    const priced = applyQuoteToCart(cart, quote());

    expect(priced.version).toBe(3);
    expect(priced.items).toBe(cart.items);
    expect(priced.device_id).toBe('d1');
    expect(priced.table_id).toBe(4);
    expect(priced.cart_id).toBe('c1');
  });

  it('rounds to the nearest cent', () => {
    // decimal_places=2 amounts convert exactly; Math.round guards against float dust like
    // 22.45*100 = 2245.0000000000005. A clean half (0.125) rounds up.
    const priced = applyQuoteToCart(emptyCart('c1', 7), quote({ amount_subtotal: 7.35, amount_tax: 0.125 }));

    expect(priced.subtotal_cents).toBe(735);
    expect(priced.tax_cents).toBe(13);
  });

  it('refuses a non-2-decimal currency (cart cents assume 2dp)', () => {
    expect(() => applyQuoteToCart(emptyCart('c1', 7), quote({ decimal_places: 0 }))).toThrow(/decimal_places/);
  });
});
