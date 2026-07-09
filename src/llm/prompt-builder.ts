import type { LlmPrompt } from './llm-provider.js';
import type { OrderGraphInput } from '../ordering/schemas/order-graph-input.schema.js';
import { cartOperationSchema } from '../ordering/schemas/cart-operation.schema.js';

// Derived from the output schema so the prompt's advertised operations can never
// drift from what validation accepts. Clarification is NOT an operation — it is
// signalled via needs_clarification / clarification_question (see below).
const ALLOWED_OPERATIONS = cartOperationSchema.options.map((o) => o.shape.action.value);

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
    'To add a NEW item, emit ONE add_item and put any requested extras or omissions in its inline "modifiers" array (a list of { "modifier_key": ... } drawn from that item\'s available_modifiers). Do NOT emit a separate add_modifier for a new item.',
    'add_modifier / remove_modifier / remove_item / update_quantity edit an item ALREADY in current_cart and target its line_id (a string) from the cart. Never invent a line_id and never use a numeric id.',
    'Each current_cart line is self-describing: it has line_id, name, menu_item_key, its current modifiers, and its available_modifiers. Match the customer\'s reference to a line by name, then use that line\'s line_id. An add_modifier modifier_key must come from that line\'s available_modifiers; a remove_modifier modifier_key must come from that line\'s current modifiers.',
    'conversation_history holds prior turns (oldest → newest) ONLY to resolve references like "that", "the same", or "make it two". current_cart is the sole source of truth for what is in the order — never re-execute a request from conversation_history.',
    'Only add_item omits line_id. If ambiguous, set needs_clarification=true with a question.',
    `Allowed operations: ${ALLOWED_OPERATIONS.join(', ')}.`,
    '',
    'Example — "one sweet and sour chicken with added broccoli" (keys shown are placeholders; use the real keys from candidate_items):',
    JSON.stringify({
      operations: [
        {
          action: 'add_item',
          menu_item_key: '<menu_item_key>',
          quantity: 1,
          modifiers: [{ modifier_key: '<modifier_key>' }],
        },
      ],
      needs_clarification: false,
      clarification_question: null,
    }),
  ].join('\n');

  const user = JSON.stringify(
    {
      request_id: input.request_id,
      customer_text: input.customer_text,
      language: input.language,
      current_cart: input.current_cart,
      candidate_items: input.candidate_items,
      conversation_history: input.history,
      clarification: input.clarification_answer !== undefined
        ? { question: input.clarification_question, answer: input.clarification_answer }
        : undefined,
    },
    null,
    2,
  );

  return { system, user };
}

/**
 * Repair prompt after schema-invalid output (design §11.3 stages 2/3). Re-states the
 * contract, shows the model its rejected output and the validation error, and asks
 * for corrected STRICT JSON only.
 */
export function buildRepairPrompt(
  input: OrderGraphInput,
  invalidOutput: string,
  validationError: string,
): LlmPrompt {
  const base = buildPrompt(input);
  const system = [
    base.system,
    '',
    'Your previous response failed schema validation. Return ONLY corrected STRICT JSON — no prose, no code fences.',
  ].join('\n');
  const user = [
    base.user,
    '',
    `PREVIOUS_INVALID_OUTPUT:\n${invalidOutput}`,
    `VALIDATION_ERROR: ${validationError}`,
  ].join('\n');
  return { system, user };
}
