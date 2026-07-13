import { StateGraph, MemorySaver, START, END } from '@langchain/langgraph';
import { OrderState } from './state.js';
import type { OrderStateType } from './state.js';
import { node } from './instrument.js';
import type { MenuService } from '../../menu/menu-service.js';
import type { LlmProvider } from '../../llm/llm-provider.js';
import type { CartCache } from '../../redis/cart-cache.js';
import type { OrderGraphInput } from '../schemas/order-graph-input.schema.js';
import { LIMITS } from '../../config/constants.js';
import { INTENT_ROUTE } from './intents.js';
import { classifyIntent } from '../nodes/classify-intent.node.js';
import { normalizeTranscript } from '../nodes/normalize-transcript.node.js';
import { loadCart, buildCartView } from '../nodes/load-cart.node.js';
import { retrieveCandidates } from '../nodes/retrieve-candidates.node.js';
import { parseAndValidate } from '../nodes/parse-and-validate.node.js';
import { generateSuggestion } from '../nodes/suggest.node.js';

export interface GraphDeps {
  menu: MenuService;
  llm: LlmProvider; // the proposer/parser LLM
  intentLlm: LlmProvider; // the intent classifier's own LLM (its own creds; design §6)
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
 * The Order Understanding graph (design §6): normalize → classify → (route by intent). The
 * `order` intent runs the proposer pipeline load cart → retrieve candidates → parse (with
 * schema repair) → finalize; `suggest`/`junk` short-circuit past it to finalize. A
 * clarification is NOT a pause: when parse asks a question the graph records it to history and
 * ends the turn (fire-and-forget). The customer's answer arrives as the NEXT transcript; that
 * turn's normalize sees the pending question in history and forces `order` so the answer is
 * never mislabeled. Routing is table-driven (`INTENT_ROUTE`) so adding an intent is a one-row
 * change. Compiled with a checkpointer so history follows the cart across turns.
 */
export function buildOrderGraph({ menu, llm, intentLlm, carts }: GraphDeps) {
  return new StateGraph(OrderState)
    // First hop: normalize the raw transcript. If the previous turn raised a clarification we
    // never got an answer to, THIS utterance IS that answer: carry the pending question into
    // `clarification_question` so parse resolves the original request against the current
    // utterance. Otherwise clear the one-shot question so no stale clarification leaks into a
    // fresh turn. The pending question rides in `history`; durable cart/session context persists
    // across turns via the checkpointer thread.
    .addNode('normalize', node('normalize', (s) => {
      const customer_text = normalizeTranscript(s.customer_text);
      const last = s.history.at(-1);
      const pendingQuestion = last?.clarification_question;
      // Clear any prior turn's suggestion so it can't leak into THIS turn's finalize (the
      // suggest node re-sets it only when the turn actually recommends something).
      return { customer_text, clarification_question: pendingQuestion, suggestion: null };
    }))
    // Then label the NORMALIZED utterance so the graph can route it (design §6). If normalize
    // carried a pending clarification into `clarification_question`, THIS utterance is the answer
    // to it, so force `order` and skip the classifier's LLM call — the parse pipeline resolves
    // the question. Otherwise classify; the classifier degrades to `order` on any failure so a
    // real order is never dropped.
    .addNode('classify', node('classify', async (s) => {
      if (s.clarification_question !== undefined) return { intent: 'order' as const };
      const intent = await classifyIntent(intentLlm, s.customer_text);
      return { intent };
    }))
    .addNode('load_cart', node('load_cart', async (s) => {
      const cart = await loadCart(carts, s.cart_id, s.pos_config_id);
      const cart_view = await buildCartView(menu, cart);
      return { cart_view, base_version: cart.version };
    }))
    .addNode('retrieve', node('retrieve', async (s) => {
      const pendingQuestion = s.clarification_question
      const retrievalText = pendingQuestion ? (`${pendingQuestion} ${s.customer_text}`) : s.customer_text
      const candidates = await retrieveCandidates(menu, s.pos_config_id, retrievalText);
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
      // Record what was recommended (if anything) so a follow-up ("the first one") can resolve
      // against it on the next turn's parse. Empty suggestions add nothing.
      const suggested = s.suggestion?.items;
      return {
        history: [
          {
            customer_text: s.customer_text,
            ...(raised !== undefined ? { clarification_question: raised } : {}),
            ...(suggested !== undefined && suggested.length > 0 ? { suggested_items: suggested } : {}),
          },
        ],
      };
    }))
    // Suggest-intent handler: load the cart (for upsell) and this turn's candidates, then ask the
    // LLM for a recommendation. Routes to finalize so the turn (and its suggestion) is recorded;
    // the façade surfaces it as { status: 'suggest' }.
    .addNode('suggest', node('suggest', async (s) => {
      const cart = await loadCart(carts, s.cart_id, s.pos_config_id);
      const cart_view = await buildCartView(menu, cart);
      const candidates = await retrieveCandidates(menu, s.pos_config_id, s.customer_text);
      const suggestion = await generateSuggestion(llm, {
        customer_text: s.customer_text,
        current_cart: cart_view,
        candidate_items: candidates.items,
        history: s.history,
        ...(s.language !== undefined ? { language: s.language } : {}),
      });
      return { suggestion };
    }))
    .addEdge(START, 'normalize')
    .addEdge('normalize', 'classify')
    // Table-driven fan-out: the router returns the intent, INTENT_ROUTE maps it to the next node.
    .addConditionalEdges('classify', (s) => s.intent, INTENT_ROUTE)
    .addEdge('load_cart', 'retrieve')
    .addEdge('retrieve', 'parse')
    .addEdge('parse', 'finalize')
    .addEdge('suggest', 'finalize')
    .addEdge('finalize', END)
    .compile({ checkpointer: new MemorySaver() });
}
