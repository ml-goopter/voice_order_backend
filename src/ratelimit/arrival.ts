/**
 * Did a failed call reach the provider?
 *
 * `settle` vs. `abandon` turns entirely on this question, and the answer decides whether the
 * limiter is stricter or laxer than the quota it protects. The two errors are NOT symmetric:
 *
 * - Keeping the charge for a request that never arrived costs a little local throughput, and the
 *   bucket refills it back within the metering window.
 * - Refunding a request that DID arrive makes this limiter permanently more permissive than the
 *   provider pool — and it does so exactly when that pool is under strain, which is how a limiter
 *   manufactures the 429s it exists to prevent.
 *
 * So the rule is fail-CLOSED: **abandon only what provably never left this process.** A response
 * with any HTTP status proves arrival (a 429, a 500 and a terminal 400 were all counted by the
 * provider). A connection that could not be established — refused, unresolvable, unroutable, or
 * timed out during the socket handshake — proves the opposite, as does our own limiter refusing to
 * dispatch the call at all (`rate_limited`). Everything else —
 * an unclassified throw, an ambiguous timeout — keeps its charge, because a timeout at a
 * request-level deadline has almost always already sent the body: connect failures surface far
 * faster than the multi-second budgets these call sites use.
 */

/** `err.code` values that mean the connection was never established, so no bytes were sent:
 *  refused, unresolvable (`ENOTFOUND`/`EAI_AGAIN`), unroutable (`EHOSTUNREACH`/`ENETUNREACH`), or
 *  timed out while opening the socket (`ERR_SOCKET_CONNECTION_TIMEOUT` — undici's CONNECT-phase
 *  timeout, distinct from its request/body timeouts). Deliberately excludes `ECONNRESET` and
 *  `ETIMEDOUT`: both also occur mid-request, after the provider has read and counted the body.
 *  `rate_limited` is our OWN limiter refusing to grant capacity — that call is not dispatched at
 *  all. Keep this list and policy §6 in step. */
const NEVER_ARRIVED_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'rate_limited',
]);

/** How far down the `cause` chain to look. `fetch` wraps the real socket error one level deep
 *  (`TypeError: fetch failed` → `cause: { code: 'ECONNREFUSED' }`) and SDKs add one or two more. */
const MAX_CAUSE_DEPTH = 5;

function isHttpStatus(v: unknown): boolean {
  return typeof v === 'number' && v >= 100 && v < 600;
}

/** True when the provider received the request (and therefore counted it against the quota).
 *  See the module comment for why the unknown case answers true. */
export function reachedProvider(err: unknown): boolean {
  let node: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (node === null || typeof node !== 'object') break;
    const e = node as { status?: unknown; statusCode?: unknown; code?: unknown; cause?: unknown };
    if (isHttpStatus(e.status) || isHttpStatus(e.statusCode)) return true;
    if (typeof e.code === 'string' && NEVER_ARRIVED_CODES.has(e.code)) return false;
    node = e.cause;
  }
  return true;
}
