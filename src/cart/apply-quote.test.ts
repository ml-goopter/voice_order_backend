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

  it('leaves version + identity untouched, and keeps line prices when the quote has no line', () => {
    const cart = { ...emptyCart('c1', 7, { device_id: 'd1', table_id: 4 }), version: 3 };
    cart.items = [{ line_id: 'ln_1', product_tmpl_id: 100, name: 'x', names: {}, quantity: 1, modifiers: [], price_cents: 500 }];

    const priced = applyQuoteToCart(cart, quote()); // quote().lines is []

    expect(priced.version).toBe(3);
    // No matching quote line → the line's local-estimate price_cents survives.
    expect(priced.items).toEqual(cart.items);
    expect(priced.device_id).toBe('d1');
    expect(priced.table_id).toBe(4);
    expect(priced.cart_id).toBe('c1');
  });

  it('stamps each line ex-tax price_subtotal onto the matching line, and falls back for unmatched lines', () => {
    const cart = { ...emptyCart('c1', 7), version: 3 };
    cart.items = [
      { line_id: 'ln_1', product_tmpl_id: 100, name: 'a', names: {}, quantity: 2, modifiers: [], price_cents: 999 },
      { line_id: 'ln_2', product_tmpl_id: 200, name: 'b', names: {}, quantity: 1, modifiers: [], price_cents: 777 },
    ];

    const priced = applyQuoteToCart(
      cart,
      quote({
        lines: [
          { line_id: 'ln_1', product_id: 10, full_product_name: 'a', quantity: 2, price_unit: 5, price_subtotal: 10, price_subtotal_incl: 10.5 },
          // ln_2 absent from the quote → keeps its local estimate.
        ],
      }),
    );

    // ex-tax price_subtotal 10.00 → 1000 cents; incl-tax is ignored (no-tax per-line).
    expect(priced.items[0]!.price_cents).toBe(1000);
    expect(priced.items[1]!.price_cents).toBe(777);
  });

  it('rounds to the nearest cent', () => {
    // decimal_places=2 amounts convert exactly; Math.round guards against float dust like
    // 22.45*100 = 2245.0000000000005. A clean half (0.125) rounds up.
    const priced = applyQuoteToCart(emptyCart('c1', 7), quote({ amount_subtotal: 7.35, amount_tax: 0.125 }));

    expect(priced.subtotal_cents).toBe(735);
    expect(priced.tax_cents).toBe(13);
  });

  it('still prices cart totals and keeps local line estimates when the quote omits its line breakdown', () => {
    const cart = { ...emptyCart('c1', 7), version: 3 };
    cart.items = [{ line_id: 'ln_1', product_tmpl_id: 100, name: 'a', names: {}, quantity: 1, modifiers: [], price_cents: 500 }];

    // A malformed/absent `lines` must not throw — totals come from the validated amount_*.
    const priced = applyQuoteToCart(cart, quote({ lines: undefined as unknown as QuoteResponse['lines'] }));

    expect(priced.subtotal_cents).toBe(2245);
    expect(priced.tax_cents).toBe(113);
    expect(priced.items[0]!.price_cents).toBe(500); // local estimate preserved
  });

  it('keeps the local line estimate when a returned line has a non-numeric subtotal', () => {
    const cart = { ...emptyCart('c1', 7), version: 3 };
    cart.items = [{ line_id: 'ln_1', product_tmpl_id: 100, name: 'a', names: {}, quantity: 1, modifiers: [], price_cents: 500 }];

    const priced = applyQuoteToCart(
      cart,
      quote({
        lines: [
          { line_id: 'ln_1', product_id: 10, full_product_name: 'a', quantity: 1, price_unit: 5, price_subtotal: null as unknown as number, price_subtotal_incl: 5 },
        ],
      }),
    );

    // null subtotal is skipped (not stamped as 0) → local estimate stands.
    expect(priced.items[0]!.price_cents).toBe(500);
  });

  it('refuses a non-2-decimal currency (cart cents assume 2dp)', () => {
    expect(() => applyQuoteToCart(emptyCart('c1', 7), quote({ decimal_places: 0 }))).toThrow(/decimal_places/);
  });
});
