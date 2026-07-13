import { describe, it, expect } from 'vitest';
import { generateSuggestion } from './suggest.node.js';
import type { SuggestionPromptInput } from '../../llm/suggestion-prompt-builder.js';
import type { LlmPrompt, LlmProvider } from '../../llm/llm-provider.js';
import type { CandidateItem } from '../../menu/menu-types.js';

/** An LlmProvider whose single reply is fixed (or throws). */
function fakeLlm(reply: string | (() => Promise<string>)): LlmProvider {
  return {
    name: 'fake',
    complete: (_prompt: LlmPrompt) => (typeof reply === 'string' ? Promise.resolve(reply) : reply()),
  };
}

const CANDIDATES: CandidateItem[] = [
  { menu_item_key: 'chicken_burger', product_tmpl_id: 10, name: 'Chicken Burger', available_modifiers: [] },
  { menu_item_key: 'coke', product_tmpl_id: 12, name: 'Coke', available_modifiers: [] },
];

function input(over: Partial<SuggestionPromptInput> = {}): SuggestionPromptInput {
  return {
    customer_text: 'what do you recommend',
    current_cart: { cart_id: 'cart_1', pos_config_id: 1, version: 0, items: [] },
    candidate_items: CANDIDATES,
    history: [],
    ...over,
  };
}

describe('generateSuggestion', () => {
  it('returns the validated suggestion for well-formed output', async () => {
    const llm = fakeLlm(
      JSON.stringify({ reply: 'The chicken burger is great.', items: [{ menu_item_key: 'chicken_burger', name: 'Chicken Burger' }] }),
    );
    expect(await generateSuggestion(llm, input())).toEqual({
      reply: 'The chicken burger is great.',
      items: [{ menu_item_key: 'chicken_burger', name: 'Chicken Burger' }],
    });
  });

  it('drops recommended items that are not among the candidates', async () => {
    const llm = fakeLlm(
      JSON.stringify({
        reply: 'Try these.',
        items: [
          { menu_item_key: 'coke', name: 'Coke' },
          { menu_item_key: 'lobster', name: 'Lobster' }, // not a candidate
        ],
      }),
    );
    const out = await generateSuggestion(llm, input());
    expect(out.items).toEqual([{ menu_item_key: 'coke', name: 'Coke' }]);
  });

  it('takes the item name from the candidate (menu), not the model echo, and dedups by key', async () => {
    const llm = fakeLlm(
      JSON.stringify({
        reply: 'A coke.',
        items: [
          { menu_item_key: 'coke', name: 'Diet Coke' }, // wrong name — should be replaced
          { menu_item_key: 'coke', name: 'Coke' }, // duplicate key — should be dropped
        ],
      }),
    );
    const out = await generateSuggestion(llm, input());
    expect(out.items).toEqual([{ menu_item_key: 'coke', name: 'Coke' }]);
  });

  it('defaults items to [] when the model omits them', async () => {
    const llm = fakeLlm(JSON.stringify({ reply: 'How about a coke?' }));
    expect(await generateSuggestion(llm, input())).toEqual({ reply: 'How about a coke?', items: [] });
  });

  it('degrades to a fallback reply on non-JSON output', async () => {
    const out = await generateSuggestion(fakeLlm('not json at all'), input());
    expect(out.items).toEqual([]);
    expect(out.reply.length).toBeGreaterThan(0);
  });

  it('degrades to a fallback reply on a schema miss (missing reply)', async () => {
    const out = await generateSuggestion(fakeLlm(JSON.stringify({ items: [] })), input());
    expect(out.items).toEqual([]);
    expect(out.reply.length).toBeGreaterThan(0);
  });

  it('degrades to a fallback reply when the LLM call throws', async () => {
    const llm = fakeLlm(() => Promise.reject(new Error('boom')));
    const out = await generateSuggestion(llm, input());
    expect(out.items).toEqual([]);
    expect(out.reply.length).toBeGreaterThan(0);
  });
});
