import type { LineId, PosConfigId, ProductId } from '../shared/types.js';
import type { RequestLine } from './insert-cart-request.js';

/**
 * Body of POST /goopter_cart_api/v1/quote (SPEC § API contract). Quote prices a list of items
 * and creates nothing, so — unlike InsertCartRequest — it carries no `cart_id` (no line-uuid
 * namespace) and no `table_id`. It shares `RequestLine` + `pos_config_id` with insert on
 * purpose: SPEC § "Insert is quote plus two fields" makes the two routes take identical
 * pricing inputs so they cannot disagree on price.
 */
export interface QuoteRequest {
  pos_config_id: PosConfigId;
  /** Order type — drives pricelist + fiscal position. Omitted → config default (dine-in). */
  preset_id?: number | null;
  items: RequestLine[];
}

/** One priced line in a quote response (verified against the live addon). */
export interface QuoteLine {
  line_id: LineId;
  product_id: ProductId;
  full_product_name: string;
  quantity: number;
  price_unit: number;
  price_subtotal: number; // ex-tax
  price_subtotal_incl: number; // incl-tax
}

/**
 * Response of the quote route (verified against the live goopter_cart_api at jadegarden1).
 * Money is **decimals** plus a `currency` code and `decimal_places` (SPEC § Open questions —
 * resolved #5: never cents). The cart module converts `amount_*` into its own integer cents.
 */
export interface QuoteResponse {
  currency: string;
  decimal_places: number;
  lines: QuoteLine[];
  amount_subtotal: number; // ex-tax
  amount_tax: number;
  amount_total: number; // incl-tax
}
