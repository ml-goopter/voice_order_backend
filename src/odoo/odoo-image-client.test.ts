import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpOdooImageClient } from './odoo-image-client.js';
import { OdooError } from './odoo-client.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const IMAGE = '/web/image/product.template/42/image_128';

/** Stub `fetch` with one canned response. */
function stubFetch(
  body: Buffer | string | null,
  init: ResponseInit = { status: 200, headers: { 'content-type': 'image/png' } },
): ReturnType<typeof vi.fn> {
  const f = vi.fn(async () => new Response(body, init));
  vi.stubGlobal('fetch', f);
  return f;
}

function client(database = 'jadegarden1'): HttpOdooImageClient {
  return new HttpOdooImageClient('http://odoo.test', database);
}

/**
 * What `fetch` was actually asked for, resolved the way `fetch` itself would resolve it. Asserting
 * on the raw argument would hide a path that passes a string check and then normalizes elsewhere.
 */
function urlOf(f: ReturnType<typeof vi.fn>): string {
  const arg = (f.mock.calls[0] as [string | URL, RequestInit])[0];
  return new URL(arg).toString();
}

function headersOf(f: ReturnType<typeof vi.fn>): Record<string, string> {
  return (f.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>;
}

afterEach(() => vi.unstubAllGlobals());

describe('HttpOdooImageClient.fetchImage', () => {
  it('passes the path through unchanged onto the configured base URL', async () => {
    const f = stubFetch(PNG);

    await client().fetchImage('/web/image/product.template/42/image_512');

    expect(urlOf(f)).toBe('http://odoo.test/web/image/product.template/42/image_512');
  });

  it('passes the query string through — `unique=` is what makes Odoo answer cacheably', async () => {
    const f = stubFetch(PNG);

    await client().fetchImage('/web/image/product.template/42/image_512?unique=abc123');

    expect(urlOf(f)).toBe('http://odoo.test/web/image/product.template/42/image_512?unique=abc123');
  });

  it('returns the bytes, the upstream content-type and the upstream etag', async () => {
    stubFetch(PNG, { status: 200, headers: { 'content-type': 'image/webp', etag: '"abc"' } });

    const image = await client().fetchImage(IMAGE);

    expect(image).toEqual({ notModified: false, bytes: PNG, contentType: 'image/webp', etag: '"abc"' });
  });

  it('forwards the upstream cache-control verbatim', async () => {
    stubFetch(PNG, {
      status: 200,
      headers: { 'content-type': 'image/png', 'cache-control': 'max-age=31536000, private, immutable' },
    });

    const image = await client().fetchImage(`${IMAGE}?unique=abc`);

    expect(image).toMatchObject({ cacheControl: 'max-age=31536000, private, immutable' });
  });

  it('omits etag entirely when upstream sent none', async () => {
    stubFetch(PNG);

    expect(await client().fetchImage(IMAGE)).not.toHaveProperty('etag');
  });

  it('names the database in a header — the route 404s without it on a multi-db host', async () => {
    const f = stubFetch(PNG);

    await client().fetchImage(IMAGE);

    expect(headersOf(f)['x-odoo-database']).toBe('jadegarden1');
  });

  it('omits the database header when unconfigured (a dbfilter or single-db instance)', async () => {
    const f = stubFetch(PNG);

    await client('').fetchImage(IMAGE);

    expect(headersOf(f)).not.toHaveProperty('x-odoo-database');
  });

  it('sends no Authorization: /web/image is a public route, and the key unlocks nothing here', async () => {
    const f = stubFetch(PNG);

    await client().fetchImage(IMAGE);

    expect(headersOf(f)).not.toHaveProperty('authorization');
  });

  it('strips a trailing slash from the base URL', async () => {
    const f = stubFetch(PNG);

    await new HttpOdooImageClient('http://odoo.test/', 'db').fetchImage('/web/image/product.template/7/image_128');

    expect(urlOf(f)).toBe('http://odoo.test/web/image/product.template/7/image_128');
  });
});

describe('HttpOdooImageClient path guard', () => {
  it('refuses a path outside /web/image/ — this is not a general Odoo proxy', async () => {
    const f = stubFetch(PNG);

    await expect(client().fetchImage('/web/session/authenticate')).rejects.toBeInstanceOf(OdooError);
    expect(f).not.toHaveBeenCalled();
  });

  it.each([
    ['/web/image/../../web/session/authenticate', 'traversal that a URL parser resolves away'],
    ['/web/image/./../jsonrpc', 'a dot segment before the escape'],
  ])('refuses %s (%s)', async (path) => {
    // The guard has to run on the NORMALIZED path: `fetch` resolves `..` itself, so a raw
    // startsWith() would pass this and then send our database header to an RPC route.
    const f = stubFetch(PNG);

    await expect(client().fetchImage(path)).rejects.toThrow(/non-image path/);
    expect(f).not.toHaveBeenCalled();
  });

  it.each(['/web/image/%2e%2e%2fweb%2fjsonrpc', '/web/image/..%5cweb%5cjsonrpc'])(
    'refuses percent-encoded traversal %s',
    async (path) => {
      // A URL parser splits only on a literal `/`, so these survive normalization intact and
      // whether they escape is decided by whoever unquotes the path downstream.
      const f = stubFetch(PNG);

      await expect(client().fetchImage(path)).rejects.toThrow(/non-image path/);
      expect(f).not.toHaveBeenCalled();
    },
  );

  it('refuses a protocol-relative path that would leave the host', async () => {
    const f = stubFetch(PNG);

    await expect(client().fetchImage('//evil.test/web/image/x')).rejects.toThrow(/off-host/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('HttpOdooImageClient failure handling', () => {
  it('rejects an HTML body on a 200 — this is Odoo\'s "No database is selected" page', async () => {
    // The failure mode a wrong ODOO_API_DATABASE produces. Without this check the markup
    // would reach the browser as a broken image instead of a diagnosable 502.
    stubFetch('<html>No database is selected.</html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });

    await expect(client().fetchImage(IMAGE)).rejects.toBeInstanceOf(OdooError);
  });

  it('rejects an svg — it is script-capable and we would serve it from our own origin', async () => {
    stubFetch('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', {
      status: 200,
      headers: { 'content-type': 'image/svg+xml' },
    });

    await expect(client().fetchImage(IMAGE)).rejects.toThrow(/svg/);
  });

  it('accepts a content-type whatever its case or parameters — media types are case-insensitive', async () => {
    stubFetch(PNG, { status: 200, headers: { 'content-type': 'Image/PNG; charset=binary' } });

    expect(await client().fetchImage(IMAGE)).toMatchObject({ notModified: false, bytes: PNG });
  });

  it('rejects a response with no content-type at all', async () => {
    stubFetch(PNG, { status: 200, headers: {} });

    await expect(client().fetchImage(IMAGE)).rejects.toThrow(/non-image/);
  });

  it('rejects a non-2xx status', async () => {
    stubFetch('not found', { status: 404, headers: { 'content-type': 'text/html' } });

    await expect(client().fetchImage(IMAGE)).rejects.toThrow(/http 404/);
  });

  it('wraps a transport failure as OdooError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    await expect(client().fetchImage(IMAGE)).rejects.toBeInstanceOf(OdooError);
  });
});

describe('HttpOdooImageClient conditional requests', () => {
  it('forwards if-none-match and reports a 304 as notModified', async () => {
    const f = stubFetch(null, { status: 304 });

    const image = await client().fetchImage(IMAGE, { ifNoneMatch: '"abc"' });

    expect(headersOf(f)['if-none-match']).toBe('"abc"');
    expect(image).toEqual({ notModified: true });
  });

  it('carries the validator on a 304 — without it the browser can never refresh freshness', async () => {
    stubFetch(null, { status: 304, headers: { etag: '"abc"', 'cache-control': 'max-age=60' } });

    expect(await client().fetchImage(IMAGE, { ifNoneMatch: '"abc"' })).toEqual({
      notModified: true,
      etag: '"abc"',
      cacheControl: 'max-age=60',
    });
  });

  it('omits if-none-match when the caller sent none', async () => {
    const f = stubFetch(PNG);

    await client().fetchImage(IMAGE);

    expect(headersOf(f)).not.toHaveProperty('if-none-match');
  });
});

describe('HttpOdooImageClient size cap', () => {
  it('rejects an oversize image declared by content-length, without reading the body', async () => {
    let bodyRead = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          bodyRead = true;
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      },
      // highWaterMark 0, or the stream eagerly pulls one chunk at construction and the
      // assertion below would be true no matter what the client did.
      new CountQueuingStrategy({ highWaterMark: 0 }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(body, {
            status: 200,
            headers: { 'content-type': 'image/png', 'content-length': String(6 * 1024 * 1024) },
          }),
      ),
    );

    // The declared size is in the message: it threw on the header, before touching the body.
    await expect(client().fetchImage(IMAGE)).rejects.toThrow(`too large (${6 * 1024 * 1024} bytes)`);
    expect(bodyRead).toBe(false);
  });

  it('stops reading an oversize body partway instead of buffering it whole', async () => {
    // The cap has to bind while reading: content-length may be absent or a lie, and
    // arrayBuffer() would allocate all 40 MB before anyone could object.
    const CHUNK = new Uint8Array(1024 * 1024);
    let produced = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += CHUNK.byteLength;
        controller.enqueue(CHUNK);
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'image/png' } })),
    );

    await expect(client().fetchImage(IMAGE)).rejects.toThrow(/too large/);
    // Bounded by the cap (5 MB) plus whatever the stream had already queued — nowhere near
    // the unbounded body the producer would happily have kept emitting.
    expect(produced).toBeLessThan(10 * 1024 * 1024);
  });

  it.each(['1e400', '0x10', '100, 100', 'abc', '-1', ''])(
    'ignores an unusable content-length (%s) and relies on the read cap',
    async (len) => {
      stubFetch(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': len } });

      // Never throws "too large" on a 4-byte body, whatever the header claimed.
      expect(await client().fetchImage(IMAGE)).toMatchObject({ bytes: PNG });
    },
  );
});

describe('HttpOdooImageClient abort', () => {
  it("passes the caller's signal through, so a client hang-up cancels the upstream fetch", async () => {
    const f = vi.fn(async (_url: string | URL, init: RequestInit) => {
      init.signal?.throwIfAborted();
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    });
    vi.stubGlobal('fetch', f);
    const abort = new AbortController();
    abort.abort();

    await expect(client().fetchImage(IMAGE, { signal: abort.signal })).rejects.toBeInstanceOf(OdooError);
  });
});
