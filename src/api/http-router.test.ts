import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpRouter } from './http-router.js';
import type { CartController } from '../cart/cart-controller.js';
import { NotFoundError } from '../shared/errors.js';
import { OdooError } from '../odoo/odoo-client.js';
import type { OdooImageClient } from '../odoo/odoo-image-client.js';

let server: Server | undefined;
afterEach(() => server?.close());

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** Hands back a fixed PNG whatever it is asked for. */
const stubImages: OdooImageClient = {
  fetchImage: async () => ({ notModified: false, bytes: PNG, contentType: 'image/png' }),
};

/** Serve the router on an ephemeral port and return its base URL. */
async function serve(
  confirm: CartController['confirm'],
  ordersByDevice: CartController['ordersByDevice'] = async () => [],
  images: OdooImageClient = stubImages,
): Promise<string> {
  server = createServer(createHttpRouter({ confirm, ordersByDevice } as CartController, images));
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const ok: CartController['confirm'] = async () => 42;

/** Serve with only the image client varied. */
const serveImages = (images: OdooImageClient): Promise<string> => serve(ok, async () => [], images);

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

describe('GET /v1/devices/:device_id/orders', () => {
  const order = { cart_id: 'cart_1', confirmed_at: '2026-07-16T00:00:00.000Z' } as unknown as Awaited<
    ReturnType<CartController['ordersByDevice']>
  >[number];

  it('returns the orders as a JSON array', async () => {
    const base = await serve(ok, async () => [order]);

    const res = await fetch(`${base}/v1/devices/dev_a/orders`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual([order]);
  });

  it('answers 200 with an empty array for a device with no orders', async () => {
    const base = await serve(ok, async () => []);

    const res = await fetch(`${base}/v1/devices/dev_none/orders`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('passes the decoded device_id to the controller', async () => {
    const seen: string[] = [];
    const base = await serve(ok, async (device_id) => {
      seen.push(device_id);
      return [];
    });

    await fetch(`${base}/v1/devices/dev%20A/orders`);

    expect(seen).toEqual(['dev A']);
  });

  it('answers 400 for a malformed %-escape instead of crashing the process', async () => {
    const base = await serve(ok);

    const res = await fetch(`${base}/v1/devices/%/orders`);

    expect(res.status).toBe(400);
  });

  it('answers 500 when the controller throws', async () => {
    const base = await serve(ok, async () => {
      throw new Error('redis down');
    });

    const res = await fetch(`${base}/v1/devices/dev_a/orders`);

    expect(res.status).toBe(500);
  });

  it('does not route POST on the orders path', async () => {
    const base = await serve(ok, async () => [order]);

    expect((await fetch(`${base}/v1/devices/dev_a/orders`, { method: 'POST' })).status).toBe(404);
  });
});

describe('GET /web/image/... (Odoo image proxy)', () => {
  const IMAGE = '/web/image/product.template/42/image_512';

  /** Captures the (path, if-none-match) the router asked for. */
  function recorder(): { calls: Array<[string, string | undefined]>; client: OdooImageClient } {
    const calls: Array<[string, string | undefined]> = [];
    return {
      calls,
      client: {
        fetchImage: async (path, ifNoneMatch) => {
          calls.push([path, ifNoneMatch]);
          return { notModified: false, bytes: PNG, contentType: 'image/png' };
        },
      },
    };
  }

  it('returns the bytes with the upstream content-type', async () => {
    const base = await serveImages(stubImages);

    const res = await fetch(`${base}${IMAGE}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-length')).toBe('4');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
  });

  it('forwards the upstream etag and cache-control', async () => {
    const base = await serveImages({
      fetchImage: async () => ({
        notModified: false,
        bytes: PNG,
        contentType: 'image/png',
        etag: '"abc"',
        cacheControl: 'max-age=31536000, private, immutable',
      }),
    });

    const res = await fetch(`${base}${IMAGE}`);

    expect(res.headers.get('etag')).toBe('"abc"');
    expect(res.headers.get('cache-control')).toBe('max-age=31536000, private, immutable');
  });

  it('passes the path and query string through unchanged', async () => {
    const rec = recorder();
    const base = await serveImages(rec.client);

    await fetch(`${base}${IMAGE}?unique=abc123`);

    expect(rec.calls).toEqual([[`${IMAGE}?unique=abc123`, undefined]]);
  });

  it('normalizes the path so `..` cannot walk out of /web/image/', async () => {
    const rec = recorder();
    const base = await serveImages(rec.client);

    // Encoded so fetch() forwards it verbatim instead of resolving it client-side.
    const res = await fetch(`${base}/web/image/%2E%2E/%2E%2E/web/session/authenticate`);

    // Normalized to /web/session/authenticate, which no longer matches the prefix.
    expect(res.status).toBe(404);
    expect(rec.calls).toEqual([]);
  });

  it('forwards if-none-match and relays a 304 with no body', async () => {
    const rec = {
      calls: [] as Array<string | undefined>,
      client: {
        fetchImage: async (_p: string, ifNoneMatch?: string) => {
          rec.calls.push(ifNoneMatch);
          return { notModified: true as const };
        },
      },
    };
    const base = await serveImages(rec.client);

    const res = await fetch(`${base}${IMAGE}`, { headers: { 'if-none-match': '"abc"' } });

    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
    expect(rec.calls).toEqual(['"abc"']);
  });

  it('answers 502 with Odoo’s message when the fetch fails', async () => {
    const base = await serveImages({
      fetchImage: async () => {
        throw new OdooError('odoo image returned a non-image response (text/html)');
      },
    });

    const res = await fetch(`${base}${IMAGE}`);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'odoo image returned a non-image response (text/html)' });
  });

  it('answers 500 for an unexpected failure', async () => {
    const base = await serveImages({
      fetchImage: async () => {
        throw new Error('boom');
      },
    });

    expect((await fetch(`${base}${IMAGE}`)).status).toBe(500);
  });

  it('does not route other Odoo paths', async () => {
    const rec = recorder();
    const base = await serveImages(rec.client);

    expect((await fetch(`${base}/web/session/authenticate`)).status).toBe(404);
    expect((await fetch(`${base}/web/image`)).status).toBe(404);
    expect(rec.calls).toEqual([]);
  });

  it('does not route POST on the image path', async () => {
    const base = await serveImages(stubImages);

    expect((await fetch(`${base}${IMAGE}`, { method: 'POST' })).status).toBe(404);
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
