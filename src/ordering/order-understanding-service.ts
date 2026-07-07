import type { EventBus } from '../events/event-bus.js';
import type {
  OrderClarificationAnswered,
  SttFinalTranscriptReceived,
} from '../events/event-types.js';
import type { OrderProposal } from './schemas/proposal.js';
import { OrderGraph } from './order-graph.js';
import { CartTurnQueue } from './cart-turn-queue.js';
import { logger } from '../config/logger.js';

/**
 * Order Understanding module (design §6). A PURE proposer — it never mutates the
 * cart. Serializes turns per cart (Tier-1 FIFO) in front of the graph, then emits
 * either operations_proposed or clarification_needed.
 */
export class OrderUnderstandingService {
  private readonly queue = new CartTurnQueue();

  constructor(
    private readonly graph: OrderGraph,
    private readonly bus: EventBus,
  ) {}

  async handleFinalTranscript(e: SttFinalTranscriptReceived): Promise<void> {
    await this.queue.enqueue(e.cart_id, async () => {
      // TODO: source supported_languages from voice_restaurant_settings.
      const result = await this.graph.run({
        request_id: e.request_id,
        session_id: e.session_id,
        cart_id: e.cart_id,
        pos_config_id: e.pos_config_id,
        text: e.text,
        supported_languages: [],
        ...(e.language !== undefined ? { language: e.language } : {}),
      });

      if (!result.ok) {
        logger.warn('order.parse_failed', { request_id: e.request_id, error: result.error.message });
        this.bus.emit('voice.session_failed', {
          session_id: e.session_id,
          cart_id: e.cart_id,
          reason: 'order_parse_failed',
        });
        return;
      }

      const { output, base_version } = result.value;

      if (output.needs_clarification && output.clarification_question !== null) {
        this.bus.emit('order.clarification_needed', {
          cart_id: e.cart_id,
          session_id: e.session_id,
          request_id: e.request_id,
          question: output.clarification_question,
          ...(output.clarification_options !== undefined ? { options: output.clarification_options } : {}),
        });
        return;
      }

      const proposal: OrderProposal = {
        request_id: e.request_id,
        cart_id: e.cart_id,
        pos_config_id: e.pos_config_id,
        base_version,
        operations: output.operations,
      };
      this.bus.emit('order.operations_proposed', { session_id: e.session_id, proposal });
    });
  }

  /**
   * Resume a paused turn with the customer's answer (design §6 clarification loop).
   * Real resume needs the stored turn state (LangGraph checkpointer keyed by cart).
   * TODO: reload the paused turn and continue; for now this is a no-op stub.
   */
  async handleClarificationAnswer(e: OrderClarificationAnswered): Promise<void> {
    logger.warn('order.clarification_resume_stub', { cart_id: e.cart_id, request_id: e.request_id });
  }
}
