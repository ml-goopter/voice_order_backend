import type { LangCode, CartId, PosConfigId, RequestId, SessionId } from '../shared/types.js';
import type { MenuService } from '../menu/menu-service.js';
import type { LlmProvider } from '../llm/llm-provider.js';
import type { CartCache } from '../redis/cart-cache.js';
import type { OrderGraphOutput } from './schemas/order-graph-output.schema.js';
import type { HistoryTurn } from './schemas/order-graph-input.schema.js';
import type { Suggestion, SuggestedItem } from './schemas/suggestion.schema.js';
import type { Intent } from './graph/intents.js';
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
 * Outcome of a graph turn. `complete` — a proposal is ready; `clarify` — the model asked a
 * question (does NOT pause; `round` is how many consecutive unanswered clarifications precede
 * it, including this one, so the caller can cap runaways); `suggest`/`junk` — the classifier
 * routed the utterance away from the proposer pipeline: `suggest` carries a spoken
 * recommendation + the items it named; `junk` is a non-orderable utterance with nothing to say.
 */
export type GraphTurnResult =
  | { status: 'complete'; output: OrderGraphOutput; base_version: number }
  | { status: 'clarify'; question: string; round: number; options?: string[] }
  | { status: 'suggest'; reply: string; items: SuggestedItem[] }
  | { status: 'junk' };

type InvokeReturn = {
  intent: Intent;
  output: OrderGraphOutput | null;
  base_version: number;
  history: HistoryTurn[];
  suggestion: Suggestion | null;
};

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

  // `intentLlm` is the intent classifier's own provider (its own creds, design §6); it defaults
  // to the parser `llm` so a caller that doesn't wire a separate one shares a single provider.
  constructor(menu: MenuService, llm: LlmProvider, carts: CartCache, intentLlm: LlmProvider = llm) {
    this.graph = buildOrderGraph({ menu, llm, intentLlm, carts });
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
    // Non-order intents short-circuit the proposer pipeline: `output` was never produced,
    // so branch on the classified intent before reading it.
    if (out.intent === 'junk') return { status: 'junk' };
    if (out.intent === 'suggest') {
      // The suggest node always writes a suggestion (a fallback reply on failure), but default
      // defensively so a null can never surface as an undefined reply.
      const suggestion = out.suggestion ?? { reply: '', items: [] };
      return { status: 'suggest', reply: suggestion.reply, items: suggestion.items };
    }
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
