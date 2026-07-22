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
 */
export function resolveMentionedItems(
  keys: string[],
  known: Record<string, MentionedItem>,
  ctx: { request_id: RequestId; cart_id: CartId },
): MentionedItem[] {
  const seen = new Set<string>();
  const resolved: MentionedItem[] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const item = known[key];
    if (item === undefined) {
      logger.warn('order.mentioned_item_unresolved', { key, request_id: ctx.request_id, cart_id: ctx.cart_id });
      continue;
    }
    resolved.push(item);
    if (resolved.length >= LIMITS.maxMentionedItems) break;
  }
  return resolved;
}
