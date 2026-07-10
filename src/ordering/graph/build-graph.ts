import { StateGraph, MemorySaver, START, END } from '@langchain/langgraph';
import { OrderState } from './state.js';
import type { OrderStateType } from './state.js';
import { node } from './instrument.js';
import type { MenuService } from '../../menu/menu-service.js';
import type { LlmProvider } from '../../llm/llm-provider.js';
import type { CartCache } from '../../redis/cart-cache.js';
import type { OrderGraphInput } from '../schemas/order-graph-input.schema.js';
import { LIMITS } from '../../config/constants.js';
import { normalizeTranscript } from '../nodes/normalize-transcript.node.js';
import { loadCart, buildCartView } from '../nodes/load-cart.node.js';
import { retrieveCandidates } from '../nodes/retrieve-candidates.node.js';
import { parseAndValidate } from '../nodes/parse-and-validate.node.js';

export interface GraphDeps {
  menu: MenuService;
  llm: LlmProvider;
  carts: CartCache;
}

/** Assemble the LLM input from graph state (cart is loaded before parse runs). */
function toInput(s: OrderStateType): OrderGraphInput {
  return {
    request_id: s.request_id,
    session_id: s.session_id,
    cart_id: s.cart_id,
    pos_config_id: s.pos_config_id,
    customer_text: s.customer_text,
    current_cart: s.cart_view!,
    candidate_items: s.candidates,
    history: s.history,
    supported_languages: s.supported_languages,
    ...(s.language !== undefined ? { language: s.language } : {}),
    ...(s.clarification_question !== undefined ? { clarification_question: s.clarification_question } : {}),
  };
}

/**
 * The Order Understanding graph (design §6): normalize → load cart → retrieve
 * candidates → parse (with schema repair) → finalize. A clarification is NOT a pause:
 * when parse asks a question the graph records it to history and ends the turn
 * (fire-and-forget). The customer's answer arrives as the NEXT transcript; that turn's
 * normalize sees the pending question in history and feeds it to parse as the answer.
 * Compiled with a checkpointer so history follows the cart across turns.
 */
export function buildOrderGraph({ menu, llm, carts }: GraphDeps) {
  return new StateGraph(OrderState)
    // If the previous turn raised a clarification we never got an answer to, THIS utterance
    // IS that answer: carry the pending question into parse (as `clarification_question`) so it
    // resolves the original request against the current utterance. Otherwise clear the one-shot
    // question so no stale clarification leaks into a fresh turn. The pending question rides in
    // `history`; durable cart/session context persists across turns via the checkpointer thread.
    .addNode('normalize', node('normalize', (s) => {
      const customer_text = normalizeTranscript(s.customer_text);
      const last = s.history.at(-1);
      const pendingQuestion = last?.clarification_question;
      return { customer_text, clarification_question: pendingQuestion };
    }))
    .addNode('load_cart', node('load_cart', async (s) => {
      const cart = await loadCart(carts, s.cart_id, s.pos_config_id);
      const cart_view = await buildCartView(menu, cart);
      return { cart_view, base_version: cart.version };
    }))
    .addNode('retrieve', node('retrieve', async (s) => {
      const last = s.history.at(-1);
      const pendingQuestion = last?.clarification_question;
      const retrieval_text = pendingQuestion ? (`${pendingQuestion} ${s.customer_text}`) : s.customer_text
      const candidates = await retrieveCandidates(menu, s.pos_config_id, retrieval_text);
      return { candidates: candidates.items };
    }))
    .addNode('parse', node('parse', async (s) => {
      const output = await parseAndValidate(llm, toInput(s), LIMITS.llmMaxRetries);
      return { output };
    }))
    // Record the completed turn. If parse RAISED a clarification this turn, keep its question
    // so the next turn (whose utterance is the answer) has the context — the answer is not
    // waited for, it arrives as the next transcript. A turn that resolves a prior question
    // records only its utterance, breaking the clarification run (design §6).
    .addNode('finalize', node('finalize', (s) => {
      const raised = s.output?.needs_clarification ? s.output.clarification_question ?? undefined : undefined;
      return {
        history: [
          {
            customer_text: s.customer_text,
            ...(raised !== undefined ? { clarification_question: raised } : {}),
          },
        ],
      };
    }))
    .addEdge(START, 'normalize')
    .addEdge('normalize', 'load_cart')
    .addEdge('load_cart', 'retrieve')
    .addEdge('retrieve', 'parse')
    .addEdge('parse', 'finalize')
    .addEdge('finalize', END)
    .compile({ checkpointer: new MemorySaver() });
}
