import type { CandidateItem } from '../menu/menu-types.js';
import type { MentionedItem } from '../contracts/mentioned-item.js';
import type { CartId, RequestId } from '../shared/types.js';
import { LIMITS } from '../config/constants.js';
import { logger } from '../config/logger.js';

/** Project a `search_menu` candidate down to the wire shape: echoed keys/price/name, dropping
 *  matcher internals (`names`, `score`, `matched_text`) and `available_modifiers` (a spoken
 *  suggestion is not a configurator). */
export function toMentionedItem(c: CandidateItem): MentionedItem {
  return {
    menu_item_key: c.menu_item_key,
    product_tmpl_id: c.product_tmpl_id,
    name: c.name,
    base_price_cents: c.base_price_cents,
    ...(c.popularity !== undefined ? { popularity: c.popularity } : {}),
  };
}

/**
 * Turn the agent's declared `menu_item_key`s into verified `MentionedItem`s. "Verified" means
 * "the agent actually retrieved it this turn" — `known` is the turn's accumulated `search_results`,
 * never a menu lookup, so a key the agent invented or recalled from an earlier turn (never
 * re-searched, per the prompt's CONTEXT RULES) is exactly the hallucination this catches rather
 * than launders. Dropping is silent to the caller (a warn, not a tool error) — a reply that
 * mentions nothing verifiable just degrades to speech with no cards, which is safe.
 *
 * Every declared key is classified even past the cap, and the whole turn's losses are reported in
 * ONE `order.mentioned_items_dropped` line: the list is model-controlled, so a per-key log would let
 * a model that dumps its scratchpad spam the log, and stopping early would make "it named 20 items"
 * indistinguishable from "it named 8".
 */
export function resolveMentionedItems(
  keys: string[],
  known: Record<string, MentionedItem>,
  ctx: { request_id: RequestId; cart_id: CartId },
): MentionedItem[] {
  const resolved: MentionedItem[] = [];
  const unresolved: string[] = [];
  for (const key of new Set(keys)) {
    const item = known[key];
    if (item === undefined) unresolved.push(key);
    else if (resolved.length < LIMITS.maxMentionedItems) resolved.push(item);
  }
  // `declared` counts DEDUPED keys, so a repeated key is not reported as a loss.
  const declared = new Set(keys).size;
  if (declared > resolved.length) {
    logger.warn('order.mentioned_items_dropped', {
      declared,
      resolved: resolved.length,
      unresolved_count: unresolved.length,
      // A sample, not the list: enough to recognise a hallucination pattern without echoing a
      // model-sized array into the log.
      unresolved: unresolved.slice(0, LIMITS.maxMentionedItems),
      request_id: ctx.request_id,
      cart_id: ctx.cart_id,
    });
  }
  return resolved;
}
