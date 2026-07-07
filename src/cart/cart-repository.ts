import type { PosOrderId, RequestId } from '../shared/types.js';
import type { Cart } from './cart-types.js';
import { logger } from '../config/logger.js';

type Outcome = 'applied' | 'rejected' | 'duplicate' | 'superseded';

/**
 * Durability for the Cart Module (design §9): idempotency ledger, recovery
 * snapshots, and hand-off of confirmed carts to Odoo pos_order. In-memory here;
 * TODO: back the ledger + snapshots with Redis; confirm via an Odoo client.
 */
export class CartRepository {
  private readonly processed = new Map<RequestId, Outcome>();

  async wasProcessed(request_id: RequestId): Promise<boolean> {
    return this.processed.has(request_id);
  }

  async markProcessed(request_id: RequestId, outcome: Outcome, _version?: number): Promise<void> {
    this.processed.set(request_id, outcome);
  }

  async saveSnapshot(cart: Cart): Promise<void> {
    // TODO: persist the recovery snapshot to Redis (keyed by cart_id + version).
    logger.debug('cart.snapshot', { cart_id: cart.cart_id, version: cart.version });
  }

  /** Confirm: write the cart as an Odoo pos_order (design §9, step 11). */
  async confirmOrder(cart: Cart): Promise<PosOrderId> {
    // TODO: create pos_order / pos_order_line via an Odoo client; record the confirmation.
    logger.warn('cart.confirm_stub', { cart_id: cart.cart_id });
    return 0;
  }
}
