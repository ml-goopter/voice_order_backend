import { config } from '../config/env.js';
import { messageOf } from '../shared/errors.js';
import { OdooError } from './odoo-client.js';

const REQUEST_TIMEOUT_MS = 10_000;
/** Hard ceiling on a proxied image. Enforced while reading, so an oversize body is never buffered. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** The only Odoo path this client will fetch. Anything else is a caller bug, not a proxy target. */
export const IMAGE_PATH_PREFIX = '/web/image/';

/**
 * Percent-encoded path separators and dot segments. A URL parser resolves `..` but splits only on
 * a literal `/`, so these survive normalization and are decided by whatever unquotes the path on
 * the far side. No real image path contains them; refuse rather than delegate the question.
 */
const ENCODED_TRAVERSAL = /%2e|%2f|%5c|\\/i;

/** Script-capable, and we serve it from our own origin. Never proxied. */
const SVG_MEDIA_TYPE = 'image/svg+xml';

/** Response headers worth relaying to the browser. Present on a 304 too — RFC 9110 §15.4.5. */
interface ImageCacheHeaders {
  etag?: string;
  cacheControl?: string;
}

export type ProxiedImage =
  | ({ notModified: true } & ImageCacheHeaders)
  | ({ notModified: false; bytes: Buffer; contentType: string } & ImageCacheHeaders);

export interface FetchImageOptions {
  ifNoneMatch?: string | undefined;
  /** Aborts the upstream fetch when the client hangs up, so a dropped `<img>` stops costing us. */
  signal?: AbortSignal | undefined;
}

export interface OdooImageClient {
  /** `path` is an Odoo `/web/image/...` path plus query string, passed through unchanged. */
  fetchImage(path: string, opts?: FetchImageOptions): Promise<ProxiedImage>;
}

/**
 * Fetches Odoo's public `/web/image` route on the browser's behalf, adding the one thing an
 * `<img src>` cannot send: `X-Odoo-Database`. Without that header a multi-database host with no
 * `dbfilter` answers "No database is selected" (docs/menu_restaurant_schema.md § Item images).
 *
 * A transparent proxy: the path, the query string (`unique=`), and the cache headers all pass
 * through, so a caller can address an image exactly as it would address Odoo. Sibling to
 * `odoo-client.ts` — same host, different protocol (plain GET, not JSON-RPC), sharing only
 * `OdooError`.
 *
 * An item with no image is NOT an error: Odoo answers 200 with a generic placeholder, which is
 * indistinguishable over HTTP. A 200 here does not mean the item has a photo.
 */
export class HttpOdooImageClient implements OdooImageClient {
  constructor(
    private readonly baseUrl: string = config.odooApiUrl,
    private readonly database: string = config.odooApiDatabase,
  ) {}

  async fetchImage(path: string, opts: FetchImageOptions = {}): Promise<ProxiedImage> {
    const url = this.resolve(path);

    let res: Response;
    try {
      res = await fetch(url, {
        // No Authorization header: /web/image is a public route, so the bearer API key is
        // neither required nor a way to unlock the larger sizes.
        headers: {
          // Omitted when empty — an instance with a dbfilter (or a single db) resolves itself.
          ...(this.database !== '' ? { 'x-odoo-database': this.database } : {}),
          ...(opts.ifNoneMatch !== undefined ? { 'if-none-match': opts.ifNoneMatch } : {}),
        },
        signal:
          opts.signal === undefined
            ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            : AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), opts.signal]),
      });
    } catch (err) {
      throw new OdooError(`odoo image request failed: ${messageOf(err)}`);
    }

    const cacheHeaders = readCacheHeaders(res);
    // Relayed with the 304 as well: a 304 that carries no validator leaves the browser's stored
    // entry unrefreshed, so it revalidates on every single render forever.
    if (res.status === 304) return { notModified: true, ...cacheHeaders };
    if (!res.ok) throw new OdooError(`odoo image returned http ${res.status}`);

    const contentType = res.headers.get('content-type') ?? '';
    // Media types are case-insensitive (RFC 9110 §8.3.1) and may carry parameters.
    const mediaType = (contentType.split(';')[0] ?? '').trim().toLowerCase();
    // "No database is selected" arrives as an HTML page, not an error status. Anything that is
    // not an image means we asked wrong, so it must surface as a 502 rather than reach the
    // client as markup rendered into a broken image.
    if (!mediaType.startsWith('image/')) {
      throw new OdooError(`odoo image returned a non-image response (${contentType || 'no content-type'})`);
    }
    // An SVG is a script: served from our origin it would be stored XSS, whatever Odoo intended.
    if (mediaType === SVG_MEDIA_TYPE) {
      throw new OdooError('refusing to proxy an svg image');
    }

    const declared = contentLengthOf(res);
    if (declared !== undefined && declared > MAX_IMAGE_BYTES) {
      throw new OdooError(`odoo image is too large (${declared} bytes)`);
    }

    return { notModified: false, bytes: await readCapped(res), contentType, ...cacheHeaders };
  }

  /**
   * The absolute URL to fetch, or a throw. The prefix is checked on the **normalized** path:
   * `fetch` resolves `..` itself, so a raw-string check would pass `/web/image/../../web/jsonrpc`
   * and then send our database header to an RPC route.
   */
  private resolve(path: string): URL {
    const base = new URL(this.baseUrl.replace(/\/+$/, ''));
    let url: URL;
    try {
      url = new URL(path, base);
    } catch {
      throw new OdooError(`refusing to proxy an unparseable path: ${path}`);
    }
    // Catches a protocol-relative (`//evil.test/x`) or absolute path that would leave the host.
    if (url.origin !== base.origin) {
      throw new OdooError(`refusing to proxy off-host: ${path}`);
    }
    if (!url.pathname.startsWith(IMAGE_PATH_PREFIX) || ENCODED_TRAVERSAL.test(url.pathname)) {
      throw new OdooError(`refusing to proxy a non-image path: ${path}`);
    }
    return url;
  }
}

function readCacheHeaders(res: Response): ImageCacheHeaders {
  const etag = res.headers.get('etag');
  const cacheControl = res.headers.get('cache-control');
  return { ...(etag !== null ? { etag } : {}), ...(cacheControl !== null ? { cacheControl } : {}) };
}

/**
 * The declared body size, or undefined when it is absent or unusable. Deliberately strict: a
 * duplicated header arrives joined ("100, 100"), and `Number()` would read "0x10" as 16 and
 * "1e400" as Infinity — each a way to slip past the pre-check.
 */
function contentLengthOf(res: Response): number | undefined {
  const raw = res.headers.get('content-length')?.trim();
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

/**
 * The body, refusing to hold more than `MAX_IMAGE_BYTES`. Read chunk by chunk rather than via
 * `arrayBuffer()`, which would allocate the whole body first and only then discover it is
 * oversize — the cap has to bind before the memory is spent, since `content-length` may be
 * absent or wrong.
 */
async function readCapped(res: Response): Promise<Buffer> {
  if (res.body === null) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await res.body.cancel().catch(() => {});
        throw new OdooError(`odoo image is too large (over ${MAX_IMAGE_BYTES} bytes)`);
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (err) {
    if (err instanceof OdooError) throw err;
    throw new OdooError(`odoo image body failed to read: ${messageOf(err)}`);
  }
  return Buffer.concat(chunks);
}
