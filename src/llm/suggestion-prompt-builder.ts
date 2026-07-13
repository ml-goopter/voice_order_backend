import type { LlmPrompt } from './llm-provider.js';
import type { LangCode } from '../shared/types.js';
import type { CandidateItem } from '../menu/menu-types.js';
import type { CartView, HistoryTurn } from '../ordering/schemas/order-graph-input.schema.js';

/** Everything the recommender needs to answer "what should I get?" (design §6). */
export interface SuggestionPromptInput {
  customer_text: string;
  current_cart: CartView;
  candidate_items: CandidateItem[];
  history: HistoryTurn[];
  language?: LangCode;
}

/**
 * Builds the suggestion prompt (design §6) — the customer asked for a recommendation. The model
 * sees the utterance, the current cart (for upsell), and candidate_items (the real, available
 * menu items surfaced for this turn). It MUST recommend only from those candidates and return a
 * short spoken reply plus the items it named. Output is STRICT JSON `{ "reply": string, "items":
 * [{ "menu_item_key", "name" }] }`; `generateSuggestion` validates it and degrades to a safe
 * fallback if the model strays. The system prompt is text-independent so it can double as a
 * stable identifier for this hop in tests.
 */
export function buildSuggestionPrompt(input: SuggestionPromptInput): LlmPrompt {
  const system = [
    'You are a restaurant server recommending items to a customer who asked what to get.',
    'Output STRICT JSON: { "reply": string, "items": [{ "menu_item_key": string, "name": string }] }. No prose, no code fences.',
    '"reply" is a short, friendly spoken recommendation (one or two sentences).',
    'Recommend ONLY items from candidate_items — use their exact menu_item_key and name. Never invent an item or key.',
    'List each item you mention in the customer_text of "reply" in the "items" array, in the order you mention them.',
    'Use current_cart to avoid recommending something already in the order and to suggest complementary items (an upsell).',
    'If nothing fits, return a helpful "reply" and an empty "items" array.',
  ].join('\n');

  const user = JSON.stringify(
    {
      customer_text: input.customer_text,
      language: input.language,
      current_cart: input.current_cart,
      candidate_items: input.candidate_items,
      conversation_history: input.history,
    },
    null,
    2,
  );

  return { system, user };
}
