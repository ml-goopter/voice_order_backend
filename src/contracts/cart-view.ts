/** Prompt-facing cart projections + conversation history for the agent (design §6/§8). */
import type { CartId, Cents, LineId, PosConfigId } from '../shared/types.js';

/** A modifier on a self-describing cart line — keys/names/price only, no numeric ids (Plan A). */
export interface CartModifierView {
  modifier_key: string;
  name: string;
  /** Per-unit surcharge, so the agent can quote an option's cost. */
  price_extra_cents: Cents;
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
  /** Base price before surcharges. Per unit, not multiplied by `quantity`. */
  base_price_cents: Cents;
  modifiers: CartModifierView[];
  available_modifiers: CartModifierView[];
}

/**
 * Prompt-facing projection of the cart (Plan A). Not the stored Cart shape.
 * Deliberately carries NO totals: this snapshot is loaded before the turn's operations
 * are applied, so any total here would be stale by the time the agent speaks. Per-unit
 * prices are safe to quote; totals are the cart's to compute and the client's to show.
 */
export interface CartView {
  cart_id: CartId;
  pos_config_id: PosConfigId;
  version: number;
  items: CartLineView[];
}

/** One prior turn resent to the agent for reference resolution (Plan A). */
export interface HistoryTurn {
  customer_text: string;
  /** Present when the agent ended the turn by SPEAKING (a question or a recommendation), so the
   *  next turn — whose utterance may answer it — has the context. */
  agent_reply?: string;
}
