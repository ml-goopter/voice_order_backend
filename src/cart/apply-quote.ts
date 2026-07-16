import type { Cart } from './cart-types.js';
import type { Cents } from '../shared/types.js';
import type { QuoteResponse } from '../odoo/quote-request.js';

/**
 * Overwrite a cart's totals with the POS's server-authoritative quote (design: the cart's own
 * `(base + Σ surcharge) × qty` is an untaxed estimate; the quote is the price the POS will
 * actually charge, tax included). Only the three total fields change — line contents, version,
 * and identity are untouched.
 *
 * `amount_*` are decimals in the currency's units; the cart stores integer **cents**
 * (hundredths). Both live deployments use CAD (`decimal_places === 2`, SPEC), so `× 100` is
 * exact and matches the frontend's `/100`. A currency with a different `decimal_places` would
 * need that `/100` assumption revisited end-to-end — out of scope here, hence the guard below.
 */
export function applyQuoteToCart(cart: Cart, quote: QuoteResponse): Cart {
  if (quote.decimal_places !== 2) {
    throw new Error(`quote currency has decimal_places=${quote.decimal_places}; cart cents assume 2`);
  }
  return {
    ...cart,
    subtotal_cents: toCents(quote.amount_subtotal),
    tax_cents: toCents(quote.amount_tax),
    total_cents: toCents(quote.amount_total),
  };
}

function toCents(amount: number): Cents {
  return Math.round(amount * 100);
}
