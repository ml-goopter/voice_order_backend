import type { Cents, ProductTmplId } from '../shared/types.js';

/**
 * How well an item sells, as a coarse band rather than a rank or a count. Deliberately
 * imprecise: popularity rests on ~1 month of trade, so "#3, 47 sold" would be false
 * precision (and an odd thing for a restaurant to say aloud). Absent = unremarkable.
 * See docs/plans/agent-search-extension.md §5.4.
 */
export type PopularityTier = 'top' | 'popular';

/**
 * A menu item the agent named in its spoken reply, echoed from the search result it was shown.
 * The agent supplies only a `menu_item_key`; every other field here is looked up server-side, so
 * the model can never mis-state a price it just read. `available_modifiers` is deliberately
 * omitted — a spoken suggestion is not a configurator, and adding it would roughly triple the
 * payload for a card the customer hasn't asked to configure yet.
 */
export interface MentionedItem {
  menu_item_key: string;
  product_tmpl_id: ProductTmplId; // the client's handle for images / item detail from Odoo
  name: string; // display name as searched (en_US-first)
  base_price_cents: Cents; // per unit, before modifiers
  popularity?: PopularityTier; // only present on popularity-sorted searches
}
