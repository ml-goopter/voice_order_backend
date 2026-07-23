import { describe, it, expect, vi } from 'vitest';
import { runTools } from './run-tools.js';
import { TOOL_NAMES } from './tool-specs.js';
import type { OrderStateType } from '../graph/state.js';
import type { AgentMessage, ToolCall } from '../../llm/llm-provider.js';
import type { MenuService } from '../../menu/menu-service.js';
import type { CandidateItem } from '../../menu/menu-types.js';
import type { MentionedItem } from '../../contracts/mentioned-item.js';
import { toMentionedItem } from '../mentioned-items.js';
import { logger } from '../../config/logger.js';

// runTools only reaches MenuService on a `search_menu` call, so the propose-only cases below can
// use a bare stub that would throw if touched (which proves search is not on that path). The
// search cases build their own stub with `menuReturning`.
const menu = {} as MenuService;

const call = (args: unknown): ToolCall => ({ id: 'c0', name: TOOL_NAMES.propose, arguments: args });

/** A minimal in-progress turn state whose last message is the agent's `propose_cart` call.
 *  `priorSearches` stands in for what earlier agent steps in the same turn already found. */
function stateWith(args: unknown, priorSearches: Record<string, MentionedItem> = {}): OrderStateType {
  const assistant: AgentMessage = { role: 'assistant', tool_calls: [call(args)] };
  return {
    request_id: 'req_1',
    cart_id: 'cart_1',
    pos_config_id: 1,
    output: null,
    reply: null,
    reply_language: undefined,
    search_results: priorSearches,
    agent_messages: [assistant],
  } as unknown as OrderStateType;
}

let searchCallId = 0;
const searchCall = (args: unknown): ToolCall => ({ id: `s${searchCallId++}`, name: TOOL_NAMES.search, arguments: args });

/** A minimal in-progress turn state whose last message is a batch of `search_menu` calls. */
function stateWithSearches(
  calls: ToolCall[],
  priorSearches: Record<string, MentionedItem> = {},
): OrderStateType {
  const assistant: AgentMessage = { role: 'assistant', tool_calls: calls };
  return {
    request_id: 'req_1',
    cart_id: 'cart_1',
    pos_config_id: 1,
    output: null,
    reply: null,
    reply_language: undefined,
    search_results: priorSearches,
    agent_messages: [assistant],
  } as unknown as OrderStateType;
}

const candidate = (key: string, name: string): CandidateItem => ({
  menu_item_key: key,
  product_tmpl_id: 1,
  name,
  base_price_cents: 500,
  available_modifiers: [],
});

/** A `MenuService` stub whose `searchMenu` returns one scripted item set per call, in order. */
function menuReturning(...sets: CandidateItem[][]): MenuService {
  let i = 0;
  return {
    searchMenu: async () => ({ items: sets[i++] ?? [] }),
  } as unknown as MenuService;
}

const OPS = [{ action: 'add_item', menu_item_key: 'latte', quantity: 2, modifiers: [] }];

describe('runTools — bundled propose_cart reply (approach B)', () => {
  it('sets output AND reply/reply_language when propose_cart carries a valid reply + language', async () => {
    const patch = await runTools(menu, stateWith({ operations: OPS, reply: 'Added two lattes — anything else?', language: 'en' }));

    expect(patch.output?.operations).toHaveLength(1);
    expect(patch.reply).toBe('Added two lattes — anything else?');
    expect(patch.reply_language).toBe('en');
  });

  it('sets output only when the reply is blank/whitespace (no confirmation, not an error)', async () => {
    const patch = await runTools(menu, stateWith({ operations: OPS, reply: '   ' }));

    expect(patch.output?.operations).toHaveLength(1);
    expect(patch.reply).toBeUndefined();
    expect(patch.reply_language).toBeUndefined();
  });

  it('keeps the reply but drops a malformed language', async () => {
    const patch = await runTools(menu, stateWith({ operations: OPS, reply: 'Added two lattes.', language: 'Chinese' }));

    expect(patch.output?.operations).toHaveLength(1);
    expect(patch.reply).toBe('Added two lattes.');
    expect(patch.reply_language).toBeUndefined();
  });

  it('ignores language when there is no reply (language is only meaningful with a reply)', async () => {
    const patch = await runTools(menu, stateWith({ operations: OPS, language: 'en' }));

    expect(patch.output?.operations).toHaveLength(1);
    expect(patch.reply).toBeUndefined();
    expect(patch.reply_language).toBeUndefined();
  });

  it('rejects an empty operations array as a retriable tool error (no output, no reply)', async () => {
    const patch = await runTools(menu, stateWith({ operations: [], reply: 'Done!' }));

    expect(patch.output).toBeNull();
    expect(patch.reply).toBeUndefined();
    // The tool result fed back to the agent is the retriable validation error.
    const toolMsg = patch.agent_messages?.at(-1);
    expect(toolMsg?.role).toBe('tool');
    expect((toolMsg as { content: string }).content).toContain('at least one operation');
  });
});

