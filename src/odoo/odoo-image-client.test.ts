import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpOdooImageClient } from './odoo-image-client.js';
import { OdooError } from './odoo-client.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

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

function urlOf(f: ReturnType<typeof vi.fn>): string {
  return (f.mock.calls[0] as [string, RequestInit])[0];
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

  it('forwards the upstream cache-control verbatim', async () => {
    stubFetch(PNG, {
      status: 200,
      headers: { 'content-type': 'image/png', 'cache-control': 'max-age=31536000, private, immutable' },
    });

    const image = await client().fetchImage('/web/image/product.template/42/image_512?unique=abc');

    expect(image).toMatchObject({ cacheControl: 'max-age=31536000, private, immutable' });
  });

  it('refuses a path outside /web/image/ — this is not a general Odoo proxy', async () => {
    // Our database header must never ride along to an RPC or session route.
    const f = stubFetch(PNG);

    await expect(client().fetchImage('/web/session/authenticate')).rejects.toBeInstanceOf(OdooError);
    expect(f).not.toHaveBeenCalled();
  });

  it('returns the bytes, the upstream content-type and the upstream etag', async () => {
    stubFetch(PNG, { status: 200, headers: { 'content-type': 'image/webp', etag: '"abc"' } });

    const image = await client().fetchImage('/web/image/product.template/42/image_128');

    expect(image).toEqual({ notModified: false, bytes: PNG, contentType: 'image/webp', etag: '"abc"' });
  });

  it('omits etag entirely when upstream sent none', async () => {
    stubFetch(PNG);

    const image = await client().fetchImage('/web/image/product.template/42/image_128');

    expect(image).not.toHaveProperty('etag');
  });

  it('names the database in a header — the route 404s without it on a multi-db host', async () => {
    const f = stubFetch(PNG);

    await client().fetchImage('/web/image/product.template/42/image_128');

    expect(headersOf(f)['x-odoo-database']).toBe('jadegarden1');
  });

  it('omits the database header when unconfigured (a dbfilter or single-db instance)', async () => {
    const f = stubFetch(PNG);

    await client('').fetchImage('/web/image/product.template/42/image_128');

    expect(headersOf(f)).not.toHaveProperty('x-odoo-database');
  });

  it('sends no Authorization: /web/image is a public route, and the key unlocks nothing here', async () => {
    const f = stubFetch(PNG);

    await client().fetchImage('/web/image/product.template/42/image_128');

    expect(headersOf(f)).not.toHaveProperty('authorization');
  });

  it('forwards if-none-match and reports a 304 as notModified', async () => {
    const f = stubFetch(null, { status: 304 });

    const image = await client().fetchImage('/web/image/product.template/42/image_128', '"abc"');

    expect(headersOf(f)['if-none-match']).toBe('"abc"');
    expect(image).toEqual({ notModified: true });
  });

  it('omits if-none-match when the caller sent none', async () => {
    const f = stubFetch(PNG);

    await client().fetchImage('/web/image/product.template/42/image_128');

    expect(headersOf(f)).not.toHaveProperty('if-none-match');
  });

  it('rejects an HTML body on a 200 — this is Odoo\'s "No database is selected" page', async () => {
    // The failure mode a wrong ODOO_API_DATABASE produces. Without this check the markup
    // would reach the browser as a broken image instead of a diagnosable 502.
    stubFetch('<html>No database is selected.</html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });

    await expect(client().fetchImage('/web/image/product.template/42/image_128')).rejects.toBeInstanceOf(OdooError);
  });

  it('rejects a response with no content-type at all', async () => {
    stubFetch(PNG, { status: 200, headers: {} });

    await expect(client().fetchImage('/web/image/product.template/42/image_128')).rejects.toThrow(/non-image/);
  });

  it('rejects a non-2xx status', async () => {
    stubFetch('not found', { status: 404, headers: { 'content-type': 'text/html' } });

    await expect(client().fetchImage('/web/image/product.template/42/image_128')).rejects.toThrow(/http 404/);
  });

  it('rejects an oversize image declared by content-length, without reading the body', async () => {
    stubFetch(PNG, {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(6 * 1024 * 1024) },
    });

    await expect(client().fetchImage('/web/image/product.template/42/image_128')).rejects.toThrow(/too large/);
  });

  it('rejects an oversize body even when content-length lied', async () => {
    stubFetch(Buffer.alloc(6 * 1024 * 1024), {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': '4' },
    });

    await expect(client().fetchImage('/web/image/product.template/42/image_128')).rejects.toThrow(/too large/);
  });

  it('wraps a transport failure as OdooError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    await expect(client().fetchImage('/web/image/product.template/42/image_128')).rejects.toBeInstanceOf(OdooError);
  });

  it('strips a trailing slash from the base URL', async () => {
    const f = stubFetch(PNG);

    await new HttpOdooImageClient('http://odoo.test/', 'db').fetchImage('/web/image/product.template/7/image_128');

    expect(urlOf(f)).toBe('http://odoo.test/web/image/product.template/7/image_128');
  });
});
