import { Command } from '@langchain/langgraph';
import type { LangCode, CartId, PosConfigId, RequestId, SessionId } from '../shared/types.js';
import type { MenuService } from '../menu/menu-service.js';
import type { LlmProvider } from '../llm/llm-provider.js';
import type { CartCache } from '../redis/cart-cache.js';
import type { OrderGraphOutput } from './schemas/order-graph-output.schema.js';
import { buildOrderGraph } from './graph/build-graph.js';
import type { ClarificationInterrupt } from './graph/build-graph.js';

export interface OrderGraphParams {
  request_id: RequestId;
  session_id: SessionId;
  cart_id: CartId;
  pos_config_id: PosConfigId;
  text: string;
  language?: LangCode;
  supported_languages: LangCode[];
}

/** Outcome of a graph turn: either a proposal is ready, or the graph paused for clarification. */
export type GraphTurnResult =
  | { status: 'complete'; output: OrderGraphOutput; base_version: number }
  | { status: 'clarify'; question: string; options?: string[] };

type InvokeReturn = { output: OrderGraphOutput | null; base_version: number } & {
  __interrupt__?: Array<{ value: ClarificationInterrupt }>;
};

/**
 * Turns a final transcript into proposed operations or a clarification (design §6),
 * backed by @langchain/langgraph with a cart-keyed checkpointer so a clarification can
 * pause and resume. The thread id is `${pos_config_id}:${cart_id}` — context follows the
 * CART, not a single voice session (design §6). The per-cart FIFO that serializes turns
 * lives in OrderUnderstandingService, in front of this graph (design §9).
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

  /** Resume a paused turn with the customer's clarification answer (design §6). */
  async resume(pos_config_id: PosConfigId, cart_id: CartId, answer: string): Promise<GraphTurnResult> {
    const out = (await this.graph.invoke(
      new Command({ resume: answer }),
      this.threadConfig(pos_config_id, cart_id),
    )) as InvokeReturn;
    return this.interpret(out);
  }

  private interpret(out: InvokeReturn): GraphTurnResult {
    const first = out.__interrupt__?.[0];
    if (first !== undefined) {
      const { question, options } = first.value;
      return { status: 'clarify', question, ...(options !== undefined ? { options } : {}) };
    }
    // Not interrupted → parse ran to completion and set output.
    return { status: 'complete', output: out.output!, base_version: out.base_version };
  }

  private threadConfig(pos_config_id: PosConfigId, cart_id: CartId) {
    return { configurable: { thread_id: `${pos_config_id}:${cart_id}` } };
  }
}
