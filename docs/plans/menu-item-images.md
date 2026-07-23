# Menu item images — Odoo image proxy (plan)

Status: **implemented**. Scope: `src/odoo/`, `src/api/`, `src/app.ts`.

## 1. Problem

The frontend holds `product_tmpl_id` already (`CartLine`, and `ReplyItem` per
`docs/plans/reply-search-results.md`). Odoo serves the bytes at
`/web/image/product.template/<id>/image_512`, but a browser cannot use that URL: this host serves
7 databases with no `dbfilter`, so the route 404s with *"No database is selected."* `?db=` does not
work — the db must arrive as the `X-Odoo-Database` header, which an `<img src>` cannot send
(`docs/menu_restaurant_schema.md` § Item images).

Goal: the same Odoo URL, served from our origin, with that one header added.

## 2. Design decisions

**A transparent proxy, not an image API.** The client sends us the exact path it would send Odoo —
`/web/image/product.template/42/image_512?unique=…` — and we forward it unchanged, adding only
`X-Odoo-Database`. Path, query string, `Content-Type`, `ETag` and `Cache-Control` all pass through
in both directions. Nothing is invented, nothing is renamed, and swapping to a direct Odoo origin
(or the nginx approach in §6) is a base-URL change on the client with no other edits.

**Consequences of being transparent.** Caching is Odoo's answer, not ours: without a `unique=`
token Odoo sends `no-cache, private` and every render re-downloads; with one it sends
`max-age=31536000, immutable`. The client picks. Likewise the size: `image_128` and `image_512`
return the real image anonymously, while `image_256`/`1024`/`1920` return a placeholder — the
proxy does not police that.

**Items with no image render Odoo's placeholder.** Only 27 of 380 POS items have one; Odoo answers
the rest `200 image/png` with a generic placeholder. Accepted — a 200 from this route does not mean
the item has a photo, and nothing downstream may infer that it does.

**Scoped to `/web/image/` at both ends.** The router matches the **normalized** path, so `..`
cannot walk out of the prefix, and the client re-checks it before fetching. Our database header
must never ride along to `/web/session` or an RPC route.

**No `Authorization` header.** `/web/image` is a public-auth route, not one of the `auth="bearer"`
JSON-RPC routes. `ODOO_API_KEY` is neither required nor useful here.

**Buffered, not streamed.** The images are small, and buffering keeps the status honest — an
upstream failure found mid-stream cannot become a 502 once headers are sent.

## 3. Wire contract

```
GET /web/image/<model>/<id>/<field>[?unique=…]
```

`GET` and `HEAD` only; `HEAD` answers identically minus the body.

| Status | When |
|---|---|
| 200 | bytes, with `content-type` / `etag` / `cache-control` forwarded from Odoo, plus `nosniff` and `default-src 'none'` |
| 304 | request carried `if-none-match` and Odoo answered 304; carries the validator |
| 404 | path outside `/web/image/` (including one that normalizes out, or carries an encoded separator), an unparseable target, or a method other than GET/HEAD (**not** "no image") |
| 502 | Odoo unreachable, non-2xx, non-image body, an svg, or over 5 MB |
| 500 | anything else |

Unauthenticated, like the rest of the REST surface. No CORS header — `<img src>` needs none.

## 4. Code structure

### `src/odoo/odoo-image-client.ts` (new)

```ts
export const IMAGE_PATH_PREFIX = '/web/image/';

export type ProxiedImage =
  | { notModified: true }
  | { notModified: false; bytes: Buffer; contentType: string; etag?: string; cacheControl?: string };

export interface OdooImageClient {
  fetchImage(path: string, ifNoneMatch?: string): Promise<ProxiedImage>;
}
export class HttpOdooImageClient implements OdooImageClient { … }
```

- `GET {odooApiUrl}{path}`, 10s `AbortSignal.timeout`. Rejects a `path` outside
  `IMAGE_PATH_PREFIX`.
- `x-odoo-database` set from `odooApiDatabase`, omitted when `''` — same conditional spread as
  `HttpOdooClient.call`.
