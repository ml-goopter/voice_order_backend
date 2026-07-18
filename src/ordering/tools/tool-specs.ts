import type { ToolSpec } from '../../llm/llm-provider.js';

/** Tool names, shared by the specs and the handlers so the two can't drift. */
export const TOOL_NAMES = {
  search: 'search_menu',
  propose: 'propose_cart',
} as const;

/**
 * The tools advertised to the ordering agent (docs/agent-tools.md §3). One retrieval tool
 * (`search_menu`, loopable) and one terminal action (`propose_cart`). Clarifications and
 * recommendations are NOT tools — the agent expresses them by ending the turn with a plain spoken
 * reply (no tool call), which the graph surfaces as a single `reply` outcome. `operations` is kept
 * a loose JSON Schema on purpose — the precise contract lives in the system prompt, and
 * `propose_cart` validates the real shape with zod, returning a repair-friendly tool error on a
 * miss (§3.2).
 *
 * `search_menu` takes filters/sort rather than being a bare semantic query, and combining them is
 * deliberately the SERVER's job: "what's popular and has fish?" is one call with
 * `{query:'fish', sort:'popularity'}`, not a relevance search plus a popularity search that the
 * model intersects itself (a step models get wrong, and an extra round-trip on a voice path).
 * See docs/plans/agent-search-extension.md §4.
 */
export const TOOL_SPECS: ToolSpec[] = [
  {
    name: TOOL_NAMES.search,
    description:
      'Search the menu. Returns candidate items with their menu_item_key, name, base_price_cents, available_modifiers (each with its own price_extra_cents), and — when sorted by popularity — a coarse `popularity` tier ("top" or "popular"; absent means unremarkable). All prices are per-unit integer cents. Call this before proposing so you use real menu keys. You may call it several times. Combine query + sort + price filters in ONE call rather than searching twice and intersecting the results yourself.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'What to search for, e.g. "chicken burger" or "fish". Matches item NAMES — the menu has no ingredient or dietary data, so "has fish" only finds items whose name says so. Omit entirely for a pure "what is popular?" browse.',
        },
        sort: {
          type: 'string',
          enum: ['relevance', 'popularity'],
          description:
            'How to order results. "relevance" (default) = best name match. "popularity" = best-selling first; use it for "what do you suggest?", "what is popular?", and for "popular AND <something>" when combined with `query`. Omitting `query` implies "popularity".',
        },
        max_price_cents: {
          type: 'integer',
          description: 'Only items at or below this base price, e.g. 1000 for "under $10".',
        },
        min_price_cents: { type: 'integer', description: 'Only items at or above this base price.' },
        limit: { type: 'integer', description: 'Max items to return (default 8, capped at 8).' },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.propose,
    description:
      'Finalize the turn with the cart operations to apply. Use menu_item_key/modifier_key values only from search results, and line_id values only from current_cart. Ends the turn. A short spoken confirmation MAY accompany the operations via the optional `reply` (e.g. "Added two lattes — anything else?"). If instead you need to ask a blocking question or make a pure recommendation with nothing to commit, do NOT call this — just reply with a spoken message.',
    parameters: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          description:
            'Cart operations: add_item (menu_item_key, quantity, optional inline modifiers), remove_item (line_id), update_quantity (line_id, quantity), add_modifier (line_id, modifier_key), remove_modifier (line_id, modifier_key).',
          items: { type: 'object' },
        },
        reply: {
          type: 'string',
          description:
            'Optional. A short (one friendly sentence) spoken confirmation to say while applying the operations, e.g. "Added two lattes — anything else?". Omit when there is nothing to say. Must not read totals or subtotals.',
        },
        language: {
          type: 'string',
          description:
            'ISO-639-1 code of the language `reply` is written in (e.g. "en", "zh"). Choose it BEFORE writing `reply`. Only meaningful when `reply` is present; a missing or malformed code falls back to the TTS default.',
        },
      },
      required: ['operations'],
    },
  },
];
