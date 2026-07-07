import { KeyedAsyncLock } from '../shared/async-lock.js';
import type { CartId } from '../shared/types.js';

/**
 * Tier-1 per-cart understanding FIFO (design §9). Final transcripts for one cart_id
 * are processed one turn at a time, in arrival order, so turn 2 sees turn 1's result
 * and loads a fresh base_version. Sits IN FRONT of the LangGraph invocation.
 *
 * In-memory only (Map<cart_id, Promise> chain) — shard by cart_id to scale out.
 */
export class CartTurnQueue {
  private readonly lock = new KeyedAsyncLock();

  enqueue<T>(cart_id: CartId, turn: () => Promise<T>): Promise<T> {
    return this.lock.run(cart_id, turn);
  }
}