- `if-none-match` forwarded; upstream 304 → `{ notModified: true }`.
- Throws `OdooError` (reused from `odoo-client.ts`, so the router's 502 mapping applies) on:
  transport failure; non-2xx other than 304; a `content-type` not starting with `image/` — **this
  is what the "No database is selected" page looks like**, and the check that turns a bad
  `ODOO_API_DATABASE` into a legible 502 instead of HTML rendered as a broken image; a body over
  `MAX_IMAGE_BYTES` (5 MB), checked on `content-length` *and* the realised length.

### `src/api/http-router.ts` (modify)

`createHttpRouter(cart: CartController, images: OdooImageClient)`. A `GET` whose normalized path
starts with `/web/image/` goes to `proxyImage`, which forwards `${url.pathname}${url.search}` and
the `if-none-match` header, then relays the response. `OdooError` → 502 logged
`odoo.image_proxy_failed`, else 500, both via the existing `sendError`.

### `src/app.ts` (modify)

`createHttpRouter(cartController, new HttpOdooImageClient())`. No new env vars.

## 5. Steps

1. **`odoo-image-client.ts` + `odoo-image-client.test.ts`.** ✅
   → Verified: path and query pass through onto the base URL; `x-odoo-database` present when
   configured, absent when `''`; no `authorization` header; a path outside `/web/image/` is
   refused without fetching; an HTML body throws `OdooError` even on a 200; a 404 throws; oversize
   `content-length` throws, and so does a lying `content-length` with an oversize body;
   `if-none-match` forwarded and a 304 → `{ notModified: true }`; happy path returns bytes plus the
   upstream `content-type` / `etag` / `cache-control`.

2. **Route + `proxyImage` in `http-router.ts`; `http-router.test.ts` updated for the new argument.** ✅
   → Verified: 200 carries `content-type` and `content-length`, and forwards `etag` /
   `cache-control`; path + query reach the client unchanged; `%2E%2E` normalizes out of the prefix
   and 404s without calling Odoo; `if-none-match` → 304 with an empty body; `OdooError` → 502;
   other throw → 500; `/web/session/authenticate` and bare `/web/image` → 404; `POST` → 404.

3. **Wire in `app.ts`.** ✅
   → Verified: `npm run typecheck` clean (not `tsc -p tsconfig.json` — it skips the test files);
   `npm test` 486 passing.

4. **End-to-end against the live dev Odoo.** ✅
   → Verified on `jadegarden1` (`product.template` 2, Bacon Burger):
   `/web/image/product.template/2/image_128` → 200 `image/png`, `etag` and 8153 bytes **byte-identical**
   to `curl -H 'X-Odoo-Database: jadegarden1' localhost:80/…`; `If-None-Match` → 304;
   `?unique=deadbeef` flips `cache-control` from `no-cache, private` to
   `max-age=31536000, private, immutable`; `/web/session/authenticate` → 404; a blank
   `ODOO_API_DATABASE` raises `OdooError` (Odoo 404s), which the route answers as 502.

6. **Adversarial review.** ✅ Ten findings fixed in a follow-up commit — normalized-path guard,
   `nosniff`/CSP, svg refusal, read-time size cap, `new URL` crash guard, 304 validator, `HEAD`,
   client-abort, case-insensitive `content-type`, strict `content-length`. Two reported findings
   did not reproduce (unknown `product_tmpl_id` → 200 placeholder, not 502; `%2f` does not escape
   on this nginx+Odoo stack) and were closed as defence-in-depth. See `log.md`.

5. **Docs.** ✅ Route in the `src/api` table in `.claude/.knowledge/platform/overview.md`; an image
   section in `.claude/.knowledge/odoo/overview.md`; option 3 of
   `docs/menu_restaurant_schema.md` § Enabling anonymous `<img src>` access now names the route
   with the placeholder caveat; `log.md` entry added.

## 6. Deferred

- **Real 404s for imageless items.** One indexed lookup on `ir_attachment`
  (`res_model='product.template' AND res_field='image_1920' AND res_id=$1`) gives presence plus a
  `checksum` version token. Check the **master** field — Odoo generates the resized derivatives
  lazily, so `image_128` may have no row for an item that has a photo. Would end the transparency,
  so it belongs behind a different path if ever built.
- **Serving `unique=` to the client.** The proxy already forwards it; nothing yet computes a token
  to put there, so images are currently `no-cache`. `product_template.write_date` is the cheap
  source, `ir_attachment.checksum` the exact one.
- **Larger sizes.** `image_1024`/`1920` need an authenticated Odoo session; applies to the nginx
  approach equally.
- **nginx alternative.** `location ~ ^/menu-image/(?<db>…)/(?<tmpl>\d+)/(?<field>…)$` with
  `proxy_set_header X-Odoo-Database $db` removes this route, at the cost of an infra change.
