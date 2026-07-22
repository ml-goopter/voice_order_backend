import type { CandidateItem } from '../menu/menu-types.js';
import type { MentionedItem } from '../contracts/mentioned-item.js';

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
