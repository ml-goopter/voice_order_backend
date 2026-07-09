import type { EventBus } from '../events/event-bus.js';
import type {
  OrderClarificationAnswered,
  SttFinalTranscriptReceived,
} from '../events/event-types.js';
import type { CartId } from '../shared/types.js';
import type { OrderProposal } from './schemas/proposal.js';
import type { GraphTurnResult } from './order-graph.js';
import { OrderGraph } from './order-graph.js';
import { CartTurnQueue } from './cart-turn-queue.js';
import { TIMEOUTS } from '../config/constants.js';
import { logger } from '../config/logger.js';

/** Safety valve: cap clarification rounds so a looping model can't freeze a cart. */
const MAX_CLARIFICATION_ROUNDS = 3;

/**
 * Order Understanding module (design §6). A PURE proposer — it never mutates the
 * cart. Serializes turns per cart (Tier-1 FIFO, design §9) in front of the graph;
 * a turn awaiting clarification HOLDS its FIFO slot (so turn 2 blocks behind it) and
 * a timeout cancels a stalled clarification so the cart never freezes.
 */
export class OrderUnderstandingService {
  private readonly queue = new CartTurnQueue();
  /** cart_id → resolver for the in-flight clarification (at most one per cart, held by the FIFO). */
  private readonly pendingClarifications = new Map<CartId, (answer: string | null) => void>();

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
    try {
      // TODO: source supported_languages from voice_restaurant_settings.
      let result = await this.graph.start({
        request_id: e.request_id,
        session_id: e.session_id,
        cart_id: e.cart_id,
        pos_config_id: e.pos_config_id,
        text: e.text,
        supported_languages: [],
        ...(e.language !== undefined ? { language: e.language } : {}),
      });

      for (let round = 0; result.status === 'clarify'; round += 1) {
        if (round >= MAX_CLARIFICATION_ROUNDS) {
          logger.warn('order.clarification_rounds_exceeded', { cart_id: e.cart_id, request_id: e.request_id });
          this.fail(e, 'clarification_unresolved');
          return null;
        }
        this.bus.emit('order.clarification_needed', {
          cart_id: e.cart_id,
          session_id: e.session_id,
          request_id: e.request_id,
          question: result.question,
          ...(result.options !== undefined ? { options: result.options } : {}),
        });

        const answer = await this.awaitClarification(e.cart_id);
        if (answer === null) {
          logger.warn('order.clarification_timeout', { cart_id: e.cart_id, request_id: e.request_id });
          this.fail(e, 'clarification_timeout');
          return null;
        }
        result = await this.graph.resume(e.pos_config_id, e.cart_id, answer);
      }

      return result;
    } catch (error) {
      // The failing node already logged order.node_failed with which state threw; this is the
      // turn-level fallback that fails the session.
      logger.warn('order.turn_failed', {
        request_id: e.request_id,
        error: error instanceof Error ? error.message : String(error),
      });
      this.fail(e, 'order_parse_failed');
      return null;
    }
  }

  /**
   * Deliver the customer's clarification answer to the paused turn (design §6). The
   * turn is holding its FIFO slot inside awaitClarification; this just resolves it.
   */
  async handleClarificationAnswer(e: OrderClarificationAnswered): Promise<void> {
    const resolve = this.pendingClarifications.get(e.cart_id);
    if (resolve === undefined) {
      logger.warn('order.clarification_answer_no_pending', { cart_id: e.cart_id, request_id: e.request_id });
      return;
    }
    resolve(e.answer);
  }

  /** Wait for an answer or expire after TIMEOUTS.clarificationMs (design §9 clarification stall). */
  private awaitClarification(cart_id: CartId): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingClarifications.delete(cart_id);
        resolve(null);
      }, TIMEOUTS.clarificationMs);

      this.pendingClarifications.set(cart_id, (answer) => {
        clearTimeout(timer);
        this.pendingClarifications.delete(cart_id);
        resolve(answer);
      });
    });
  }

  private propose(e: SttFinalTranscriptReceived, result: Extract<GraphTurnResult, { status: 'complete' }>): void {
    const proposal: OrderProposal = {
      request_id: e.request_id,
      cart_id: e.cart_id,
      pos_config_id: e.pos_config_id,
      base_version: result.base_version,
      operations: result.output.operations,
    };
    this.bus.emit('order.operations_proposed', { session_id: e.session_id, proposal });
  }

  private fail(e: SttFinalTranscriptReceived, reason: string): void {
    this.bus.emit('voice.session_failed', { session_id: e.session_id, cart_id: e.cart_id, reason });
  }
}
