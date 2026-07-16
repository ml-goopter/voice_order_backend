import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CartController } from '../cart/cart-controller.js';
import { healthCheck } from './health.routes.js';
import { NotFoundError, errorMeta, messageOf } from '../shared/errors.js';
import { OdooError } from '../odoo/odoo-client.js';
import { logger } from '../config/logger.js';

/** POST /v1/carts/:cart_id/confirm */
const CONFIRM_ROUTE = /^\/v1\/carts\/([^/]+)\/confirm$/;

/**
 * The app's whole REST surface: `/health` plus one confirm route. Hand-rolled on the
 * existing node:http server — two routes do not justify a framework in a WebSocket-first
 * app, where everything else rides on `/ws`.
 *
 * Unlike the Odoo far side, which answers HTTP 200 even on failure (SPEC § "Found during
 * implementation"), this router returns honest status codes. That asymmetry is deliberate:
 * do not propagate their JSON-RPC convention outward.
 */
export function createHttpRouter(cart: CartController) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(healthCheck()));
      return;
    }

    const match = req.method === 'POST' ? CONFIRM_ROUTE.exec(pathOf(req.url)) : null;
    if (match) {
      // TODO: authenticate the caller. Nothing does today — the same stub posture as
      // session-auth.ts, where cart_id on the /ws upgrade is equally unauthenticated.
      // This is not a security boundary; treat it as one only once /ws is one too.
      // Decode inside confirmCart's try: a malformed %-escape must answer 400, not throw
      // synchronously out of the request listener (an uncaught error there crashes the process).
      void confirmCart(cart, match[1]!, res);
      return;
    }

    res.writeHead(404).end();
  };
}

/**
 * No request body: the cart already knows its table, and confirm takes no arguments.
 * `raw_cart_id` is the still-encoded path segment; decoding is the first thing inside the
 * try so a bad %-escape becomes a 400 instead of an uncaught URIError.
 */
async function confirmCart(cart: CartController, raw_cart_id: string, res: ServerResponse): Promise<void> {
  let cart_id: string;
  try {
    cart_id = decodeURIComponent(raw_cart_id);
  } catch {
    sendError(res, 400, 'malformed cart_id in path');
    return;
  }
  try {
    // The pos_order_id is persisted on the cart but deliberately not returned: the frontend
    // clears its cart view on the 200 and has no use for it.
    await cart.confirm(cart_id);
    res.writeHead(200).end();
  } catch (err) {
    if (err instanceof NotFoundError) {
      sendError(res, 404, err.message);
      return;
    }
    if (err instanceof OdooError) {
      // 502: we reached a bad gateway, or it refused us. Odoo's own message goes back so a
      // "no open session" (a POS session still in opening_control) is diagnosable, not opaque.
      logger.warn('cart.confirm_odoo_failed', { cart_id, ...errorMeta(err) });
      sendError(res, 502, err.message);
      return;
    }
    logger.error('cart.confirm_failed', { cart_id, ...errorMeta(err) });
    sendError(res, 500, messageOf(err));
  }
}

function sendError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

/** Strip the query string; `req.url` is a path-with-query, and routes match on the path. */
function pathOf(url: string | undefined): string {
  return new URL(url ?? '/', 'http://localhost').pathname;
}
