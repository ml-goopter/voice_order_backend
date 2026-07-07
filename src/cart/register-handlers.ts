import type { EventBus } from '../events/event-bus.js';
import type { CartController } from './cart-controller.js';

/** Wire the Cart Module to the event bus (design §2/§9). */
export function registerCartHandlers(bus: EventBus, controller: CartController): void {
  bus.on('order.operations_proposed', (e) => {
    void controller.applyProposal(e.proposal, e.session_id);
  });
}
