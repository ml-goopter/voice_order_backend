import { StateGraph, MemorySaver, interrupt, START, END } from '@langchain/langgraph';
import { OrderState } from './state.js';
import type { OrderStateType } from './state.js';
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

/** Payload carried by a clarification interrupt (design §6). */
export interface ClarificationInterrupt {
  question: string;
  options?: string[];
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
    ...(s.clarification_answer !== undefined ? { clarification_answer: s.clarification_answer } : {}),
  };
}

/**
 * The Order Understanding graph (design §6): normalize → load cart → retrieve
 * candidates → parse (with schema repair) → decide {propose | clarify}. The clarify
 * node interrupts (pause) and, on resume, loops back to parse with the answer so the
 * model produces final operations. Compiled with a checkpointer so pause/resume works.
 */
export function buildOrderGraph({ menu, llm, carts }: GraphDeps) {
  return new StateGraph(OrderState)
    // Clear the one-shot clarification_answer so a prior turn's answer never leaks into
    // this turn's parse prompt. normalize runs only on a fresh turn (START); a resume
    // re-enters at `clarify`, so a within-turn answer still survives to parse. Durable
    // cart/session context persists across turns via the cart-keyed checkpointer thread.
    .addNode('normalize', (s) => ({
      customer_text: normalizeTranscript(s.customer_text),
      clarification_answer: undefined,
      clarification_question: undefined,
    }))
    .addNode('load_cart', async (s) => {
      const cart = await loadCart(carts, s.cart_id, s.pos_config_id);
      const cart_view = await buildCartView(menu, cart);
      return { cart_view, base_version: cart.version };
    })
    .addNode('retrieve', async (s) => {
      const candidates = await retrieveCandidates(menu, s.pos_config_id, s.customer_text);
      return { candidates: candidates.items };
    })
    .addNode('parse', async (s) => {
      const output = await parseAndValidate(llm, toInput(s), LIMITS.llmMaxRetries);
      return { output };
    })
    .addNode('clarify', (s) => {
      const out = s.output!;
      const payload: ClarificationInterrupt = {
        question: out.clarification_question!,
        ...(out.clarification_options !== undefined ? { options: out.clarification_options } : {}),
      };
      const answer = interrupt(payload) as string;
      // Loop back to parse with the answer; clear the stale clarification output. Keep the
      // question alongside the answer so `finalize` can record it as context in history.
      return { clarification_answer: answer, clarification_question: payload.question, output: null };
    })
    // Record the completed turn (utterance + any clarification answer) so the next turn's
    // parse re-sends it as conversation context. Runs once, at the true end of the turn —
    // both the direct-propose path and the post-resume path arrive here (design §6).
    .addNode('finalize', (s) => ({
      history: [
        {
          customer_text: s.customer_text,
          ...(s.clarification_question !== undefined ? { clarification_question: s.clarification_question } : {}),
          ...(s.clarification_answer !== undefined ? { clarification_answer: s.clarification_answer } : {}),
        },
      ],
    }))
    .addEdge(START, 'normalize')
    .addEdge('normalize', 'load_cart')
    .addEdge('load_cart', 'retrieve')
    .addEdge('retrieve', 'parse')
    .addConditionalEdges(
      'parse',
      (s) => (s.output?.needs_clarification ? 'clarify' : 'finalize'),
      { clarify: 'clarify', finalize: 'finalize' },
    )
    .addEdge('clarify', 'parse')
    .addEdge('finalize', END)
    .compile({ checkpointer: new MemorySaver() });
}
