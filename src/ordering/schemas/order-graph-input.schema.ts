/** LangGraph input assembled before the LLM call (design §6/§8). */
import type { CartId, LangCode, PosConfigId, RequestId, SessionId } from '../../shared/types.js';
import type { Cart } from '../../cart/cart-types.js';
import type { CandidateItem } from '../../menu/menu-types.js';

export interface OrderGraphInput {
  request_id: RequestId;
  session_id: SessionId;
  cart_id: CartId;
  pos_config_id: PosConfigId;
  customer_text: string;
  language?: LangCode;
  current_cart: Cart;
  candidate_items: CandidateItem[];
  supported_languages: LangCode[];
  /** Present when resuming after a clarification (design §6 clarification loop). */
  clarification_answer?: string;
}
