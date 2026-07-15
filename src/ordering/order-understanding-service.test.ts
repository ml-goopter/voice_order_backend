import { describe, it, expect } from 'vitest';
import { EventBus } from '../events/event-bus.js';
import type { AppEventMap, AppEventName } from '../events/event-types.js';
import { InMemoryCartCache } from '../redis/cart-cache.js';
import { MenuService } from '../menu/menu-service.js';
import { InMemoryMenuStore } from '../menu/in-memory-menu-store.js';
import type { MenuItem } from '../menu/menu-types.js';
import type { Cart } from '../cart/cart-types.js';
import type { AgentMessage, ChatResult, LlmPrompt, LlmProvider, ToolCall, ToolSpec } from '../llm/llm-provider.js';
import type { Intent } from './graph/intents.js';
import { OrderGraph } from './order-graph.js';
import { OrderUnderstandingService } from './order-understanding-service.js';
import { LIMITS } from '../config/constants.js';

const POS = 1;
const MENU: MenuItem[] = [
  {
    product_tmpl_id: 10,
    menu_item_key: 'chicken_burger',
    names: { en_US: 'Chicken Burger' },
    base_price_cents: 1000,
    available: true,
    modifiers: [{ modifier_key: 'no_mayo', ptav_id: 1, name: 'No mayo', price_extra_cents: 0 }],
  },
  {
    product_tmpl_id: 12,
    menu_item_key: 'coke',
    names: { en_US: 'Coke' },
    base_price_cents: 300,
    available: true,
    modifiers: [],
  },
];

// ── scripted agent turns ─────────────────────────────────────────────────────
let idCounter = 0;
const call = (name: string, args: unknown): ToolCall => ({ id: `c${idCounter++}`, name, arguments: args });
const search = (query: string): ChatResult => ({ toolCalls: [call('search_menu_semantic', { query })] });
const propose = (operations: unknown[]): ChatResult => ({ toolCalls: [call('propose_cart', { operations })] });
/** The agent ends the turn by SPEAKING (no tool call). Plain text is the DEGRADE path (the prompt
 *  asks for JSON) — still a valid reply, just with no declared language. */
const reply = (text: string): ChatResult => ({ text, toolCalls: [] });
/** The agent speaking in the format it is actually prompted for: strict JSON {reply, language}. */
const jsonReply = (text: string, language: string): ChatResult => ({
  text: JSON.stringify({ reply: text, language }),
  toolCalls: [],
});

/** Captured agent user-context (the seed `user` message JSON) for one turn. */
interface TurnContext {
  customer_text: string;
  current_cart: { items: unknown[] };
  conversation_history: Array<{ customer_text: string; agent_reply?: string }>;
}

/**
 * A fake LLM that (a) answers the intent classifier via `complete` from `intentFor`, and (b) drives
 * the tool-calling agent via `chat`, replaying one scripted `ChatResult[]` per AGENT turn. A fresh
 * agent turn is detected by the seed transcript carrying no assistant message yet; within a turn,
 * successive `chat` calls consume successive entries of that turn's script. Junk turns never reach
 * the agent, so they consume no script. The seed `user` context of each agent turn is captured for
 * assertions.
 */
class ScriptedLlm implements LlmProvider {
  readonly name = 'scripted';
  readonly contexts: TurnContext[] = [];
  chatCalls = 0;
  private turnIdx = -1;
  private stepIdx = 0;

  constructor(
    private readonly turnScripts: ChatResult[][],
    private readonly intentFor: (text: string) => Intent = () => 'order',
  ) {}

  async complete(prompt: LlmPrompt): Promise<string> {
    const { customer_text } = JSON.parse(prompt.user) as { customer_text: string };
    return JSON.stringify({ intent: this.intentFor(customer_text) });
  }

  async chat(messages: AgentMessage[], _tools: ToolSpec[]): Promise<ChatResult> {
    this.chatCalls += 1;
    const firstOfTurn = !messages.some((m) => m.role === 'assistant');
    if (firstOfTurn) {
      this.turnIdx += 1;
      this.stepIdx = 0;
      const userMsg = messages.find((m) => m.role === 'user') as { content: string } | undefined;
      if (userMsg) this.contexts.push(JSON.parse(userMsg.content) as TurnContext);
    }
    const script = this.turnScripts[this.turnIdx] ?? [];
    const res = script[this.stepIdx] ?? { toolCalls: [] };
    this.stepIdx += 1;
    return res;
  }
}

