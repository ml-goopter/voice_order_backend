import type { Cents, LangCode, ProductTmplId, PtavId } from '../shared/types.js';

/** A modifier option offered to the LLM alongside a candidate item (design §7/§8). */
export interface CandidateModifier {
  modifier_key: string; // maps to ptav_id
  ptav_id: PtavId;
  name: string; // default display name (en_US-first), the single-string fallback
  /** All translatable names by Odoo res.lang code, when the source carries them. */
  names?: Record<LangCode, string>;
  /**
   * Per-unit surcharge for choosing this option (ptav.price_extra). Priced per
   * ptav, not per option value: the same option may cost differently on another
   * item. Required — a missing price would silently under-charge.
   */
  price_extra_cents: Cents;
}

/**
 * How well an item sells, as a coarse band rather than a rank or a count. Deliberately
 * imprecise: popularity rests on ~1 month of trade, so "#3, 47 sold" would be false
 * precision (and an odd thing for a restaurant to say aloud). Absent = unremarkable.
 * See docs/plans/agent-search-extension.md §5.4.
 */
export type PopularityTier = 'top' | 'popular';

/** A menu item the Candidate Matcher surfaced for a transcript chunk (design §7). */
export interface CandidateItem {
  menu_item_key: string; // maps to product_tmpl_id
  product_tmpl_id: ProductTmplId;
  name: string; // default display name (en_US-first), the single-string fallback
  /** All translatable names by Odoo res.lang code, when the source carries them. */
  names?: Record<LangCode, string>;
  matched_text?: string;
  score?: number;
  /** Base price before any modifier surcharge — the agent quotes it; the cart still prices. */
  base_price_cents: Cents;
  available_modifiers: CandidateModifier[];
  /** Only populated on a popularity-sorted search — a relevance search runs no ranking query. */
  popularity?: PopularityTier;
}

/**
 * What the agent asked `search_menu` for (docs/plans/agent-search-extension.md §4).
 *
 * Fields are `?: T | undefined` rather than plain `?: T` because this is a parse boundary —
 * the value comes straight from a zod `.optional()`, whose inferred type carries the explicit
 * `undefined`. Every reader treats absent and undefined identically.
 */
export interface MenuSearchOptions {
  /** Omit for a pure browse ("what's popular?"); then `sort` is forced to 'popularity'. */
  query?: string | undefined;
  sort?: 'relevance' | 'popularity' | undefined;
  max_price_cents?: Cents | undefined;
  min_price_cents?: Cents | undefined;
  limit?: number | undefined;
}

export interface CandidateSet {
  items: CandidateItem[];
}

/**
 * A precomputed embedding for one piece of an item's text (a name in some
 * language). Multiple per item drive cross-language matching (design §7/§15).
 */
export interface MenuVector {
  text: string;
  vector: number[];
}

/** A menu item as loaded from Odoo (product_template) into the in-memory cache. */
export interface MenuItem {
  product_tmpl_id: ProductTmplId;
  menu_item_key: string;
  /** Translatable names by Odoo res.lang code, e.g. { en_US: "Chicken Burger" }. */
  names: Record<LangCode, string>;
  base_price_cents: number;
  available: boolean;
  modifiers: CandidateModifier[];
}
