import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus } from '../events/event-bus.js';
import type { AppEventMap, AppEventName } from '../events/event-types.js';
import { InMemoryCartCache } from '../redis/cart-cache.js';
import { MenuService } from '../menu/menu-service.js';
import { InMemoryMenuStore } from '../menu/in-memory-menu-store.js';
import type { MenuItem } from '../menu/menu-types.js';
import type { Cart } from '../cart/cart-types.js';
import type { LlmPrompt, LlmProvider } from '../llm/llm-provider.js';
import { OrderGraph } from './order-graph.js';
import { OrderUnderstandingService } from './order-understanding-service.js';
import { TIMEOUTS } from '../config/constants.js';

const POS = 1;
const MENU: MenuItem[] = [
  {
    product_tmpl_id: 10,
    menu_item_key: 'chicken_burger',
    names: { en_US: 'Chicken Burger' },
    base_price_cents: 1000,
    available: true,
    modifiers: [{ modifier_key: 'no_mayo', ptav_id: 1, name: 'No mayo' }],
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

/** A fake LLM that replays scripted JSON responses in order and records its calls. */
class ScriptedLlm implements LlmProvider {
  readonly name = 'scripted';
  readonly prompts: LlmPrompt[] = [];
  constructor(private readonly responses: string[]) {}
  get calls(): number {
    return this.prompts.length;
  }
  async complete(prompt: LlmPrompt): Promise<string> {
    this.prompts.push(prompt);
    const next = this.responses.shift();
    if (next === undefined) throw new Error('ScriptedLlm: no response left');
    return next;
  }
}

async function makeService(responses: string[], seedCart?: Cart) {
  const menu = new MenuService(InMemoryMenuStore.of(POS, MENU));
  const carts = new InMemoryCartCache();
  if (seedCart) await carts.set(seedCart);
  const llm = new ScriptedLlm(responses);
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

/** Resolve once the named event fires (one-shot). */
function once<K extends AppEventName>(bus: EventBus, name: K): Promise<AppEventMap[K]> {
  return new Promise((resolve) => {
    const h = (p: AppEventMap[K]) => {
      bus.off(name, h);
      resolve(p);
    };
    bus.on(name, h);
  });
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
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('proposes operations on the happy path with base_version from the loaded cart', async () => {
    const llmOut = JSON.stringify({
      operations: [
        { action: 'add_item', menu_item_key: 'chicken_burger', quantity: 1, modifiers: [] },
        { action: 'add_item', menu_item_key: 'chicken_burger', quantity: 1, modifiers: [{ modifier_key: 'no_mayo' }] },
      ],
      needs_clarification: false,
      clarification_question: null,
    });
    const { service, bus } = await makeService([llmOut], cartWith(6));
    const proposed = collect(bus, 'order.operations_proposed');

    await service.handleFinalTranscript(transcript('add two chicken burgers, one without mayo'));

    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.proposal.base_version).toBe(6);
    expect(proposed[0]!.proposal.operations).toHaveLength(2);
    expect(proposed[0]!.proposal.operations[1]).toMatchObject({
      action: 'add_item',
      menu_item_key: 'chicken_burger',
      modifiers: [{ modifier_key: 'no_mayo' }],
    });
  });

  it('passes edit operations that target a line_id straight through', async () => {
    const seeded = cartWith(3, [
      { line_id: 'ln_1', product_tmpl_id: 10, quantity: 1, modifiers: [] },
    ]);
    const llmOut = JSON.stringify({
      operations: [{ action: 'update_quantity', line_id: 'ln_1', quantity: 2 }],
      needs_clarification: false,
      clarification_question: null,
    });
    const { service, bus } = await makeService([llmOut], seeded);
    const proposed = collect(bus, 'order.operations_proposed');

    await service.handleFinalTranscript(transcript('make that a double'));

    expect(proposed[0]!.proposal.base_version).toBe(3);
    expect(proposed[0]!.proposal.operations[0]).toEqual({ action: 'update_quantity', line_id: 'ln_1', quantity: 2 });
  });

  it('emits a clarification, then resumes on the answer to propose operations', async () => {
    const clarifyOut = JSON.stringify({
      operations: [],
      needs_clarification: true,
      clarification_question: 'One without mayo, or both?',
      clarification_options: ['one', 'both'],
    });
    const resolvedOut = JSON.stringify({
      operations: [{ action: 'add_item', menu_item_key: 'chicken_burger', quantity: 2, modifiers: [] }],
      needs_clarification: false,
      clarification_question: null,
    });
    const { service, bus, llm } = await makeService([clarifyOut, resolvedOut], cartWith(1));
    const clarifications = collect(bus, 'order.clarification_needed');
    const proposed = collect(bus, 'order.operations_proposed');

    const turn = service.handleFinalTranscript(transcript('two burgers no mayo'));
    await once(bus, 'order.clarification_needed');

    expect(clarifications).toHaveLength(1);
    expect(clarifications[0]).toMatchObject({ question: 'One without mayo, or both?', options: ['one', 'both'] });
    expect(proposed).toHaveLength(0); // nothing proposed while paused

    await service.handleClarificationAnswer({
      cart_id: 'cart_1',
      session_id: 'sess_1',
      request_id: 'req_1',
      answer: 'both',
    });
    await turn;

    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.proposal.operations[0]).toMatchObject({ action: 'add_item', quantity: 2 });
    expect(llm.calls).toBe(2); // initial + resume
  });

  it('repairs invalid JSON with one retry, then proposes', async () => {
    const valid = JSON.stringify({
      operations: [{ action: 'add_item', menu_item_key: 'coke', quantity: 1, modifiers: [] }],
      needs_clarification: false,
      clarification_question: null,
    });
    const { service, bus, llm } = await makeService(['not valid json{{', valid], cartWith(0));
    const proposed = collect(bus, 'order.operations_proposed');
    const failed = collect(bus, 'voice.session_failed');

    await service.handleFinalTranscript(transcript('a coke'));

    expect(failed).toHaveLength(0);
    expect(proposed).toHaveLength(1);
    expect(llm.calls).toBe(2); // initial + one repair
    expect(llm.prompts[1]!.user).toContain('VALIDATION_ERROR');
  });

  it('fails the turn when repair is exhausted', async () => {
    const { service, bus, llm } = await makeService(['garbage', 'still garbage'], cartWith(0));
    const proposed = collect(bus, 'order.operations_proposed');
    const failed = collect(bus, 'voice.session_failed');

    await service.handleFinalTranscript(transcript('a coke'));

    expect(proposed).toHaveLength(0);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toBe('order_parse_failed');
    expect(llm.calls).toBe(2); // initial + one repair (llmMaxRetries = 1)
  });

  it('serializes turns per cart: turn 2 loads the base_version turn 1 produced', async () => {
    const out = (key: string) =>
      JSON.stringify({
        operations: [{ action: 'add_item', menu_item_key: key, quantity: 1, modifiers: [] }],
        needs_clarification: false,
        clarification_question: null,
      });
    const { service, bus, carts } = await makeService([out('chicken_burger'), out('coke')], cartWith(5));

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

  it('treats a fresh turn as fresh: prior answer rides in history, not as the current answer', async () => {
    const clarifyOut = JSON.stringify({
      operations: [],
      needs_clarification: true,
      clarification_question: 'one or both?',
    });
    const resolvedOut = JSON.stringify({
      operations: [{ action: 'add_item', menu_item_key: 'chicken_burger', quantity: 2, modifiers: [] }],
      needs_clarification: false,
      clarification_question: null,
    });
    const plainOut = JSON.stringify({
      operations: [{ action: 'add_item', menu_item_key: 'coke', quantity: 1, modifiers: [] }],
      needs_clarification: false,
      clarification_question: null,
    });
    const { service, bus, llm } = await makeService([clarifyOut, resolvedOut, plainOut], cartWith(0));

    // Turn 1: clarify, then resume with 'both'.
    const t1 = service.handleFinalTranscript(transcript('two burgers no mayo'));
    await once(bus, 'order.clarification_needed');
    await service.handleClarificationAnswer({
      cart_id: 'cart_1',
      session_id: 'sess_1',
      request_id: 'req_1',
      answer: 'both',
    });
    await t1;

    // Turn 2: a fresh, unrelated transcript on the same cart.
    await service.handleFinalTranscript(transcript('a coke', { request_id: 'req_2' }));

    const p2 = JSON.parse(llm.prompts[2]!.user) as {
      clarification_answer?: string | null;
      conversation_history: Array<{ customer_text: string; clarification_question?: string; clarification_answer?: string }>;
    };
    // The one-shot top-level clarification_answer is cleared: turn 2 is NOT told it is
    // answering a clarification (the original leak guard).
    expect(p2.clarification_answer ?? null).toBeNull();
    // But turn 1's utterance + clarification (question + answer) persist as conversation
    // context so the answer 'both' is not stranded without the question it resolved.
    expect(p2.conversation_history).toEqual([
      { customer_text: 'two burgers no mayo', clarification_question: 'one or both?', clarification_answer: 'both' },
    ]);
  });

  it('persists each turn to conversation history and sends it to the next turn', async () => {
    const out = (key: string) =>
      JSON.stringify({
        operations: [{ action: 'add_item', menu_item_key: key, quantity: 1, modifiers: [] }],
        needs_clarification: false,
        clarification_question: null,
      });
    const { service, llm } = await makeService([out('chicken_burger'), out('coke')], cartWith(0));

    await service.handleFinalTranscript(transcript('a chicken burger', { request_id: 'req_1' }));
    await service.handleFinalTranscript(transcript('and a coke', { request_id: 'req_2' }));

    // Turn 1 saw no history; turn 2 sees turn 1's utterance (no clarification answer).
    expect((JSON.parse(llm.prompts[0]!.user) as { conversation_history: unknown[] }).conversation_history).toEqual([]);
    expect(
      (JSON.parse(llm.prompts[1]!.user) as { conversation_history: unknown[] }).conversation_history,
    ).toEqual([{ customer_text: 'a chicken burger' }]);
  });

  it('renders a self-describing cart line (name + keys + modifiers, no numeric ids)', async () => {
    const seeded = cartWith(2, [
      { line_id: 'ln_1', product_tmpl_id: 10, quantity: 1, modifiers: [{ ptav_id: 1 }] },
    ]);
    const out = JSON.stringify({
      operations: [{ action: 'update_quantity', line_id: 'ln_1', quantity: 2 }],
      needs_clarification: false,
      clarification_question: null,
    });
    const { service, llm } = await makeService([out], seeded);

    await service.handleFinalTranscript(transcript('make the chicken burger two'));

    const cart = (JSON.parse(llm.prompts[0]!.user) as { current_cart: { items: unknown[] } }).current_cart;
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

  it('does not report a parse failure when a proposal subscriber throws', async () => {
    const valid = JSON.stringify({
      operations: [{ action: 'add_item', menu_item_key: 'coke', quantity: 1, modifiers: [] }],
      needs_clarification: false,
      clarification_question: null,
    });
    const { service, bus } = await makeService([valid], cartWith(0));
    const failed = collect(bus, 'voice.session_failed');
    bus.on('order.operations_proposed', () => {
      throw new Error('subscriber boom');
    });

    // The throw propagates out of the turn; it must NOT be caught as a parse failure.
    await service.handleFinalTranscript(transcript('a coke')).catch(() => undefined);

    expect(failed).toHaveLength(0);
  });

  it('expires a stalled clarification and unblocks the cart', async () => {
    vi.useFakeTimers();
    const clarifyOut = JSON.stringify({
      operations: [],
      needs_clarification: true,
      clarification_question: 'which one?',
    });
    const { service, bus } = await makeService([clarifyOut], cartWith(0));
    const failed = collect(bus, 'voice.session_failed');

    const turn = service.handleFinalTranscript(transcript('the thing'));
    await vi.advanceTimersByTimeAsync(0); // let the graph run to the interrupt
    await vi.advanceTimersByTimeAsync(TIMEOUTS.clarificationMs); // expire the wait
    await turn;

    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toBe('clarification_timeout');
  });
});
