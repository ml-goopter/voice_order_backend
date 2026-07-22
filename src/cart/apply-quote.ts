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
  // The quote also returns a per-line breakdown keyed by our line_id. Stamp each line's
  // ex-tax subtotal (price_subtotal) onto it as the authoritative price; a line the quote
  // didn't return (or returned without a numeric subtotal) keeps the applier's local estimate
  // (already on line.price_cents). Guard the shape defensively: a malformed/absent `lines` must
  // NOT throw here — the cart totals below still come from the validated `amount_*`, so only the
  // per-line values degrade to the local estimate rather than demoting the whole update.
  const quoteLines = Array.isArray(quote.lines) ? quote.lines : [];
  const subtotalByLine = new Map(
    quoteLines.filter((l) => typeof l.price_subtotal === 'number').map((l) => [l.line_id, l.price_subtotal]),
  );
  return {
    ...cart,
    items: cart.items.map((line) => {
      const s = subtotalByLine.get(line.line_id);
      return s === undefined ? line : { ...line, price_cents: toCents(s) };
    }),
    subtotal_cents: toCents(quote.amount_subtotal),
    tax_cents: toCents(quote.amount_tax),
    total_cents: toCents(quote.amount_total),
  };
}

function toCents(amount: number): Cents {
  return Math.round(amount * 100);
}