describe('runTools — search_results accumulation', () => {
  it('accumulates two search_menu calls in one batch into the map', async () => {
    const stub = menuReturning([candidate('burger', 'Burger')], [candidate('coke', 'Coke')]);
    const state = stateWithSearches([searchCall({ query: 'burger' }), searchCall({ query: 'coke' })]);

    const patch = await runTools(stub, state);

    expect(Object.keys(patch.search_results ?? {}).sort()).toEqual(['burger', 'coke']);
    expect(patch.search_results?.burger).toEqual({
      menu_item_key: 'burger',
      product_tmpl_id: 1,
      name: 'Burger',
      base_price_cents: 500,
    });
  });

  it('keeps the later call\'s item on a menu_item_key collision', async () => {
    const stub = menuReturning([candidate('x', 'First')], [candidate('x', 'Second')]);
    const state = stateWithSearches([searchCall({ query: 'a' }), searchCall({ query: 'b' })]);

    const patch = await runTools(stub, state);

    expect(patch.search_results?.x?.name).toBe('Second');
  });

  // The multi-item flow: one search per item across several agent steps. A step that drops what
  // earlier steps found would leave later verification with nothing to check the agent's keys against.
  it('keeps what earlier steps in the same turn found', async () => {
    const prior = { burger: toMentionedItem(candidate('burger', 'Burger')) };
    const stub = menuReturning([candidate('coke', 'Coke')]);

    const patch = await runTools(stub, stateWithSearches([searchCall({ query: 'coke' })], prior));

    expect(Object.keys(patch.search_results ?? {}).sort()).toEqual(['burger', 'coke']);
  });

  // A propose_cart-only batch is the normal second step of a turn. Writing an empty map there would
  // wipe the searches the turn is about to be verified against, so the key must be absent entirely
  // and leave the channel alone.
  it('leaves the channel untouched when the batch ran no search', async () => {
    const prior = { burger: toMentionedItem(candidate('burger', 'Burger')) };

    const patch = await runTools(menu, stateWith({ operations: [{ action: 'add_item', menu_item_key: 'burger', quantity: 1 }] }, prior));

    expect('search_results' in patch).toBe(false);
  });
});

describe('runTools — mentioned_items resolution (propose_cart bundled reply)', () => {
  it('resolves [known, unknown, known] to exactly one item, deduped', async () => {
    const known = { burger: toMentionedItem(candidate('burger', 'Burger')) };

    const patch = await runTools(
      menu,
      stateWith({ operations: OPS, reply: 'Here you go.', mentioned_items: ['burger', 'ghost', 'burger'] }, known),
    );

    expect(patch.output?.operations).toHaveLength(1);
    expect(patch.mentioned_items).toEqual([known.burger]);
  });

  it('resolves nothing when propose_cart names keys but bundles no reply', async () => {
    const known = { burger: toMentionedItem(candidate('burger', 'Burger')) };

    const patch = await runTools(menu, stateWith({ operations: OPS, mentioned_items: ['burger'] }, known));

    expect(patch.output?.operations).toHaveLength(1);
    expect(patch.mentioned_items).toBeUndefined();
  });

  it('still commits its operations when the reply names a key that was never searched', async () => {
    const patch = await runTools(
      menu,
      stateWith({ operations: OPS, reply: 'You might like the ghost item.', mentioned_items: ['ghost'] }),
    );

    expect(patch.output?.operations).toHaveLength(1);
    expect(patch.mentioned_items).toEqual([]);
  });

  // A search and the terminal propose_cart can land in the SAME batch; resolution must see that
  // batch's own search, not just what entered the turn (the turn's persisted search_results).
  it("resolves against this batch's own search, not just what entered the turn", async () => {
    const stub = menuReturning([candidate('burger', 'Burger')]);
    const calls = [
      searchCall({ query: 'burger' }),
      call({ operations: OPS, reply: 'Added a burger.', mentioned_items: ['burger'] }),
    ];

    const patch = await runTools(stub, stateWithSearches(calls));

    expect(patch.output?.operations).toHaveLength(1);
    expect(patch.mentioned_items).toEqual([toMentionedItem(candidate('burger', 'Burger'))]);
  });

  it('logs the resolved count and the turn ids on the tool line', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const known = { burger: toMentionedItem(candidate('burger', 'Burger')) };

    await runTools(menu, stateWith({ operations: OPS, reply: 'Here you go.', mentioned_items: ['burger', 'ghost'] }, known));

    expect(info).toHaveBeenCalledWith(
      'order.agent_tool',
      expect.objectContaining({ mentioned_items: 1, request_id: 'req_1', cart_id: 'cart_1' }),
    );
    info.mockRestore();
  });
});
