import type { EventBus } from '../events/event-bus.js';
import type { SttFinalTranscriptReceived } from '../events/event-types.js';
import type { LangCode } from '../shared/types.js';
import type { OrderProposal } from '../contracts/proposal.js';
import type { GraphTurnResult } from './order-graph.js';
import { OrderGraph } from './order-graph.js';
import { CartTurnQueue } from './cart-turn-queue.js';
import { logger } from '../config/logger.js';
import { config } from '../config/env.js';
import { messageOf } from '../shared/errors.js';

/**
 * Order Understanding module (design §6). A PURE proposer — it never mutates the
 * cart. Serializes turns per cart (Tier-1 FIFO, design §9) in front of the graph.
 * A spoken reply is fire-and-forget: the turn emits the reply and ends (releasing its
 * FIFO slot); the customer's answer arrives as the next transcript, so nothing blocks.
 */
export class OrderUnderstandingService {
  private readonly queue = new CartTurnQueue();

  constructor(
    private readonly graph: OrderGraph,
    private readonly bus: EventBus,
  ) { }

  async handleFinalTranscript(e: SttFinalTranscriptReceived): Promise<void> {
    await this.queue.enqueue(e.cart_id, async () => {
      const result = await this.runTurn(e);
      // Emit the outcome OUTSIDE runTurn's try/catch: a throwing event subscriber must not be
      // mistaken for a turn failure (which would double-emit — e.g. reporting both a proposal
      // and voice.session_failed for the same turn).
      this.dispatch(e, result);
    });
  }

  /** Drive the graph to a turn outcome. A node throw is caught and mapped to a `fail` result here;
   *  all event emission is deferred to `dispatch`, which runs outside this try/catch. */
  private async runTurn(e: SttFinalTranscriptReceived): Promise<GraphTurnResult> {
    try {
      // TODO: source supported_languages from voice_restaurant_settings.
      return await this.graph.start({
        request_id: e.request_id,
        session_id: e.session_id,
        cart_id: e.cart_id,
        pos_config_id: e.pos_config_id,
        text: e.text,
        supported_languages: [],
      });
    } catch (error) {
      // The failing node already logged order.node_failed with which state threw; this is the
      // turn-level fallback that fails the session.
      logger.child({ request_id: e.request_id, cart_id: e.cart_id }).warn('order.turn_failed', {
        error: messageOf(error),
      });
      return { status: 'fail', reason: 'order_parse_failed' };
    }
  }

  /** Emit the turn's outcome. Deliberately side-effecting and OUTSIDE runTurn's try/catch so a
   *  throwing subscriber can't be swallowed and re-reported as a turn failure. */
  private dispatch(e: SttFinalTranscriptReceived, result: GraphTurnResult): void {
    const log = logger.child({ request_id: e.request_id, cart_id: e.cart_id });
    switch (result.status) {
      case 'junk':
        // Non-orderable utterance (greeting, noise, off-topic): nothing to propose, end quietly.
        log.info('order.intent_junk');
        return;
      case 'fail':
        // The turn ended without a terminal (a node threw → `order_parse_failed`, or the agent
        // loop exhausted maxAgentSteps / said nothing). Nothing to propose; fail with the reason,
        // which distinguishes the cause (the event name is the same for all failure modes).
        log.warn('order.turn_failed', { reason: result.reason });
        this.fail(e, result.reason);
        return;
      case 'reply': {
        // The agent ended by speaking to the customer (a clarifying question or a recommendation).
        // Fire-and-forget: emit the reply and end the turn. The customer's answer arrives as the
        // next transcript; the reply is already recorded to history so the next turn resolves it.
        this.speak(e, result.reply, result.language);
        return;
      }
      case 'complete':
        // The proposal goes out FIRST (cart update before the spoken confirmation); then, when the
        // agent bundled a confirmation into `propose_cart` (approach B), speak it too. Both are
        // fire-and-forget — a confirmation may race a partial cart rejection (Risk 1, out of scope).
        this.propose(e, result);
        if (result.reply !== undefined) this.speak(e, result.reply, result.language);
        return;
    }
  }

  /** Emit a spoken reply to the customer (the ONLY `order.reply` emitter). The agent wrote the
   *  reply, so it is the sole authority on its language; STT's detected language is not consulted at
   *  all (unreliable — see docs/text-to-speech.md). Falls back to `TTS_LANGUAGE` when the agent
   *  declared none, so TTS always has a language to speak — defaulting here is what keeps that knob
   *  reachable. Shared by the standalone `reply` outcome and the bundled `complete` confirmation. */
  private speak(e: SttFinalTranscriptReceived, reply: string, language: LangCode | undefined): void {
    this.bus.emit('order.reply', {
      cart_id: e.cart_id,
      session_id: e.session_id,
      request_id: e.request_id,
      reply,
      language: language ?? config.ttsLanguage,
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
    // The ordering module owns no socket; the gateway subscribes to this and relays `message` to
    // the customer as a voice.error frame. Without a consumer, a failed turn is silently dropped.
    this.bus.emit('voice.session_failed', {
      session_id: e.session_id,
      cart_id: e.cart_id,
      reason,
      message: 'Sorry, I could not process that. Please try again.',
    });
  }
}
