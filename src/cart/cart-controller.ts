import type { EventBus } from '../events/event-bus.js';
import type { CartCache } from '../redis/cart-cache.js';
import type { MenuService } from '../menu/menu-service.js';
import type { CartRepository } from './cart-repository.js';
import type { OrderProposal } from '../contracts/proposal.js';
import type { CartId, PosOrderId, SessionId } from '../shared/types.js';
import type { ClientConnected } from '../events/event-types.js';
import type { CartOperation } from '../contracts/cart-operation.schema.js';
import { KeyedAsyncLock } from '../shared/async-lock.js';
import { CartRejectedError, NotFoundError, errorMeta } from '../shared/errors.js';
import { emptyCart } from './cart-types.js';
import type { Cart } from './cart-types.js';
import { applyOperation } from './cart-operation-applier.js';
import { applyQuoteToCart } from './apply-quote.js';
import { logger } from '../config/logger.js';

/**
 * The ONLY writer of cart state (design §9). Tier-2 guard: a per-cart apply lock
 * makes the batch atomic, and each op is re-validated against the CURRENT cart
 * (rebase) rather than the possibly-stale base_version. add_item always applies;
 * a stale edit is rejected per-op with cart.operation_rejected — the rest apply.
 */
export class CartController {
  private readonly applyLock = new KeyedAsyncLock();

  constructor(
    private readonly carts: CartCache,
    private readonly menu: MenuService,
    private readonly repo: CartRepository,
    private readonly bus: EventBus,
  ) {}

  /**
   * Create the cart with its durable identity stamped, before any ordering happens
   * (bound to `client.connected`). Identity is set-once: a reconnect — or, per design
   * §"Concurrency on a shared cart", a second device joining — must never rewrite it,
   * because `device_id` means the device that CREATED the cart.
   */
  async ensureCart(e: ClientConnected): Promise<void> {
    await this.applyLock.run(e.cart_id, async () => {
      if (await this.carts.get(e.cart_id)) return;
      await this.repo.commitCreated(
        emptyCart(e.cart_id, e.pos_config_id, {
          device_id: e.device_id,
          ...(e.table_id !== undefined ? { table_id: e.table_id } : {}),
        }),
      );
    });
  }

