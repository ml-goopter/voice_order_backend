import { config } from '../config/env.js';
import { messageOf } from '../shared/errors.js';
import { OdooError } from './odoo-client.js';

const REQUEST_TIMEOUT_MS = 10_000;
/** Guard, not a real limit: menu photos are well under a megabyte. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** The only Odoo path this client will fetch. Anything else is a caller bug, not a proxy target. */
export const IMAGE_PATH_PREFIX = '/web/image/';

export type ProxiedImage =
  | { notModified: true }
  | {
      notModified: false;
      bytes: Buffer;
      contentType: string;
      /** Forwarded verbatim so the client's caching matches talking to Odoo directly. */
      etag?: string;
      cacheControl?: string;
    };

export interface OdooImageClient {
  /** `path` is an Odoo `/web/image/...` path plus query string, passed through unchanged. */
  fetchImage(path: string, ifNoneMatch?: string): Promise<ProxiedImage>;
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

  async fetchImage(path: string, ifNoneMatch?: string): Promise<ProxiedImage> {
    // Never a general-purpose Odoo proxy: only the public image route, so a path built from a
    // request can't reach /web/session or an RPC endpoint with our database header attached.
    if (!path.startsWith(IMAGE_PATH_PREFIX)) {
      throw new OdooError(`refusing to proxy a non-image path: ${path}`);
    }
    const url = `${this.baseUrl.replace(/\/+$/, '')}${path}`;

    let res: Response;
    try {
      res = await fetch(url, {
        // No Authorization header: /web/image is a public route, so the bearer API key is
        // neither required nor a way to unlock the larger sizes.
        headers: {
          // Omitted when empty — an instance with a dbfilter (or a single db) resolves itself.
          ...(this.database !== '' ? { 'x-odoo-database': this.database } : {}),
          ...(ifNoneMatch !== undefined ? { 'if-none-match': ifNoneMatch } : {}),
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new OdooError(`odoo image request failed: ${messageOf(err)}`);
    }

    if (res.status === 304) return { notModified: true };
    if (!res.ok) throw new OdooError(`odoo image returned http ${res.status}`);

    const contentType = res.headers.get('content-type') ?? '';
    // "No database is selected" arrives as an HTML page, not an error status. Anything that is
    // not an image means we asked wrong, so it must surface as a 502 rather than reach the
    // client as markup rendered into a broken image.
    if (!contentType.startsWith('image/')) {
      throw new OdooError(`odoo image returned a non-image response (${contentType || 'no content-type'})`);
    }

    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      throw new OdooError(`odoo image is too large (${declared} bytes)`);
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      throw new OdooError(`odoo image body failed to read: ${messageOf(err)}`);
    }
    // content-length may be absent or wrong under chunked transfer; re-check what arrived.
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new OdooError(`odoo image is too large (${bytes.length} bytes)`);
    }

    const etag = res.headers.get('etag');
    const cacheControl = res.headers.get('cache-control');
    return {
      notModified: false,
      bytes,
      contentType,
      ...(etag !== null ? { etag } : {}),
      ...(cacheControl !== null ? { cacheControl } : {}),
    };
  }
}
