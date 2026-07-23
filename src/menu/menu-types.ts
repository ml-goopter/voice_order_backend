import type { Cents, LangCode, ProductTmplId, PtavId } from '../shared/types.js';
import type { PopularityTier } from '../contracts/mentioned-item.js';

/** Canonical definition lives in `contracts/` because a contract type uses it and `contracts` must
 *  not import from `menu`; re-exported here so menu importers keep one import site. */
export type { PopularityTier };

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
  /**
   * Group metadata, carried ONLY when this option belongs to a REQUIRED group — i.e. a live
   * attribute whose `display_type <> 'multi'` (radio/pills/select), meaning pick EXACTLY one.
   * Requiredness is not stored in Odoo; `display_type` is the only signal
   * (docs/pos-product-modifier-order-schema.md §Required modifiers).
   *
   * An option in an optional (`multi`) group carries none of the three, so **absent ⇒ optional**
   * and `required` is never `false` here. Emitting them for optional groups cost ~2.2 KB per item
   * in prompt payload to say "false" 34 times.
   *
   * `group_key` is `String(attribute_line_id)` — the group is per PRODUCT, so the same attribute on
   * another product is a different group. Opaque; never sent back in an operation.
   */
  group_key?: string;
  group_name?: string;
  required?: boolean;
}

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