  async applyProposal(proposal: OrderProposal, session_id?: SessionId): Promise<void> {
    await this.applyLock.run(proposal.cart_id, async () => {
      const log = logger.child({ cart_id: proposal.cart_id, request_id: proposal.request_id });
      const rejected: Array<{ op: CartOperation; error: CartRejectedError }> = [];
      let updatedCart: Cart | undefined;

      try {
        // Idempotency — never apply the same request twice (§9/§11).
        if (await this.repo.wasProcessed(proposal.request_id)) {
          log.info('cart.duplicate_request');
          return;
        }

        let cart = (await this.carts.get(proposal.cart_id)) ?? emptyCart(proposal.cart_id, proposal.pos_config_id);
        if (proposal.base_version !== cart.version) {
          log.info('cart.rebase', { base: proposal.base_version, current: cart.version });
        }

        if (cart.confirmed_at) {
          // Confirmation lock: the order is at the kitchen, so nothing may change it.
          // Ordering is load-bearing — this sits AFTER the idempotency check so a replayed
          // request stays a silent no-op rather than a spurious rejection, and BEFORE the op
          // loop so nothing is applied and `version` never bumps. It falls through to the
          // emit block rather than returning, so the customer actually hears the rejection.
          for (const op of proposal.operations) {
            rejected.push({
              op,
              error: new CartRejectedError(
                'cart_confirmed',
                'That order has already been sent to the kitchen. Please ask a server for changes.',
              ),
            });
          }
          await this.repo.markProcessed(proposal.request_id, 'rejected');
        } else {
          let applied = 0;
          for (const op of proposal.operations) {
            const r = await applyOperation(cart, op, this.menu, proposal.pos_config_id);
            if (r.ok) {
              cart = r.value;
              applied += 1;
            } else {
              rejected.push({ op, error: r.error });
            }
          }

          if (applied > 0) {
            cart = { ...cart, version: cart.version + 1 };
            // Best-effort: replace our untaxed local estimate with the POS's authoritative,
            // tax-included quote before persisting, so the cart in Redis (and the cart.updated
            // broadcast) carries the real price. A quote failure (Odoo down, an item pulled
            // mid-flow) must NOT lose a valid edit — we keep the local totals and move on; the
            // next successful edit re-quotes. Confirm remains the point that enforces pricing.
            try {
              cart = applyQuoteToCart(cart, await this.repo.quoteCart(cart));
            } catch (err) {
              log.warn('cart.quote_failed', errorMeta(err));
            }
            // Atomic: persist the cart AND mark the request processed together (§9).
            await this.repo.commitApplied(cart, proposal.request_id);
            updatedCart = cart;
          } else {
            await this.repo.markProcessed(proposal.request_id, 'rejected');
          }
        }
      } catch (err) {
        // Unexpected/infra failure (Redis or menu unavailable). Nothing was persisted
        // — commitApplied runs only after the loop — and the request was NOT marked
        // processed, so a retry can reprocess cleanly. Surface it to the client over
        // the existing rejection channel rather than dropping the turn silently.
        log.error('cart.apply_failed', errorMeta(err));
        this.bus.emit('cart.operation_rejected', {
          cart_id: proposal.cart_id,
          request_id: proposal.request_id,
          reason: 'internal_error',
          message: 'Sorry, something went wrong. Please try again.',
          ...(session_id !== undefined ? { session_id } : {}),
        });
        return;
      }

      // Persist succeeded. Emit OUTSIDE the try so a throwing cart.updated / rejection
      // listener can't be misread as an infra failure and trigger a spurious
      // internal_error for a cart that's already committed and marked processed.
      if (updatedCart) {
        this.bus.emit('cart.updated', {
          cart_id: updatedCart.cart_id,
          pos_config_id: updatedCart.pos_config_id,
          version: updatedCart.version,
          cart: updatedCart,
          // The turn that produced this update, so the event-bus log can trace it.
          request_id: proposal.request_id,
        });
      }

      for (const { op, error } of rejected) {
        this.bus.emit('cart.operation_rejected', {
          cart_id: proposal.cart_id,
          request_id: proposal.request_id,
          reason: error.reason,
          message: error.message,
          operation: op,
          ...(session_id !== undefined ? { session_id } : {}),
        });
      }
    });
  }

  /**
   * Confirm the cart into an Odoo pos_order (design §9, step 11). Shares `applyLock` with
   * applyProposal, so the two are mutually exclusive — there is no check-then-act race
   * between "is it confirmed?" and "append to it".
   *
   * @throws NotFoundError when the cart does not exist; OdooError when the insert fails.
   */
  async confirm(cart_id: CartId): Promise<PosOrderId> {
    return await this.applyLock.run(cart_id, async () => {
      const cart = await this.carts.get(cart_id);
      if (!cart) throw new NotFoundError(`unknown cart ${cart_id}`);
      // Idempotent: a second confirm returns the stored id rather than re-inserting.
      if (cart.confirmed_at && cart.pos_order_id !== undefined) return cart.pos_order_id;

      const pos_order_id = await this.repo.confirmOrder(cart);
      // If Odoo accepted the insert but this write fails, the cart is not marked confirmed
      // and a retry re-sends. That is safe, not a hole: the far side's line uuid
      // `{cart_id}:{line_id}` makes the insert idempotent (SPEC § Idempotency), so a replay
      // creates no duplicate lines. We inherit idempotency from the far side.
      await this.carts.set({ ...cart, confirmed_at: new Date().toISOString(), pos_order_id });
      return pos_order_id;
    });
  }
}
