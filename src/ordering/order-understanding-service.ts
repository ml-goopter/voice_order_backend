import type { EventBus } from '../events/event-bus.js';
import type { SttFinalTranscriptReceived } from '../events/event-types.js';
import type { OrderProposal } from './schemas/proposal.js';
import type { GraphTurnResult } from './order-graph.js';
import { OrderGraph } from './order-graph.js';
import { CartTurnQueue } from './cart-turn-queue.js';
import { logger } from '../config/logger.js';
import { messageOf } from '../shared/errors.js';

/** Safety valve: cap consecutive clarifications so a looping model can't freeze a cart. */
const MAX_CLARIFICATION_ROUNDS = 3;

/**
 * Order Understanding module (design §6). A PURE proposer — it never mutates the
 * cart. Serializes turns per cart (Tier-1 FIFO, design §9) in front of the graph.
 * A clarification is fire-and-forget: the turn emits the question and ends (releasing
 * its FIFO slot); the customer's answer arrives as the next transcript, so nothing blocks.
 */
export class OrderUnderstandingService {
  private readonly queue = new CartTurnQueue();

  constructor(
    private readonly graph: OrderGraph,
    private readonly bus: EventBus,
  ) {}

  async handleFinalTranscript(e: SttFinalTranscriptReceived): Promise<void> {
    await this.queue.enqueue(e.cart_id, async () => {
      const result = await this.runTurn(e);
      // Emit the proposal OUTSIDE runTurn's try/catch: a throwing operations_proposed
      // subscriber must not be mistaken for a parse failure (which would double-emit,
      // reporting both a proposal and voice.session_failed for the same turn).
      if (result !== null) this.propose(e, result);
    });
  }

  /** Drive the graph to a complete proposal, or null if the turn already failed/timed out. */
  private async runTurn(
    e: SttFinalTranscriptReceived,
  ): Promise<Extract<GraphTurnResult, { status: 'complete' }> | null> {
    const log = logger.child({ request_id: e.request_id, cart_id: e.cart_id });
    try {
      // TODO: source supported_languages from voice_restaurant_settings.
      const result = await this.graph.start({
        request_id: e.request_id,
        session_id: e.session_id,
        cart_id: e.cart_id,
        pos_config_id: e.pos_config_id,
        text: e.text,
        supported_languages: [],
        ...(e.language !== undefined ? { language: e.language } : {}),
      });

      if (result.status === 'clarify') {
        // A looping model that re-clarifies every turn would freeze the cart; give up after
        // MAX_CLARIFICATION_ROUNDS consecutive unanswered clarifications.
        if (result.round > MAX_CLARIFICATION_ROUNDS) {
          log.warn('order.clarification_rounds_exceeded');
          this.fail(e, 'clarification_unresolved');
          return null;
        }
        // Fire-and-forget: send the question and end the turn. The customer's answer arrives
        // as the next transcript; the pending question is already persisted to history so the
        // next turn's parse has the context (design §6).
        this.bus.emit('order.clarification_needed', {
          cart_id: e.cart_id,
          session_id: e.session_id,
          request_id: e.request_id,
          question: result.question,
          ...(result.options !== undefined ? { options: result.options } : {}),
        });
        return null;
      }

      return result;
    } catch (error) {
      // The failing node already logged order.node_failed with which state threw; this is the
      // turn-level fallback that fails the session.
      log.warn('order.turn_failed', { error: messageOf(error) });
      this.fail(e, 'order_parse_failed');
      return null;
    }
  }

  private propose(e: SttFinalTranscriptReceived, result: Extract<GraphTurnResult, { status: 'complete' }>): void {
    const proposal: OrderProposal = {
      request_id: e.request_id,
      cart_id: e.cart_id,
      pos_config_id: e.pos_config_id,
      base_version: result.base_version,
      operations: result.output.operations,
    };
    // request_id/cart_id are hoisted to the top level (they also live inside `proposal`)
    // so the event-bus correlation log keeps the turn thread across this hop.
    this.bus.emit('order.operations_proposed', {
      session_id: e.session_id,
      request_id: proposal.request_id,
      cart_id: proposal.cart_id,
      proposal,
    });
  }

  private fail(e: SttFinalTranscriptReceived, reason: string): void {
    this.bus.emit('voice.session_failed', { session_id: e.session_id, cart_id: e.cart_id, reason });
  }
}