async function makeService(
  turnScripts: ChatResult[][],
  seedCart?: Cart,
  intentFor: (text: string) => Intent = () => 'order',
) {
  const menu = new MenuService(InMemoryMenuStore.of(POS, MENU));
  const carts = new InMemoryCartCache();
  if (seedCart) await carts.set(seedCart);
  const llm = new ScriptedLlm(turnScripts, intentFor);
  const bus = new EventBus();
  const graph = new OrderGraph(menu, llm, carts);
  const service = new OrderUnderstandingService(graph, bus);
  return { service, bus, llm, carts };
}

/** Collect every payload emitted for an event during the test. */
function collect<K extends AppEventName>(bus: EventBus, name: K): AppEventMap[K][] {
  const out: AppEventMap[K][] = [];
  bus.on(name, (p) => out.push(p));
  return out;
}

function transcript(text: string, over: Partial<AppEventMap['stt.final_transcript.received']> = {}) {
  return {
    request_id: 'req_1',
    session_id: 'sess_1',
    cart_id: 'cart_1',
    pos_config_id: POS,
    text,
    ...over,
  };
}

function cartWith(version: number, lines: Cart['items'] = []): Cart {
  return {
    cart_id: 'cart_1',
    pos_config_id: POS,
    version,
    items: lines,
    subtotal_cents: 0,
    tax_cents: 0,
    total_cents: 0,
    last_updated: '2026-07-07T00:00:00.000Z',
  };
}

