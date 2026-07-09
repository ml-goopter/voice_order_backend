import { isGraphBubbleUp } from '@langchain/langgraph';
import { logger } from '../../config/logger.js';
import { errorMeta } from '../../shared/errors.js';
import type { OrderStateType } from './state.js';

/**
 * Wrap an order-graph node so any throw is logged once, at the node boundary, tagged with the
 * node name + turn correlation ids, then re-thrown unchanged. Centralizes per-state error
 * attribution across the six nodes (normalize → load_cart → retrieve → parse → clarify →
 * finalize) so a Redis failure in `load_cart` is no longer mislabeled as a parse failure by the
 * single catch in OrderUnderstandingService.
 *
 * LangGraph signals control flow (interrupt/pause, Command bubbling) by THROWING — those are not
 * errors, so `isGraphBubbleUp` throws them straight back without logging. Only real faults reach
 * `logger.error`.
 */
export function node<T>(name: string, fn: (s: OrderStateType) => T | Promise<T>) {
  return async (s: OrderStateType): Promise<T> => {
    try {
      return await fn(s);
    } catch (error) {
      if (isGraphBubbleUp(error)) throw error;
      logger.error('order.node_failed', {
        node: name,
        request_id: s.request_id,
        cart_id: s.cart_id,
        pos_config_id: s.pos_config_id,
        ...errorMeta(error),
      });
      throw error;
    }
  };
}
