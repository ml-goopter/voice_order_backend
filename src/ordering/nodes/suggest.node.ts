import { logger } from '../../config/logger.js';

/**
 * Suggest-intent handler (design §6) — v1 STUB and the seam for a future recommender.
 * The customer asked for a recommendation; actually producing one is future work. For now
 * the turn is surfaced as `{ status: 'suggest' }` by the OrderGraph façade (which reads the
 * `intent` state channel set by `classify`), so this node only needs to exist as the routing
 * target. Replace the body with real suggestion logic — returning the result on a state
 * channel — when the recommender lands.
 */
export function suggestReply(): void {
  logger.info('order.suggest_stub');
}
