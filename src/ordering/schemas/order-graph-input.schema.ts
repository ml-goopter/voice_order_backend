/** LangGraph input assembled before the LLM call (design §6/§8). */
import type { CartId, LangCode, LineId, PosConfigId, RequestId, SessionId } from '../../shared/types.js';
import type { CandidateItem } from '../../menu/menu-types.js';

/** A modifier on a self-describing cart line — keys/names only, no numeric ids (Plan A). */
export interface CartModifierView {
  modifier_key: string;
  name: string;
}

/**
 * A prompt-facing cart line enriched at load time (Plan A). Carries the string `line_id`
 * edits must target, the item name + `menu_item_key`, the modifiers currently attached, and
 * the item's `available_modifiers` — so an edit by reference resolves from the cart alone.
 * Numeric `product_tmpl_id`/`ptav_id` are deliberately omitted so the model can't mistake one
 * for a `line_id`.
 */
export interface CartLineView {
  line_id: LineId;
  menu_item_key: string;
  name: string;
  quantity: number;
  modifiers: CartModifierView[];
  available_modifiers: CartModifierView[];
}

/** Prompt-facing projection of the cart (Plan A). Not the stored Cart shape. */
export interface CartView {
  cart_id: CartId;
  pos_config_id: PosConfigId;
  version: number;
  items: CartLineView[];
}

/** One prior turn resent to the model for reference resolution (Plan A). */
export interface HistoryTurn {
  customer_text: string;
  /** Present when the turn was clarified — the question is kept so the answer has context. */
  clarification_question?: string;
  clarification_answer?: string;
}

export interface OrderGraphInput {
  request_id: RequestId;
  session_id: SessionId;
  cart_id: CartId;
  pos_config_id: PosConfigId;
  customer_text: string;
  language?: LangCode;
  current_cart: CartView;
  candidate_items: CandidateItem[];
  /** Prior turns (oldest → newest), for resolving references like "that" / "the same". */
  history: HistoryTurn[];
  supported_languages: LangCode[];
  /** Present when resuming after a clarification (design §6 clarification loop). */
  clarification_answer?: string;
  /** The question posed on the previous clarify, sent back with the answer for context. */
  clarification_question?: string;
}
