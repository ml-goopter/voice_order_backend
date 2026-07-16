import { config } from '../config/env.js';
import { AppError, messageOf } from '../shared/errors.js';
import type { PosOrderId } from '../shared/types.js';
import type { InsertCartRequest } from './insert-cart-request.js';
import type { QuoteRequest, QuoteResponse } from './quote-request.js';

const REQUEST_TIMEOUT_MS = 10_000;
const INSERT_CART_PATH = '/goopter_cart_api/v1/cart';
const QUOTE_PATH = '/goopter_cart_api/v1/quote';

/** A failure reported by Odoo, or by the transport reaching it. Distinct so the API layer answers 502. */
export class OdooError extends AppError {
  constructor(message: string) {
    super('odoo_error', message);
  }
}

interface JsonRpcError {
  message?: string;
  data?: { message?: string; name?: string };
}

interface JsonRpcResponse<T> {
  jsonrpc?: string;
  id?: number | string | null;
  result?: T;
  error?: JsonRpcError;
}

export interface OdooClient {
  insertCart(req: InsertCartRequest): Promise<PosOrderId>;
  quote(req: QuoteRequest): Promise<QuoteResponse>;
}

/**
 * JSON-RPC client for the goopter_cart_api addon (SPEC). Append-only cart insert over
 * `type="jsonrpc"`, `auth="bearer"` — the bearer token is an Odoo API key belonging to a
 * dedicated integration user, so the call runs with that user's record rules.
 */
export class HttpOdooClient implements OdooClient {
  constructor(
    private readonly baseUrl: string = config.odooApiUrl,
    private readonly apiKey: string = config.odooApiKey,
    private readonly database: string = config.odooApiDatabase,
  ) {}

  async insertCart(req: InsertCartRequest): Promise<PosOrderId> {
    // The addon returns the pos_order id as `order_id` (verified against the live
    // goopter_cart_api in jadegarden1), alongside pos_reference / tracking_number /
    // inserted_line_ids / server-authoritative totals — we read only the id.
    const result = await this.call<{ order_id?: unknown }>(INSERT_CART_PATH, req);
    // `call` only guarantees result !== undefined; a JSON-RPC method returning None sends
    // `result: null`, so guard the deref rather than crash with a raw TypeError.
    const id = result?.order_id;
    if (typeof id !== 'number') {
      throw new OdooError(`odoo insert returned no numeric order_id (got ${JSON.stringify(id)})`);
    }
    return id;
  }

  async quote(req: QuoteRequest): Promise<QuoteResponse> {
    // Read-only pricing route (SPEC § Quote behavior): server-authoritative per-line prices +
    // totals as decimals. Verified against the live addon; we validate the three order amounts
    // are numbers so a malformed reply is a clean OdooError (the caller prices best-effort off
    // it) rather than silently overwriting the cart total with `undefined`/NaN.
    const result = await this.call<Partial<QuoteResponse>>(QUOTE_PATH, req);
    const { amount_subtotal, amount_tax, amount_total } = result ?? {};
    if (![amount_subtotal, amount_tax, amount_total].every((n) => typeof n === 'number' && Number.isFinite(n))) {
      throw new OdooError(`odoo quote returned no numeric amounts (got ${JSON.stringify(result)})`);
    }
    return result as QuoteResponse;
  }

  private async call<T>(path: string, params: unknown): Promise<T> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}${path}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          // An Odoo host serving several databases cannot pick one on its own: without this
          // it answers "No database is selected" as an HTML 404, whatever the bearer says.
          // Omitted when empty — an instance with a dbfilter (or a single db) resolves itself.
          ...(this.database !== '' ? { 'x-odoo-database': this.database } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new OdooError(`odoo request failed: ${messageOf(err)}`);
    }

    let body: JsonRpcResponse<T>;
    try {
      body = (await res.json()) as JsonRpcResponse<T>;
    } catch (err) {
      throw new OdooError(`odoo returned a non-JSON response (http ${res.status}): ${messageOf(err)}`);
    }

    // JSON-RPC reports failure INSIDE an HTTP 200, with the error in the body (SPEC §
    // "Found during implementation"). So the `error` member decides, never res.ok /
    // res.status — branching on the status would read a failed insert as a success.
    if (body.error) throw new OdooError(odooMessage(body.error));
    if (body.result === undefined) {
      throw new OdooError(`odoo returned neither result nor error (http ${res.status})`);
    }
    return body.result;
  }
}

/** Odoo puts the human-readable text in `data.message`; `message` is usually just "Odoo Server Error". */
function odooMessage(e: JsonRpcError): string {
  return e.data?.message ?? e.message ?? 'unknown odoo error';
}
