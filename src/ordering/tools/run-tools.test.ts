import { describe, it, expect } from 'vitest';
import { runTools } from './run-tools.js';
import { TOOL_NAMES } from './tool-specs.js';
import type { OrderStateType } from '../graph/state.js';
import type { AgentMessage, ToolCall } from '../../llm/llm-provider.js';
import type { MenuService } from '../../menu/menu-service.js';

// runTools only reaches MenuService on a `search_menu` call; every case here drives `propose_cart`,
// so a bare stub that would throw if touched is enough (and proves search is not on this path).
const menu = {} as MenuService;

const call = (args: unknown): ToolCall => ({ id: 'c0', name: TOOL_NAMES.propose, arguments: args });

/** A minimal in-progress turn state whose last message is the agent's `propose_cart` call. */
function stateWith(args: unknown): OrderStateType {
  const assistant: AgentMessage = { role: 'assistant', tool_calls: [call(args)] };
  return {
    request_id: 'req_1',
    cart_id: 'cart_1',
    pos_config_id: 1,
    output: null,
    reply: null,
    reply_language: undefined,
    agent_messages: [assistant],
  } as unknown as OrderStateType;
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