describe('OrderUnderstandingService', () => {
  it('proposes operations on the happy path with base_version from the loaded cart', async () => {
    const ops = [
      { action: 'add_item', menu_item_key: 'chicken_burger', quantity: 1, modifiers: [] },
      { action: 'add_item', menu_item_key: 'chicken_burger', quantity: 1, modifiers: [{ modifier_key: 'no_mayo' }] },
    ];
    const { service, bus, llm } = await makeService([[search('chicken burger'), propose(ops)]], cartWith(6));
    const proposed = collect(bus, 'order.operations_proposed');

    await service.handleFinalTranscript(transcript('add two chicken burgers, one without mayo'));

    expect(proposed).toHaveLength(1);
    // request_id/cart_id are hoisted to the top level so the event bus can trace the turn.
    expect(proposed[0]).toMatchObject({ request_id: 'req_1', cart_id: 'cart_1' });
    expect(proposed[0]!.proposal.base_version).toBe(6);
    expect(proposed[0]!.proposal.operations).toHaveLength(2);
    expect(proposed[0]!.proposal.operations[1]).toMatchObject({
      action: 'add_item',
      menu_item_key: 'chicken_burger',
      modifiers: [{ modifier_key: 'no_mayo' }],
    });
    expect(llm.chatCalls).toBe(2); // one search, one propose
  });

  it('passes edit operations that target a line_id straight through', async () => {
    const seeded = cartWith(3, [{ line_id: 'ln_1', product_tmpl_id: 10, quantity: 1, modifiers: [] }]);
    const { service, bus } = await makeService(
      [[propose([{ action: 'update_quantity', line_id: 'ln_1', quantity: 2 }])]],
      seeded,
    );
    const proposed = collect(bus, 'order.operations_proposed');

    await service.handleFinalTranscript(transcript('make that a double'));

    expect(proposed[0]!.proposal.base_version).toBe(3);
    expect(proposed[0]!.proposal.operations[0]).toEqual({ action: 'update_quantity', line_id: 'ln_1', quantity: 2 });
  });

  it('emits a spoken reply (clarify/suggest) and ends the turn without waiting; the next transcript answers it', async () => {
    const resolved = propose([{ action: 'add_item', menu_item_key: 'chicken_burger', quantity: 2, modifiers: [] }]);
    const { service, bus, llm } = await makeService(
      [[reply('One without mayo, or both?')], [resolved]],
      cartWith(1),
    );
    const replies = collect(bus, 'order.reply');
    const proposed = collect(bus, 'order.operations_proposed');
    const failed = collect(bus, 'voice.session_failed');

    // Turn 1: the agent speaks. It emits the reply and returns — no blocking, no proposal, no timeout.
    await service.handleFinalTranscript(transcript('two burgers no mayo', { request_id: 'req_1' }));
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ reply: 'One without mayo, or both?' });
    expect(proposed).toHaveLength(0);
    expect(failed).toHaveLength(0);

    // Turn 2: an ordinary transcript IS the answer.
    await service.handleFinalTranscript(transcript('both', { request_id: 'req_2' }));

    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.proposal.operations[0]).toMatchObject({ action: 'add_item', quantity: 2 });
    // The resolving turn's agent context carries the prior reply in conversation_history so the
    // agent can resolve the current utterance against it.
    expect(llm.contexts[1]!.conversation_history).toEqual([
      { customer_text: 'two burgers no mayo', agent_reply: 'One without mayo, or both?' },
    ]);
  });

  it('retries a schema-invalid propose_cart as a tool error, then proposes', async () => {
    // First propose has an invalid operation (missing quantity); the tool error loops the agent,
    // which then proposes a valid operation — all within maxAgentSteps.
    const bad = propose([{ action: 'add_item', menu_item_key: 'coke', modifiers: [] }]);
    const good = propose([{ action: 'add_item', menu_item_key: 'coke', quantity: 1, modifiers: [] }]);
    const { service, bus, llm } = await makeService([[bad, good]], cartWith(0));
    const proposed = collect(bus, 'order.operations_proposed');
    const failed = collect(bus, 'voice.session_failed');

    await service.handleFinalTranscript(transcript('a coke'));

    expect(failed).toHaveLength(0);
    expect(proposed).toHaveLength(1);
    expect(llm.chatCalls).toBe(2); // invalid propose + valid propose
  });

  it('rejects an empty propose_cart as a tool error instead of proposing nothing', async () => {
    // A propose_cart with no operations must not "succeed" as an empty proposal (which would
    // silently drop the customer's request); it loops the agent, which then proposes for real.
    const empty = propose([]);
    const good = propose([{ action: 'add_item', menu_item_key: 'coke', quantity: 1, modifiers: [] }]);
    const { service, bus, llm } = await makeService([[empty, good]], cartWith(0));
    const proposed = collect(bus, 'order.operations_proposed');
    const failed = collect(bus, 'voice.session_failed');

    await service.handleFinalTranscript(transcript('a coke'));

    expect(failed).toHaveLength(0);
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.proposal.operations).toHaveLength(1);
    expect(llm.chatCalls).toBe(2); // empty propose (tool error) + valid propose
  });

  it('fails the turn when the agent never commits a valid terminal (step limit)', async () => {
    const bad = propose([{ action: 'add_item', menu_item_key: 'coke', modifiers: [] }]); // always invalid
    // One more invalid propose than the step budget, so every agent turn makes a (rejected) tool
    // call and the loop bails on the step limit rather than on an empty reply.
    const script = Array.from({ length: LIMITS.maxAgentSteps + 1 }, () => bad);
    const { service, bus, llm } = await makeService([script], cartWith(0));
    const proposed = collect(bus, 'order.operations_proposed');
    const failed = collect(bus, 'voice.session_failed');

    await service.handleFinalTranscript(transcript('a coke'));

    expect(proposed).toHaveLength(0);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toBe('agent_step_limit');
    expect(llm.chatCalls).toBe(LIMITS.maxAgentSteps); // maxAgentSteps LLM turns, then the loop bails
  });

  it('serializes turns per cart: turn 2 loads the base_version turn 1 produced', async () => {
    const add = (key: string) => propose([{ action: 'add_item', menu_item_key: key, quantity: 1, modifiers: [] }]);
    const { service, bus, carts } = await makeService([[add('chicken_burger')], [add('coke')]], cartWith(5));

    // Simulate the Cart Module applying turn 1: bump the cart version synchronously
    // when its proposal lands, before the FIFO releases to turn 2.
    const versions: number[] = [];
    bus.on('order.operations_proposed', async (e) => {
      versions.push(e.proposal.base_version);
      const cur = (await carts.get('cart_1'))!;
      await carts.set({ ...cur, version: cur.version + 1 });
    });

    // Enqueue both turns back-to-back without awaiting the first.
    const t1 = service.handleFinalTranscript(transcript('a burger', { request_id: 'req_1' }));
    const t2 = service.handleFinalTranscript(transcript('a coke', { request_id: 'req_2' }));
    await Promise.all([t1, t2]);

    expect(versions).toEqual([5, 6]); // turn 2 saw turn 1's bump → FIFO held
  });

  it('force-orders only the turn immediately after a reply; a later fresh junk utterance still short-circuits', async () => {
    const resolve = propose([{ action: 'add_item', menu_item_key: 'chicken_burger', quantity: 2, modifiers: [] }]);
    // Turn 1 replies; turn 2 answers it (proposes, recording NO agent_reply); turn 3 is fresh.
    // The classifier calls turn 3 'junk' — and since turn 2 left no pending reply, that stands.
    const { service, bus, llm } = await makeService(
      [[reply('one or both?')], [resolve]],
      cartWith(0),
      (t) => (t === 'a coke' ? 'junk' : 'order'),
    );
    const proposed = collect(bus, 'order.operations_proposed');

    await service.handleFinalTranscript(transcript('two burgers no mayo', { request_id: 'req_1' })); // reply
    await service.handleFinalTranscript(transcript('both', { request_id: 'req_2' })); // answers it → propose
    await service.handleFinalTranscript(transcript('a coke', { request_id: 'req_3' })); // fresh, junk

    // Turn 2 proposed (no pending reply), so turn 3 is classified normally: junk → the agent never
    // runs for it. Only turns 1 and 2 reached the agent.
    expect(proposed).toHaveLength(1);
    expect(llm.contexts).toHaveLength(2);
  });

  it('persists each turn to conversation history and sends it to the next turn', async () => {
    const add = (key: string) => propose([{ action: 'add_item', menu_item_key: key, quantity: 1, modifiers: [] }]);
    const { service, llm } = await makeService([[add('chicken_burger')], [add('coke')]], cartWith(0));

    await service.handleFinalTranscript(transcript('a chicken burger', { request_id: 'req_1' }));
    await service.handleFinalTranscript(transcript('and a coke', { request_id: 'req_2' }));

    // Turn 1 saw no history; turn 2 sees turn 1's utterance (no clarification answer).
    expect(llm.contexts[0]!.conversation_history).toEqual([]);
    expect(llm.contexts[1]!.conversation_history).toEqual([{ customer_text: 'a chicken burger' }]);
  });

  it('renders a self-describing cart line (name + keys + modifiers, no numeric ids)', async () => {
    const seeded = cartWith(2, [{ line_id: 'ln_1', product_tmpl_id: 10, quantity: 1, modifiers: [{ ptav_id: 1 }] }]);
    const { service, llm } = await makeService(
      [[propose([{ action: 'update_quantity', line_id: 'ln_1', quantity: 2 }])]],
      seeded,
    );

    await service.handleFinalTranscript(transcript('make the chicken burger two'));

    const cart = llm.contexts[0]!.current_cart;
    expect(cart.items).toEqual([
      {
        line_id: 'ln_1',
        menu_item_key: 'chicken_burger',
        name: 'Chicken Burger',
        quantity: 1,
        modifiers: [{ modifier_key: 'no_mayo', name: 'No mayo' }],
        available_modifiers: [{ modifier_key: 'no_mayo', name: 'No mayo' }],
      },
    ]);
    // Numeric product_tmpl_id / ptav_id must not reach the prompt.
    expect(JSON.stringify(cart)).not.toContain('product_tmpl_id');
    expect(JSON.stringify(cart)).not.toContain('ptav_id');
  });

  it('does not report a failure when a proposal subscriber throws', async () => {
    const good = propose([{ action: 'add_item', menu_item_key: 'coke', quantity: 1, modifiers: [] }]);
    const { service, bus } = await makeService([[good]], cartWith(0));
    const failed = collect(bus, 'voice.session_failed');
    bus.on('order.operations_proposed', () => {
      throw new Error('subscriber boom');
    });

    // The throw propagates out of the turn; it must NOT be caught as a turn failure.
    await service.handleFinalTranscript(transcript('a coke')).catch(() => undefined);

    expect(failed).toHaveLength(0);
  });

  it('short-circuits a junk utterance: no proposal, no failure, and the agent never runs', async () => {
    // No agent script — if the utterance were not short-circuited the agent would have nothing to do.
    const { service, bus, llm } = await makeService([], cartWith(0), () => 'junk');
    const proposed = collect(bus, 'order.operations_proposed');
    const failed = collect(bus, 'voice.session_failed');

    await service.handleFinalTranscript(transcript('uh, hello, is anyone there'));

    expect(proposed).toHaveLength(0);
    expect(failed).toHaveLength(0);
    expect(llm.chatCalls).toBe(0); // routed classify → END, the agent never ran
  });

  it('emits a spoken reply (and no proposal/failure) when the agent recommends instead of proposing', async () => {
    const { service, bus, llm } = await makeService(
      [[search('coke'), reply('How about a Coke?')]],
      cartWith(0),
      () => 'suggest',
    );
    const proposed = collect(bus, 'order.operations_proposed');
    const failed = collect(bus, 'voice.session_failed');
    const replies = collect(bus, 'order.reply');

    await service.handleFinalTranscript(transcript('what do you recommend, maybe a coke'));

    expect(proposed).toHaveLength(0);
    expect(failed).toHaveLength(0);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ cart_id: 'cart_1', request_id: 'req_1', reply: 'How about a Coke?' });
    expect(llm.chatCalls).toBe(2); // one search, then the spoken reply
  });

  it("speaks only the reply text, in the agent's declared language", async () => {
    // The STT language is unreliable (the default AssemblyAI streaming model says `en` for
    // everything), so the agent — which wrote the reply — declares the language it used. There is
    // no STT language to out-rank here: `SttFinalTranscriptReceived` no longer carries one at all,
    // so the type system, not this test, is what rules STT out as a source.
    const { service, bus } = await makeService([[jsonReply('您想要什么饮料?', 'zh')]], cartWith(0));
    const replies = collect(bus, 'order.reply');

    await service.handleFinalTranscript(transcript('我想要一个鸡肉汉堡'));

    expect(replies).toHaveLength(1);
    // The JSON envelope is parsed away: the customer hears the words, not the blob.
    expect(replies[0]).toMatchObject({ reply: '您想要什么饮料?', language: 'zh' });
  });

  it('falls back to TTS_LANGUAGE when the agent declares none', async () => {
    // A plain-text reply declares no language, so the configured default (`TTS_LANGUAGE`, `en`
    // here) decides what it is spoken in — never a hardcoded `en`, so an operator who set
    // TTS_LANGUAGE still gets their language.
    const { service, bus } = await makeService([[reply('One without mayo, or both?')]], cartWith(0));
    const replies = collect(bus, 'order.reply');

    await service.handleFinalTranscript(transcript('two burgers no mayo'));

    expect(replies[0]).toMatchObject({ reply: 'One without mayo, or both?', language: 'en' });
  });

  it('does not carry an agent-declared language into a later turn that declares none', async () => {
    // A declaration is evidence about the turn that made it, so it must not outlive that turn.
    // Turn 2's agent declares nothing, so its English reply must fall back to TTS_LANGUAGE (`en`)
    // — if turn 1's `zh` survived, the English sentence would be spoken in Chinese.
    const { service, bus } = await makeService(
      [[jsonReply('您想要什么饮料?', 'zh')], [reply('Sure, anything else?')]],
      cartWith(0),
    );
    const replies = collect(bus, 'order.reply');

    await service.handleFinalTranscript(transcript('我想要一个鸡肉汉堡'));
    await service.handleFinalTranscript(transcript('yes that is all thanks'));

    expect(replies[0]).toMatchObject({ reply: '您想要什么饮料?', language: 'zh' });
    expect(replies[1]).toMatchObject({ reply: 'Sure, anything else?', language: 'en' });
  });

  it("records the agent's reply to history so the next turn can resolve a reference to it", async () => {
    // Turn 1 recommends a coke (spoken reply); turn 2 ("that one") is an ordinary order whose agent
    // must see the prior reply in conversation_history to resolve the reference.
    const order = propose([{ action: 'add_item', menu_item_key: 'coke', quantity: 1, modifiers: [] }]);
    const { service, llm } = await makeService(
      [[search('coke'), reply('How about a Coke?')], [order]],
      cartWith(0),
      () => 'order', // turn 2 is force-ordered anyway (turn 1 left a pending reply)
    );

    await service.handleFinalTranscript(transcript('what should I get, maybe a coke', { request_id: 'req_1' }));
    await service.handleFinalTranscript(transcript('that one', { request_id: 'req_2' }));

    // The order turn's agent context carries the prior spoken reply.
    expect(llm.contexts[1]!.conversation_history).toEqual([
      { customer_text: 'what should I get, maybe a coke', agent_reply: 'How about a Coke?' },
    ]);
  });

  it('forces order (skips the classifier) after a reply, so a terse answer is not dropped as junk', async () => {
    const resolve = propose([{ action: 'add_item', menu_item_key: 'chicken_burger', quantity: 2, modifiers: [] }]);
    // The classifier would label the terse answer "both" as junk; the pending reply must override
    // that and run the agent so the answer resolves the order.
    const { service, bus } = await makeService(
      [[reply('one or both?')], [resolve]],
      cartWith(0),
      (t) => (t === 'both' ? 'junk' : 'order'),
    );
    const proposed = collect(bus, 'order.operations_proposed');

    await service.handleFinalTranscript(transcript('two burgers no mayo', { request_id: 'req_1' }));
    await service.handleFinalTranscript(transcript('both', { request_id: 'req_2' }));

    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.proposal.operations[0]).toMatchObject({ action: 'add_item', quantity: 2 });
  });
});
