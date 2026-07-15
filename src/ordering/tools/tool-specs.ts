import type { ToolSpec } from '../../llm/llm-provider.js';

/** Tool names, shared by the specs and the handlers so the two can't drift. */
export const TOOL_NAMES = {
  search: 'search_menu_semantic',
  propose: 'propose_cart',
} as const;

/**
 * The tools advertised to the ordering agent (docs/agent-tools.md §3). One retrieval tool
 * (`search_menu_semantic`, loopable) and one terminal action (`propose_cart`). Clarifications and
 * recommendations are NOT tools — the agent expresses them by ending the turn with a plain spoken
 * reply (no tool call), which the graph surfaces as a single `reply` outcome. `operations` is kept
 * a loose JSON Schema on purpose — the precise contract lives in the system prompt, and
 * `propose_cart` validates the real shape with zod, returning a repair-friendly tool error on a
 * miss (§3.2).
 */
export const TOOL_SPECS: ToolSpec[] = [
  {
    name: TOOL_NAMES.search,
    description:
      'Search the menu for items matching a natural-language query. Returns candidate items with their menu_item_key, name, base_price_cents, and available_modifiers (each with its own price_extra_cents). All prices are per-unit integer cents. Call this before proposing so you use real menu keys. You may call it several times.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to search for, e.g. "chicken burger" or "something spicy and vegetarian".',
        },
      },
      required: ['query'],
    },
  },
  {
    name: TOOL_NAMES.propose,
    description:
      'Finalize the turn with the cart operations to apply. Use menu_item_key/modifier_key values only from search results, and line_id values only from current_cart. Ends the turn. If instead you need to ask a question or make a recommendation, do NOT call this — just reply with a spoken message.',
    parameters: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          description:
            'Cart operations: add_item (menu_item_key, quantity, optional inline modifiers), remove_item (line_id), update_quantity (line_id, quantity), add_modifier (line_id, modifier_key), remove_modifier (line_id, modifier_key).',
          items: { type: 'object' },
        },
      },
      required: ['operations'],
    },
  },
];
