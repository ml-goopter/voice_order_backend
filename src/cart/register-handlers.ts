import type { EventBus } from '../events/event-bus.js';
import type { CartController } from './cart-controller.js';
import { logger } from '../config/logger.js';

/** Wire the Cart Module to the event bus (design §2/§9). */
export function registerCartHandlers(bus: EventBus, controller: CartController): void {
  bus.on('order.operations_proposed', (e) => {
    // applyProposal handles its own failures; this .catch is a last-resort guard so a
    // rejection can never escape as an unhandled promise and silently drop the turn.
    controller.applyProposal(e.proposal, e.session_id).catch((err: unknown) => {
      logger.error('cart.apply_unhandled', { message: (err as Error).message });
    });
  });
}
