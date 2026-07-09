import type { EventBus } from '../events/event-bus.js';
import type { CartCache } from '../redis/cart-cache.js';
import type { MenuService } from '../menu/menu-service.js';
import type { CartRepository } from './cart-repository.js';
import type { OrderProposal } from '../ordering/schemas/proposal.js';
import type { SessionId } from '../shared/types.js';
import type { CartOperation } from '../ordering/schemas/cart-operation.schema.js';
import { KeyedAsyncLock } from '../shared/async-lock.js';
import { CartRejectedError, errorMeta } from '../shared/errors.js';
import { emptyCart } from './cart-types.js';
import type { Cart } from './cart-types.js';
import { applyOperation } from './cart-operation-applier.js';
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
          // Atomic: persist the cart AND mark the request processed together (§9).
          await this.repo.commitApplied(cart, proposal.request_id);
          updatedCart = cart;
        } else {
          await this.repo.markProcessed(proposal.request_id, 'rejected');
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

  /** Confirm the active cart into an Odoo pos_order (design §9, step 11). */
  async confirm(cart_id: string): Promise<void> {
    await this.applyLock.run(cart_id, async () => {
      const cart = await this.carts.get(cart_id);
      if (!cart) return;
      await this.repo.confirmOrder(cart);
    });
  }
}
