import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpRouter } from './http-router.js';
import type { CartController } from '../cart/cart-controller.js';
import { NotFoundError } from '../shared/errors.js';
import { OdooError } from '../odoo/odoo-client.js';

let server: Server | undefined;
afterEach(() => server?.close());

/** Serve `confirm` behind the real router on an ephemeral port and return its base URL. */
async function serve(confirm: CartController['confirm']): Promise<string> {
  server = createServer(createHttpRouter({ confirm } as CartController));
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const ok: CartController['confirm'] = async () => 42;

describe('POST /v1/carts/:cart_id/confirm', () => {
  it('answers a bare 200 with no body on success', async () => {
    const base = await serve(ok);

    const res = await fetch(`${base}/v1/carts/cart_456/confirm`, { method: 'POST' });

    expect(res.status).toBe(200);
    // The pos_order_id is persisted on the cart, not returned: the frontend clears its
    // cart view on the 200 and has no use for it.
    expect(await res.text()).toBe('');
  });

  it('passes the cart_id from the path to the controller', async () => {
    const seen: string[] = [];
    const base = await serve(async (cart_id) => {
      seen.push(cart_id);
      return 42;
    });

    await fetch(`${base}/v1/carts/cart_456/confirm`, { method: 'POST' });

    expect(seen).toEqual(['cart_456']);
  });

  it('percent-decodes a cart_id from the path', async () => {
    const seen: string[] = [];
    const base = await serve(async (cart_id) => {
      seen.push(cart_id);
      return 42;
    });

    await fetch(`${base}/v1/carts/cart%20A/confirm`, { method: 'POST' });

    expect(seen).toEqual(['cart A']);
  });

  it('answers 400 for a malformed %-escape instead of crashing the process', async () => {
    // decodeURIComponent('%') throws URIError; if that escaped the request listener it would
    // become an uncaughtException and take the server down. It must be a clean 400.
    const base = await serve(ok);

    const res = await fetch(`${base}/v1/carts/%/confirm`, { method: 'POST' });

    expect(res.status).toBe(400);
  });

  it('ignores a query string when matching the route', async () => {
    const base = await serve(ok);

    const res = await fetch(`${base}/v1/carts/cart_456/confirm?debug=1`, { method: 'POST' });

    expect(res.status).toBe(200);
  });

  it('answers 404 for an unknown cart', async () => {
    const base = await serve(async () => {
      throw new NotFoundError('unknown cart cart_x');
    });

    const res = await fetch(`${base}/v1/carts/cart_x/confirm`, { method: 'POST' });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown cart cart_x' });
  });

  it('answers 502 with Odoo’s message when the insert fails', async () => {
    // Honest status codes, deliberately unlike the JSON-RPC far side's 200-on-error.
    const base = await serve(async () => {
      throw new OdooError('no open session');
    });

    const res = await fetch(`${base}/v1/carts/cart_1/confirm`, { method: 'POST' });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'no open session' });
  });

  it('answers 500 for an unexpected failure', async () => {
    const base = await serve(async () => {
      throw new Error('redis down');
    });

    const res = await fetch(`${base}/v1/carts/cart_1/confirm`, { method: 'POST' });

    expect(res.status).toBe(500);
  });

  it('does not route GET on the confirm path', async () => {
    const base = await serve(ok);

    expect((await fetch(`${base}/v1/carts/cart_1/confirm`)).status).toBe(404);
  });

  it('404s an unknown path', async () => {
    const base = await serve(ok);

    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

describe('health', () => {
  it('still serves GET /health and /healthz unchanged', async () => {
    const base = await serve(ok);

    for (const path of ['/health', '/healthz']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(await res.json()).toMatchObject({ status: 'ok' });
    }
  });
});
