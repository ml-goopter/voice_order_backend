import { describe, it, expect } from 'vitest';
import { buildOrderGraph } from './build-graph.js';
import type { OrderStateType } from './state.js';
import { MenuService } from '../../menu/menu-service.js';
import { InMemoryMenuStore } from '../../menu/in-memory-menu-store.js';
import { InMemoryCartCache } from '../../redis/cart-cache.js';
import type { MenuItem } from '../../menu/menu-types.js';
import type { AgentMessage, ChatResult, LlmPrompt, LlmProvider, ToolCall, ToolSpec } from '../../llm/llm-provider.js';
import { TOOL_NAMES } from '../tools/tool-specs.js';

const POS = 1;
const MENU: MenuItem[] = [
  {
    product_tmpl_id: 10,
    menu_item_key: 'chicken_burger',
    names: { en_US: 'Chicken Burger' },
    base_price_cents: 1000,
    available: true,
    modifiers: [],
  },
];

let idCounter = 0;
const toolCall = (name: string, args: unknown): ToolCall => ({ id: `c${idCounter++}`, name, arguments: args });

/** Replays one scripted `ChatResult[]` per agent turn, like the service-level fixture — a fresh
 *  agent turn is detected by the seed transcript carrying no assistant message yet. */
class ScriptedLlm implements LlmProvider {
  readonly name = 'scripted';
  readonly model = 'scripted';
  private turnIdx = -1;
  private stepIdx = 0;

  constructor(private readonly turnScripts: ChatResult[][]) {}

  async complete(_prompt: LlmPrompt): Promise<string> {
    return JSON.stringify({ intent: 'service' });
  }

  async chat(messages: AgentMessage[], _tools: ToolSpec[]): Promise<ChatResult> {
    const firstOfTurn = !messages.some((m) => m.role === 'assistant');
    if (firstOfTurn) {
      this.turnIdx += 1;
      this.stepIdx = 0;
    }
    const script = this.turnScripts[this.turnIdx] ?? [];
    const res = script[this.stepIdx] ?? { toolCalls: [] };
    this.stepIdx += 1;
    return res;
  }
}

function buildTestGraph(turnScripts: ChatResult[][]) {
  const menu = new MenuService(InMemoryMenuStore.of(POS, MENU));
  const carts = new InMemoryCartCache();
  const llm = new ScriptedLlm(turnScripts);
  return buildOrderGraph({ menu, llm, intentLlm: llm, carts });
}

function invoke(graph: ReturnType<typeof buildOrderGraph>, cart_id: string, request_id: string, text: string) {
  return graph.invoke(
    { request_id, session_id: 'sess_1', cart_id, pos_config_id: POS, customer_text: text, supported_languages: [] },
    { configurable: { thread_id: `${POS}:${cart_id}` } },
  ) as Promise<OrderStateType>;
}

describe('build-graph — search_results turn-scoping', () => {
  it('normalize clears search_results for a fresh turn (no cross-turn leak)', async () => {
    const search: ChatResult = { toolCalls: [toolCall(TOOL_NAMES.search, { query: 'chicken burger' })] };
    const spoken = (text: string): ChatResult => ({ text: JSON.stringify({ reply: text, language: 'en' }), toolCalls: [] });

    const graph = buildTestGraph([[search, spoken('Here is a chicken burger.')], [spoken('Anything else?')]]);

    const turn1 = await invoke(graph, 'cart_1', 'req_1', 'do you have burgers');
    expect(Object.keys(turn1.search_results)).toEqual(['chicken_burger']);

    const turn2 = await invoke(graph, 'cart_1', 'req_2', 'no thanks');
    expect(turn2.search_results).toEqual({});
  });
});
