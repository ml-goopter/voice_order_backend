import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
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

/**
 * Send a request line verbatim over a raw socket and resolve its status line. `fetch` normalizes
 * the target before it leaves the client, so it cannot express the malformed or encoded targets
 * these routes must survive — a test written with `fetch` would assert on a rewritten URL.
 */
function rawRequest(base: string, requestLine: string, timeoutMs = 2000): Promise<string> {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), '127.0.0.1', () => {
      socket.write(`${requestLine}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let body = '';
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`no response to ${requestLine} within ${timeoutMs}ms`));
    });
    socket.on('data', (chunk) => (body += chunk.toString()));
    socket.on('error', reject);
    socket.on('close', () => resolve(body.split('\r\n')[0] ?? ''));
  });
}

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
        fetchImage: async (path, opts) => {
          calls.push([path, opts?.ifNoneMatch]);
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

  it('marks the response un-sniffable and script-free — we serve these from our own origin', async () => {
    const base = await serveImages(stubImages);

    const res = await fetch(`${base}${IMAGE}`);

    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
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

  it('answers HEAD exactly as GET, headers and all, with no body', async () => {
    // Caches and monitors probe with HEAD; a 404 there reads as "this image does not exist".
    const base = await serveImages(stubImages);

    const res = await fetch(`${base}${IMAGE}`, { method: 'HEAD' });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-length')).toBe('4');
    expect(await res.text()).toBe('');
  });

  it('rejects `..` that a URL parser resolves out of the image prefix', async () => {
    const rec = recorder();
    const base = await serveImages(rec.client);

    expect(await rawRequest(base, 'GET /web/image/../../web/session/authenticate HTTP/1.1')).toContain('404');
    expect(rec.calls).toEqual([]);
  });

  it.each(['%2e%2e%2fweb%2fjsonrpc', '..%5cweb%5cjsonrpc', '%2E%2E/%2E%2E/web/session/authenticate'])(
    'rejects percent-encoded traversal /web/image/%s',
    async (suffix) => {
      // Sent raw: a URL parser splits only on a literal `/`, so `%2f` survives normalization and
      // whether it escapes would be decided by whoever unquotes the path downstream.
      const rec = recorder();
      const base = await serveImages(rec.client);

      expect(await rawRequest(base, `GET /web/image/${suffix} HTTP/1.1`)).toContain('404');
      expect(rec.calls).toEqual([]);
    },
  );

  it('answers a request target that is not a valid URL instead of hanging', async () => {
    // `//` is a legal request-line but an invalid URL (empty host). An uncaught TypeError in the
    // request listener would leave the socket unanswered and, under node, kill the process.
    const base = await serveImages(stubImages);

    expect(await rawRequest(base, 'GET // HTTP/1.1')).toContain('404');
  });

  it('forwards if-none-match and relays a 304 carrying the validator', async () => {
    // A 304 without the validator leaves the browser's stored entry unrefreshed, so it
    // revalidates on every render forever (RFC 9110 §15.4.5).
    const rec = {
      calls: [] as Array<string | undefined>,
      client: {
        fetchImage: async (_p: string, opts?: { ifNoneMatch?: string | undefined }) => {
          rec.calls.push(opts?.ifNoneMatch);
          return { notModified: true as const, etag: '"abc"', cacheControl: 'max-age=60' };
        },
      },
    };
    const base = await serveImages(rec.client);

    const res = await fetch(`${base}${IMAGE}`, { headers: { 'if-none-match': '"abc"' } });

    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe('"abc"');
    expect(res.headers.get('cache-control')).toBe('max-age=60');
    expect(await res.text()).toBe('');
    expect(rec.calls).toEqual(['"abc"']);
  });

  it('hands the client an abort signal so a hang-up cancels the upstream fetch', async () => {
    let signal: AbortSignal | undefined;
    const base = await serveImages({
      fetchImage: async (_p, opts) => {
        signal = opts?.signal;
        return { notModified: false, bytes: PNG, contentType: 'image/png' };
      },
    });

    await fetch(`${base}${IMAGE}`);

    expect(signal).toBeInstanceOf(AbortSignal);
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
