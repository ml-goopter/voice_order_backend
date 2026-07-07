import type { LangCode, CartId, PosConfigId, RequestId, SessionId } from '../shared/types.js';
import type { Result } from '../shared/result.js';
import { ok } from '../shared/result.js';
import type { MenuService } from '../menu/menu-service.js';
import type { LlmProvider } from '../llm/llm-provider.js';
import type { CartCache } from '../redis/cart-cache.js';
import type { OrderGraphInput } from './schemas/order-graph-input.schema.js';
import type { OrderGraphOutput } from './schemas/order-graph-output.schema.js';
import { normalizeTranscript } from './nodes/normalize-transcript.node.js';
import { loadCart } from './nodes/load-cart.node.js';
import { retrieveCandidates } from './nodes/retrieve-candidates.node.js';
import { parseOrder } from './nodes/parse-order.node.js';
import { validateOperations } from './nodes/validate-operations.node.js';

export interface OrderGraphParams {
  request_id: RequestId;
  session_id: SessionId;
  cart_id: CartId;
  pos_config_id: PosConfigId;
  text: string;
  language?: LangCode;
  supported_languages: LangCode[];
  clarification_answer?: string;
}

export interface OrderGraphResult {
  output: OrderGraphOutput;
  base_version: number;
}

/**
 * Turns a final transcript into proposed operations or a clarification (design §6).
 * A hand-rolled node pipeline stands in for LangGraph JS so the scaffold has no
 * heavy dependency. TODO: port to @langchain/langgraph with a cart-keyed checkpointer
 * (thread id = `${pos_config_id}:${cart_id}`, §6) to get real pause/resume.
 */
export class OrderGraph {
  constructor(
    private readonly menu: MenuService,
    private readonly llm: LlmProvider,
    private readonly carts: CartCache,
  ) {}

  async run(p: OrderGraphParams): Promise<Result<OrderGraphResult>> {
    const text = normalizeTranscript(p.text);
    const cart = await loadCart(this.carts, p.cart_id, p.pos_config_id);
    const candidates = await retrieveCandidates(this.menu, p.pos_config_id, text);

    const input: OrderGraphInput = {
      request_id: p.request_id,
      session_id: p.session_id,
      cart_id: p.cart_id,
      pos_config_id: p.pos_config_id,
      customer_text: text,
      current_cart: cart,
      candidate_items: candidates.items,
      supported_languages: p.supported_languages,
      ...(p.language !== undefined ? { language: p.language } : {}),
      ...(p.clarification_answer !== undefined ? { clarification_answer: p.clarification_answer } : {}),
    };

    const raw = await parseOrder(this.llm, input);
    const validated = validateOperations(raw);
    if (!validated.ok) return validated;

    return ok({ output: validated.value, base_version: cart.version });
  }
}
