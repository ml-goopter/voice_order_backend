import type { LangCode, ProductTmplId, PtavId } from '../shared/types.js';

/** A modifier option offered to the LLM alongside a candidate item (design §7/§8). */
export interface CandidateModifier {
  modifier_key: string; // maps to ptav_id
  ptav_id: PtavId;
  name: string; // default display name (en_US-first), the single-string fallback
  /** All translatable names by Odoo res.lang code, when the source carries them. */
  names?: Record<LangCode, string>;
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
  available_modifiers: CandidateModifier[];
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
