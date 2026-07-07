import type { EventBus } from '../events/event-bus.js';
import type { OrderUnderstandingService } from './order-understanding-service.js';

/** Wire Order Understanding to the event bus (design §2). */
export function registerOrderingHandlers(bus: EventBus, service: OrderUnderstandingService): void {
  bus.on('stt.final_transcript.received', (e) => {
    void service.handleFinalTranscript(e);
  });
  bus.on('order.clarification_answered', (e) => {
    void service.handleClarificationAnswer(e);
  });
}
