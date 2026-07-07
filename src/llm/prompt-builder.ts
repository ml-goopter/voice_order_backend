import type { LlmPrompt } from './llm-provider.js';
import type { OrderGraphInput } from '../ordering/schemas/order-graph-input.schema.js';

const ALLOWED_OPERATIONS = [
  'add_item',
  'remove_item',
  'update_quantity',
  'add_modifier',
  'remove_modifier',
  'clarify',
] as const;

/**
 * Builds the LLM prompt from graph input (design §8). The model sees the transcript,
 * current cart, candidate items/modifiers, and the allowed-operation schema — never
 * the full menu. It must emit strict JSON using menu keys, not display names.
 */
export function buildPrompt(input: OrderGraphInput): LlmPrompt {
  const system = [
    'You convert a restaurant customer utterance into cart operations.',
    'Output STRICT JSON: { "operations": [...], "needs_clarification": boolean, "clarification_question": string|null }.',
    'Use menu_item_key / modifier_key from the candidates — never invent keys or use display names.',
    'Edits (remove_item, update_quantity, add_modifier, remove_modifier) target a line_id from the cart.',
    'Only add_item omits line_id. If ambiguous, set needs_clarification=true with a question.',
    `Allowed operations: ${ALLOWED_OPERATIONS.join(', ')}.`,
  ].join('\n');

  const user = JSON.stringify(
    {
      request_id: input.request_id,
      customer_text: input.customer_text,
      language: input.language,
      current_cart: input.current_cart,
      candidate_items: input.candidate_items,
      clarification_answer: input.clarification_answer,
    },
    null,
    2,
  );

  return { system, user };
}
