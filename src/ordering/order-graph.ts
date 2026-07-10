import type { LangCode, CartId, PosConfigId, RequestId, SessionId } from '../shared/types.js';
import type { MenuService } from '../menu/menu-service.js';
import type { LlmProvider } from '../llm/llm-provider.js';
import type { CartCache } from '../redis/cart-cache.js';
import type { OrderGraphOutput } from './schemas/order-graph-output.schema.js';
import type { HistoryTurn } from './schemas/order-graph-input.schema.js';
import { buildOrderGraph } from './graph/build-graph.js';
import { trailingClarificationRun } from './graph/state.js';

export interface OrderGraphParams {
  request_id: RequestId;
  session_id: SessionId;
  cart_id: CartId;
  pos_config_id: PosConfigId;
  text: string;
  language?: LangCode;
  supported_languages: LangCode[];
}

/**
 * Outcome of a graph turn: a proposal is ready, or the model asked a clarification. A
 * clarification does NOT pause — the turn is complete; `round` is how many consecutive
 * unanswered clarifications precede it (including this one) so the caller can cap runaways.
 */
export type GraphTurnResult =
  | { status: 'complete'; output: OrderGraphOutput; base_version: number }
  | { status: 'clarify'; question: string; round: number; options?: string[] };

type InvokeReturn = { output: OrderGraphOutput | null; base_version: number; history: HistoryTurn[] };

/**
 * Turns a final transcript into proposed operations or a clarification (design §6),
 * backed by @langchain/langgraph with a cart-keyed checkpointer so conversation history
 * follows the CART across turns. The thread id is `${pos_config_id}:${cart_id}`, not a
 * single voice session (design §6). A clarification is fire-and-forget: the graph records
 * the question to history and ends; the answer arrives as the next transcript. The per-cart
 * FIFO that serializes turns lives in OrderUnderstandingService, in front of this graph.
 */
export class OrderGraph {
  private readonly graph: ReturnType<typeof buildOrderGraph>;

  constructor(menu: MenuService, llm: LlmProvider, carts: CartCache) {
    this.graph = buildOrderGraph({ menu, llm, carts });
  }

  /** Start a new turn. Rejects if parsing fails after repair (§11.3) — caller fails the turn. */
  async start(p: OrderGraphParams): Promise<GraphTurnResult> {
    const input = {
      request_id: p.request_id,
      session_id: p.session_id,
      cart_id: p.cart_id,
      pos_config_id: p.pos_config_id,
      customer_text: p.text,
      supported_languages: p.supported_languages,
      ...(p.language !== undefined ? { language: p.language } : {}),
    };
    const out = (await this.graph.invoke(input, this.threadConfig(p.pos_config_id, p.cart_id))) as InvokeReturn;
    return this.interpret(out);
  }

  private interpret(out: InvokeReturn): GraphTurnResult {
    const output = out.output!;
    if (output.needs_clarification) {
      return {
        status: 'clarify',
        question: output.clarification_question!,
        round: trailingClarificationRun(out.history),
        ...(output.clarification_options !== undefined ? { options: output.clarification_options } : {}),
      };
    }
    return { status: 'complete', output, base_version: out.base_version };
  }

  private threadConfig(pos_config_id: PosConfigId, cart_id: CartId) {
    return { configurable: { thread_id: `${pos_config_id}:${cart_id}` } };
  }
}
