import type { EventBus } from '../events/event-bus.js';
import type { OrderUnderstandingService } from './order-understanding-service.js';
import { logger } from '../config/logger.js';
import { errorMeta } from '../shared/errors.js';

/** Wire Order Understanding to the event bus (design §2). */
export function registerOrderingHandlers(bus: EventBus, service: OrderUnderstandingService): void {
  // Last-resort guards: these handlers own their failures, but a rejection must never
  // escape as an unhandled promise and silently drop the turn (mirrors cart handlers).
  bus.on('stt.final_transcript.received', (e) => {
    service.handleFinalTranscript(e).catch((err: unknown) => {
      logger.error('order.handle_final_unhandled', { request_id: e.request_id, cart_id: e.cart_id, ...errorMeta(err) });
    });
  });
  bus.on('order.clarification_answered', (e) => {
    service.handleClarificationAnswer(e).catch((err: unknown) => {
      logger.error('order.handle_clarification_unhandled', { request_id: e.request_id, cart_id: e.cart_id, ...errorMeta(err) });
    });
  });
}
