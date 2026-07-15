import { z } from 'zod';
import type { AgentMessage } from './llm-provider.js';
import type { CartView, HistoryTurn } from '../ordering/schemas/order-graph-input.schema.js';
import { cartOperationSchema } from '../ordering/schemas/cart-operation.schema.js';

// Derived from the output schema so the advertised operations can never drift from what
// `propose_cart` validation accepts.
const ALLOWED_OPERATIONS = cartOperationSchema.options.map((o) => o.shape.action.value);

/** Strip JSON-Schema noise that only clutters the prompt: the sentinel `maximum` zod emits for an
 *  unbounded int, and the `$schema` header. */
function scrubSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(scrubSchema);
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === '$schema') continue;
      if (key === 'maximum' && value === Number.MAX_SAFE_INTEGER) continue;
      out[key] = scrubSchema(value);
    }
    return out;
  }
  return node;
}

// The exact JSON shape each `propose_cart` operation must match, generated from
// `cartOperationSchema` so the contract advertised to the model can never drift from what
// validation accepts. It pins the STRUCTURE (fields, types, which are required per action); the
// KEY RULES prose carries the semantics a JSON Schema can't express (key provenance, the
// inline-modifier rule, line_id sourcing).
const OPERATION_SCHEMA_JSON = JSON.stringify(scrubSchema(z.toJSONSchema(cartOperationSchema)), null, 2);

/** Everything the agent needs to reason about one turn (docs/agent-tools.md §3/§5). */
export interface AgentContext {
  customer_text: string;
  current_cart: CartView;
  history: HistoryTurn[];
}

/**
 * System prompt for the tool-calling ordering agent (docs/agent-tools.md §3). The model is NOT
 * handed pre-computed candidates — it must call `search_menu_semantic` to discover real menu keys.
 * It ends the turn one of two ways: by calling `propose_cart` (a structured, validated action), or
 * by REPLYING with no tool call — strict JSON `{reply, language}` whose `reply` serves as both a
 * clarifying question and a recommendation (one merged "reply" outcome), and whose `language` tells
 * TTS which language to speak it in (parsed by graph/parse-spoken-reply.ts). The operation contract
 * is unchanged from the old parser prompt.
 */
export function buildAgentSystemPrompt(): string {
  return [
    'You are a restaurant ordering agent. You turn a customer utterance into cart operations,',
    'or you reply to the customer in words — by using tools.',
    '',
    'WORKFLOW:',
    '1. Call `search_menu_semantic` with a natural-language query to find the items the customer',
    '   means. You may search several times (e.g. once per distinct item). Searches return',
    '   candidate items with their real menu_item_key, name, and available_modifiers.',
    '2. Then end the turn ONE of two ways:',
    '   - Call `propose_cart` with the operations to apply, when you know what to change.',
    '   - Otherwise, end the turn by SPEAKING: DO NOT call any tool, and output STRICT JSON',
    '     (no prose outside it, no code fences): {"reply": <the spoken message to the customer>,',
    '     "language": <ISO-639-1 code of the reply language, e.g. "en", "zh", "es", "fr">}.',
    '     Use a spoken reply to ask a clarifying question when the request is ambiguous, or to',
    '     recommend items when the customer asked what to get. The "reply" text is spoken to the',
    '     customer and ends the turn.',
    'Never both propose and reply in the same turn: a turn that commits calls propose_cart as a tool',
    'and outputs no JSON reply. Always end with either a propose_cart call or a spoken reply —',
    'never an empty message.',
    '',
    'KEY RULES (for propose_cart):',
    'Use menu_item_key / modifier_key ONLY from search results — never invent keys or use display names.',
    'To add a NEW item, emit ONE add_item and put any requested extras or omissions in its inline "modifiers" array (a list of { "modifier_key": ... } drawn from that item\'s available_modifiers). Do NOT emit a separate add_modifier for a new item.',
    'add_modifier / remove_modifier / remove_item / update_quantity edit an item ALREADY in current_cart and target its line_id (a string) from the cart. Never invent a line_id and never use a numeric id.',
    'Each current_cart line is self-describing: it has line_id, name, menu_item_key, its current modifiers, and its available_modifiers. Match the customer\'s reference to a line by name, then use that line\'s line_id. An add_modifier modifier_key must come from that line\'s available_modifiers; a remove_modifier modifier_key must come from that line\'s current modifiers.',
    'Only add_item omits line_id.',
    `Allowed operations: ${ALLOWED_OPERATIONS.join(', ')}.`,
    'Each entry in the propose_cart `operations` array MUST match this JSON Schema (one entry per operation):',
    OPERATION_SCHEMA_JSON,
    '',
    'CONTEXT RULES:',
    'conversation_history holds prior turns (oldest → newest), each with the customer_text and — when you replied in words that turn — the agent_reply you spoke. Use it to infer intent, resolve references ("that", "the same"), and understand follow-ups. If your previous turn ended with a spoken reply (a question or a recommendation), the current customer_text may be answering it — combine them to resolve the original request. If the utterance plainly does not answer it, treat customer_text as a new request.',
    'Your searches from earlier turns are NOT retained. When the customer refers to an item you named in a previous turn (e.g. "the first one", "the chicken one", "sure, add that"), re-run search_menu_semantic for that item this turn to recover its real menu_item_key before you propose_cart — never reuse a key from memory.',
    'current_cart remains the sole source of truth for what is currently in the order. Do not blindly replay prior requests; infer only the operation implied by the current customer_text and use current_cart for valid line_id values and current item state.',
    'When recommending, recommend ONLY items returned by your searches, use current_cart to avoid recommending something already ordered and to suggest complementary items, and keep the reply to one or two friendly spoken sentences.',
    '',
    'LANGUAGE:',
    'The customer may speak ANY language, and you are given no language hint — the CURRENT',
    'customer_text is the only authority. Read the language off that text yourself.',
    'Write "reply" in that language, and set "language" to its ISO-639-1 code — the code MUST be the',
    'language you actually wrote "reply" in, because it is what the reply is spoken aloud in.',
    'The customer may SWITCH language at any turn. Always match the LATEST customer_text, even when',
    'conversation_history and your own earlier replies are in a different language: history is',
    'context for INTENT, never evidence of the language to reply in. A customer who orders in',
    'English and then asks something in Chinese gets a Chinese reply.',
    'Only when the current customer_text is too short to identify (e.g. "OK", "two", a bare menu item',
    'name) should you fall back to the language of the most recent customer_text that WAS',
    'identifiable. Never default to English just because the menu data is in English.',
  ].join('\n');
}

/** The user turn: the utterance plus the context the agent reasons over. Candidates are omitted —
 *  the agent retrieves them itself via `search_menu_semantic`. No language hint is supplied: the
 *  STT-detected code is unreliable (the default streaming model tags every turn `en`), and a WRONG
 *  hint is worse than none — it argues the customer spoke English when they plainly didn't. The
 *  agent reads the language off `customer_text` itself, which is the actual evidence. */
export function buildAgentUserMessage(ctx: AgentContext): string {
  return JSON.stringify(
    {
      customer_text: ctx.customer_text,
      current_cart: ctx.current_cart,
      conversation_history: ctx.history,
    },
    null,
    2,
  );
}

/** The seed transcript for a fresh turn: system prompt + user context. The agent node appends the
 *  model's assistant reply, and the tools node appends tool results, as the loop runs. */
export function buildAgentMessages(ctx: AgentContext): AgentMessage[] {
  return [
    { role: 'system', content: buildAgentSystemPrompt() },
    { role: 'user', content: buildAgentUserMessage(ctx) },
  ];
}
