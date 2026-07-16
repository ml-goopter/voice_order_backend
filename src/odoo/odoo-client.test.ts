import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpOdooClient, OdooError } from './odoo-client.js';
import type { InsertCartRequest } from './insert-cart-request.js';

const REQ: InsertCartRequest = {
  cart_id: 'cart_1',
  pos_config_id: 7,
  items: [{ line_id: 'ln_1', product_tmpl_id: 100, quantity: 1 }],
};

/** Stub `fetch` with one canned JSON body at the given HTTP status. */
function stubFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const f = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', f);
  return f;
}

function client(): HttpOdooClient {
  return new HttpOdooClient('http://odoo.test', 'key_123');
}

function headersOf(f: ReturnType<typeof vi.fn>): Record<string, string> {
  return (f.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>;
}

afterEach(() => vi.unstubAllGlobals());

describe('HttpOdooClient.insertCart', () => {
  it('returns order_id from a full addon response (verified against the live addon)', async () => {
    // The real goopter_cart_api response shape; we read only `order_id` and ignore the rest
    // (pos_reference, tracking_number, inserted/skipped line ids, server-authoritative totals).
    stubFetch({
      jsonrpc: '2.0',
      id: 1,
      result: {
        order_id: 408,
        pos_reference: '260-1-000011',
        tracking_number: '11',
        table_id: null,
        inserted_line_ids: ['ln_1'],
        skipped_line_ids: [],
        currency: 'CAD',
        decimal_places: 2,
        amount_total: 8.87,
      },
    });

    expect(await client().insertCart(REQ)).toBe(408);
  });

  it('POSTs a JSON-RPC envelope to the cart route with a bearer key', async () => {
    const f = stubFetch({ jsonrpc: '2.0', result: { order_id: 1 } });

    await client().insertCart(REQ);

    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://odoo.test/goopter_cart_api/v1/cart');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer key_123');
    // type="jsonrpc" semantics: the request rides in `params`.
    expect(JSON.parse(init.body as string)).toEqual({ jsonrpc: '2.0', method: 'call', params: REQ });
  });

  it('treats an HTTP 200 carrying an `error` member as a FAILURE', async () => {
    // The regression test for this whole integration: JSON-RPC reports failure inside a 200
    // (SPEC § "Found during implementation"). Branching on res.ok would read this as success
    // and mark a cart confirmed that Odoo never accepted.
    stubFetch({
      jsonrpc: '2.0',
      id: 1,
      error: { message: 'Odoo Server Error', data: { message: 'no open session', name: 'UserError' } },
    });

    await expect(client().insertCart(REQ)).rejects.toThrow(OdooError);
    // Odoo's own text survives, so "no open session" is diagnosable rather than opaque.
    await expect(client().insertCart(REQ)).rejects.toThrow('no open session');
  });

  it('falls back to error.message when Odoo sends no data.message', async () => {
    stubFetch({ jsonrpc: '2.0', error: { message: 'bare failure' } });

    await expect(client().insertCart(REQ)).rejects.toThrow('bare failure');
  });

  it('fails when the reply carries neither result nor error', async () => {
    stubFetch({ jsonrpc: '2.0', id: 1 });

    await expect(client().insertCart(REQ)).rejects.toThrow(OdooError);
  });

  it('fails when the result has no numeric order_id', async () => {
    stubFetch({ jsonrpc: '2.0', result: { order_id: null } });

    await expect(client().insertCart(REQ)).rejects.toThrow(/no numeric order_id/);
  });

  it('surfaces a null result as an OdooError rather than a raw deref crash', async () => {
    // A JSON-RPC method returning None sends `result: null` (not undefined), which slips past
    // the result-present check; the deref must be guarded so it stays an OdooError.
    stubFetch({ jsonrpc: '2.0', result: null });

    await expect(client().insertCart(REQ)).rejects.toThrow(OdooError);
  });

  it('surfaces a non-JSON body as an OdooError rather than a raw parse crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })),
    );

    await expect(client().insertCart(REQ)).rejects.toThrow(OdooError);
  });

  it('surfaces a transport failure as an OdooError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    await expect(client().insertCart(REQ)).rejects.toThrow(/odoo request failed: ECONNREFUSED/);
  });

  it('does not mistake a non-200 that still carries a valid result for a failure', async () => {
    // The mirror of the 200-on-error case: the body decides, not the status code.
    stubFetch({ jsonrpc: '2.0', result: { order_id: 7 } }, 201);

    expect(await client().insertCart(REQ)).toBe(7);
  });

  it('sends X-Odoo-Database when a database is configured', async () => {
    const f = stubFetch({ jsonrpc: '2.0', result: { order_id: 1 } });

    await new HttpOdooClient('http://odoo.test', 'k', 'jadegarden1').insertCart(REQ);

    expect(headersOf(f)['x-odoo-database']).toBe('jadegarden1');
  });

  it('omits X-Odoo-Database when no database is configured', async () => {
    // A single-db instance, or one with a dbfilter, resolves itself — sending an empty
    // header would be meaningless.
    const f = stubFetch({ jsonrpc: '2.0', result: { order_id: 1 } });

    await new HttpOdooClient('http://odoo.test', 'k', '').insertCart(REQ);

    expect(headersOf(f)).not.toHaveProperty('x-odoo-database');
  });

  it('joins the base URL and path without a double slash', async () => {
    const f = stubFetch({ jsonrpc: '2.0', result: { order_id: 1 } });

    await new HttpOdooClient('http://odoo.test/', 'k').insertCart(REQ);

    expect((f.mock.calls[0] as [string, RequestInit])[0]).toBe('http://odoo.test/goopter_cart_api/v1/cart');
  });
});
