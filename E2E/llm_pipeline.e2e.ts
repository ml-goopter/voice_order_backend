/**
 * Real-LLM e2e for the pipeline triggered on `stt.final_transcript.received`, scoped to the
 * Order Understanding module — customer text IN, LLM-proposed operations OUT.
 *
 * What this suite proves: driven by the REAL production LLM and the real prompt builders +
 * tool-calling loop, a turn's emitted proposal is SCHEMA-VALID — every operation conforms to
 * `cartOperationSchema` and the proposal envelope is well-formed. It does NOT assert semantics
 * (which dish resolved, exact quantities, which modifier) — that is model-accuracy, tested
 * elsewhere — and it does NOT touch the Cart module (applying the proposal is out of scope).
 *
 * Trigger:  emit `stt.final_transcript.received` on a real EventBus (the true pipeline entry;
 *           see voice/voice-message-handler.ts).
 * LLM:      the REAL production provider, sourced from .env (LLM_* / INTENT_LLM_*). Production
 *           runs Gemini via the OpenAI-compatible endpoint; this suite uses exactly that. The
 *           suite self-skips if no LLM is configured (empty key / stub provider).
 * DB:       MOCKED so the test runs independently of the live stack — an InMemoryCartCache for
 *           cart state and a small fixed fake menu for retrieval. No Postgres/pgvector, no Redis,
 *           no Jina. The fake menu gives the agent real-shaped candidates to propose against.
 * Assert:   two layers.
 *           (1) SCHEMA — `order.operations_proposed` fires (not `voice.session_failed`) and its
 *               operations pass `cartOperationSchema`.
 *           (2) CORRECTNESS — because the menu is a FIXED fake, keys are deterministic, so we can
 *               assert the RIGHT operation: an add names the right `menu_item_key` + quantity, an
 *               inline/edit modifier carries the right `modifier_key`, and an edit targets the
 *               seeded `line_id`. (Semantic correctness against a known catalog — not possible with
 *               the old live near-duplicate menu, straightforward here.)
 *           The LLM is non-deterministic, so inputs that may legitimately end in a spoken reply (a
 *           question, an off-menu ask) assert tolerantly: no failure, and IF a proposal is emitted
 *           it must be schema-valid.
 *
 * Run with: npm run test:e2e   (see vitest.e2e.config.ts)
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { z } from 'zod';
import { config } from '../src/config/env.js';
import { EventBus } from '../src/events/event-bus.js';
import type { AppEventMap, AppEventName } from '../src/events/event-types.js';
import { InMemoryCartCache } from '../src/redis/cart-cache.js';
import type { CartCache } from '../src/redis/cart-cache.js';
import { createLlmProvider, createIntentLlmProvider } from '../src/llm/llm-client.js';
import type { AgentMessage, ChatResult, LlmPrompt, LlmProvider, ToolSpec } from '../src/llm/llm-provider.js';
import { OrderGraph } from '../src/ordering/order-graph.js';
import { OrderUnderstandingService } from '../src/ordering/order-understanding-service.js';
import { registerOrderingHandlers } from '../src/ordering/register-handlers.js';
import type { Cart, CartLine } from '../src/cart/cart-types.js';
import type { MenuService } from '../src/menu/menu-service.js';
import type { CandidateItem, CandidateSet, MenuItem, MenuSearchOptions } from '../src/menu/menu-types.js';
import { cartOperationSchema } from '../src/contracts/cart-operation.schema.js';
import type { AddItemOp, AddModifierOp, RemoveModifierOp } from '../src/contracts/cart-operation.schema.js';
import type { OrderProposal } from '../src/contracts/proposal.js';

const POS = 1;
/** A production Gemini flash-lite turn (retrieve + tool loop) runs in a few seconds. */
const TURN_MS = 45_000;

// ---- fake menu (mocks the DB-backed MenuService) ----------------------------
// A small, fixed menu with real-shaped items + modifiers. It gives the agent candidates to
// propose against without Postgres/pgvector or Jina. `searchMenu` does naive substring matching
// and always returns SOMETHING (falls back to the full menu) so the model is never starved of
// candidates; a wrong pick is fine here — only schema validity is asserted.
interface FakeMod {
  modifier_key: string;
  ptav_id: number;
  name: string;
  price_extra_cents: number;
}
interface FakeItem {
  menu_item_key: string;
  product_tmpl_id: number;
  names: Record<string, string>;
  base_price_cents: number;
  modifiers: FakeMod[];
}

const MENU: FakeItem[] = [
  {
    menu_item_key: 'sweet_sour_chicken',
    product_tmpl_id: 101,
    names: { en_US: 'Sweet and Sour Chicken', zh_CN: '咕嚕雞' },
    base_price_cents: 1295,
    modifiers: [
      { modifier_key: 'add_broccoli', ptav_id: 1001, name: 'add Broccoli', price_extra_cents: 150 },
      { modifier_key: 'no_broccoli', ptav_id: 1002, name: 'no Broccoli', price_extra_cents: 0 },
      { modifier_key: 'add_onion', ptav_id: 1003, name: 'add Onion', price_extra_cents: 150 },
    ],
  },
  {
    menu_item_key: 'deep_fried_wonton',
    product_tmpl_id: 102,
    names: { en_US: 'Deep Fried Wonton', zh_CN: '炸雲吞' },
    base_price_cents: 795,
    modifiers: [],
  },
  {
    menu_item_key: 'combination_for_one_a',
    product_tmpl_id: 103,
    names: { en_US: 'Combination For One A' },
    base_price_cents: 1695,
    modifiers: [],
  },
  {
    menu_item_key: 'combination_for_one_b',
    product_tmpl_id: 104,
    names: { en_US: 'Combination For One B' },
    base_price_cents: 1695,
    modifiers: [],
  },
  {
    menu_item_key: 'hot_sour_soup',
    product_tmpl_id: 106,
    names: { en_US: 'Hot and Sour Soup' },
    base_price_cents: 650,
    modifiers: [],
  },
];

const toModifiers = (i: FakeItem) =>
  i.modifiers.map((m) => ({
    modifier_key: m.modifier_key,
    ptav_id: m.ptav_id,
    name: m.name,
    price_extra_cents: m.price_extra_cents,
  }));

const toCandidate = (i: FakeItem, popularity?: 'top' | 'popular'): CandidateItem => ({
  menu_item_key: i.menu_item_key,
  product_tmpl_id: i.product_tmpl_id,
  name: i.names.en_US ?? i.menu_item_key,
  names: i.names,
  base_price_cents: i.base_price_cents,
  available_modifiers: toModifiers(i),
  ...(popularity !== undefined ? { popularity } : {}),
});

const toMenuItem = (i: FakeItem): MenuItem => ({
  product_tmpl_id: i.product_tmpl_id,
  menu_item_key: i.menu_item_key,
  names: i.names,
  base_price_cents: i.base_price_cents,
  available: true,
  modifiers: toModifiers(i),
});

function fakeSearch(opts: MenuSearchOptions): CandidateSet {
  const q = opts.query?.toLowerCase().trim();
  let hits = MENU;
  if (q) {
    const toks = q.split(/\s+/);
    const matched = MENU.filter((i) => {
      const hay = Object.values(i.names).join(' ').toLowerCase();
      return toks.some((t) => hay.includes(t));
    });
    hits = matched.length > 0 ? matched : MENU; // never starve the model of candidates
  }
  const limit = opts.limit ?? 8;
  const wantPop = opts.sort === 'popularity' || q === undefined;
  return {
    items: hits.slice(0, limit).map((i, idx) =>
      toCandidate(i, wantPop ? (idx === 0 ? 'top' : idx === 1 ? 'popular' : undefined) : undefined),
    ),
  };
}

// Only `searchMenu` (agent retrieval) and `getItems` (cart-view hydration) are exercised by the
// pipeline; the cast keeps the fake minimal while satisfying the MenuService dependency.
const fakeMenu = {
  searchMenu: async (_pos: number, opts: MenuSearchOptions): Promise<CandidateSet> => fakeSearch(opts),
  getItems: async (_pos: number, ids: number[]): Promise<MenuItem[]> =>
    MENU.filter((i) => ids.includes(i.product_tmpl_id)).map(toMenuItem),
  resolveItemKey: async (_pos: number, key: string): Promise<MenuItem | undefined> => {
    const i = MENU.find((m) => m.menu_item_key === key);
    return i ? toMenuItem(i) : undefined;
  },
  findByTmplId: async (_pos: number, id: number): Promise<MenuItem | undefined> => {
    const i = MENU.find((m) => m.product_tmpl_id === id);
    return i ? toMenuItem(i) : undefined;
  },
} as unknown as MenuService;

// ---- live pipeline (built once in beforeAll) --------------------------------
let carts: CartCache;
let bus: EventBus;
let infraReady = false;
let infraSkipReason = '';
const subs: Array<() => void> = [];

// ---- per-test timing (reported in afterAll with the model name) -------------
const durations: Array<{ name: string; ms: number }> = [];
let testStart = 0;

// ---- LLM exchange recorder (debug: dump full prompt/response on a failed test) ----
// Wraps the production provider so every complete()/chat() call is captured. The log is reset
// per test (beforeEach) and dumped on failure (afterEach) — the raw prompts + the model's replies
// are what you need to see WHY a turn failed or proposed nothing.
interface LlmExchange {
  kind: 'complete' | 'chat';
  system?: string;
  user?: string;
  messages?: AgentMessage[];
  response?: string;
  toolCalls?: unknown;
  error?: string;
}
const llmLog: LlmExchange[] = [];

// ---- global LLM rate gate ---------------------------------------------------
// The production LLM tier rate-limits by requests-per-minute; a burst of turns draws 429s (which
// surface as `order_parse_failed`). Space EVERY LLM call — intent + each agent step, across all
// tests — by at least MIN_CALL_GAP_MS so the suite self-throttles below the tier limit and never
// bursts. This is the primary defense; drive()'s per-turn retry is only a backstop for the rare
// overflow. Raise the gap if you still see 429s (the tier is lower than assumed).
const MIN_CALL_GAP_MS = 4000;
let lastCallStart = 0;
let rateChain: Promise<void> = Promise.resolve();
function rateGate(): Promise<void> {
  rateChain = rateChain.then(async () => {
    const wait = MIN_CALL_GAP_MS - (Date.now() - lastCallStart);
    if (wait > 0) await delay(wait);
    lastCallStart = Date.now();
  });
  return rateChain;
}

function recordingLlm(inner: LlmProvider): LlmProvider {
  return {
    name: inner.name,
    model: inner.model,
    async complete(prompt: LlmPrompt): Promise<string> {
      const entry: LlmExchange = { kind: 'complete', system: prompt.system, user: prompt.user };
      llmLog.push(entry);
      await rateGate();
      try {
        entry.response = await inner.complete(prompt);
        return entry.response;
      } catch (err) {
        entry.error = (err as Error).message;
        throw err;
      }
    },
    async chat(messages: AgentMessage[], tools: ToolSpec[]): Promise<ChatResult> {
      const entry: LlmExchange = { kind: 'chat', messages };
      llmLog.push(entry);
      await rateGate();
      try {
        const res = await inner.chat(messages, tools);
        entry.toolCalls = res.toolCalls;
        if (res.text !== undefined) entry.response = res.text;
        return res;
      } catch (err) {
        entry.error = (err as Error).message;
        throw err;
      }
    },
  };
}

/** Print every recorded LLM exchange for the just-failed test, in call order. */
function dumpLlmHistory(): void {
  const out = [`\n===== LLM history (${llmLog.length} call(s)) =====`];
  llmLog.forEach((e, i) => {
    out.push(
      `\n----- call ${i + 1} (${e.kind}) -----`,
      e.kind === 'complete' ? `SYSTEM:\n${e.system}\nUSER:\n${e.user}` : `MESSAGES:\n${JSON.stringify(e.messages, null, 2)}`,
      e.error !== undefined
        ? `ERROR: ${e.error}`
        : `RESPONSE:\n${e.response ?? '(no text)'}${e.toolCalls ? `\nTOOL_CALLS:\n${JSON.stringify(e.toolCalls, null, 2)}` : ''}`,
    );
  });
  out.push(`\n===== end LLM history =====\n`);
  // Straight to stdout: the vitest reporter does not surface console.* from afterEach.
  process.stdout.write(out.join('\n') + '\n');
}

// ---- helpers ----------------------------------------------------------------

/** cart_id for an event: on the payload, except `order.operations_proposed` nests it in
 *  `proposal.cart_id`. */
function cartIdOf(payload: unknown): string | undefined {
  const p = payload as { cart_id?: string; proposal?: { cart_id?: string } };
  return p.cart_id ?? p.proposal?.cart_id;
}

/** Resolve with the first of `names` to fire FOR THIS CART, or reject after `timeoutMs`. */
function waitForAny<K extends AppEventName>(
  names: K[],
  cartId: string,
  timeoutMs: number,
): Promise<{ name: K; payload: AppEventMap[K] }> {
  return new Promise((resolve, reject) => {
    const handlers = new Map<K, (p: AppEventMap[K]) => void>();
    const cleanup = () => {
      for (const [n, h] of handlers) bus.off(n, h);
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout after ${timeoutMs}ms waiting for [${names.join(', ')}] on ${cartId}`));
    }, timeoutMs);
    for (const n of names) {
      const h = (payload: AppEventMap[K]) => {
        if (cartIdOf(payload) !== cartId) return; // not our turn
        cleanup();
        resolve({ name: n, payload });
      };
      handlers.set(n, h);
      bus.on(n, h);
    }
  });
}

/** The terminal events a turn can end in (no `clarification_needed` — a clarification is an
 *  `order.reply`). */
const TERMINALS = ['order.operations_proposed', 'order.reply', 'voice.session_failed'] as const;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Emit one turn and wait for its terminal event. The real LLM is on a rate-limited tier, so a
 * burst of turns can draw a 429; a node throwing that error ends the turn as `voice.session_failed`
 * (`order_parse_failed`). Because the Cart module is NOT wired here, no proposal is applied and the
 * cart is never mutated — so re-emitting the identical turn is idempotent. Retry a session_failed a
 * few times with backoff to absorb transient rate-limit blips; a persistent failure still surfaces
 * after the retries are spent (and the caller's assertion then fails, as it should).
 */
async function drive(
  o: { cart_id: string; session_id: string; request_id: string },
  text: string,
  language?: string,
): Promise<{ name: string; payload: unknown }> {
  const MAX = 4;
  let last: { name: string; payload: unknown } = { name: 'voice.session_failed', payload: {} };
  for (let attempt = 1; attempt <= MAX; attempt++) {
    const settled = waitForAny([...TERMINALS], o.cart_id, TURN_MS);
    emitFinal(text, o, language);
    last = await settled;
    if (last.name !== 'voice.session_failed') return last;
    if (attempt < MAX) await delay(2000 * attempt); // let the RPM window recover, then retry
  }
  return last;
}

/** Start capturing the proposals emitted for this cart (the module's terminal output for a turn). */
function captureProposals(cartId: string): OrderProposal[] {
  const got: OrderProposal[] = [];
  const h = (p: AppEventMap['order.operations_proposed']) => {
    if (p.proposal.cart_id === cartId) got.push(p.proposal);
  };
  bus.on('order.operations_proposed', h);
  subs.push(() => bus.off('order.operations_proposed', h));
  return got;
}

/**
 * The heart of the rewrite: assert the LLM's proposal is SCHEMA-VALID. A well-formed envelope
 * plus every operation conforming to `cartOperationSchema` (equivalent to the pipeline's own
 * `parseOrderGraphOutput` gate — re-checked here end-to-end). No semantic assertions.
 */
function expectSchemaValidProposal(proposals: OrderProposal[]): OrderProposal {
  expect(proposals.length, 'no order.operations_proposed was emitted for this cart').toBeGreaterThan(0);
  const p = proposals[proposals.length - 1]!;
  expect(typeof p.request_id, 'request_id must be a string').toBe('string');
  expect(typeof p.cart_id, 'cart_id must be a string').toBe('string');
  expect(typeof p.pos_config_id, 'pos_config_id must be a number').toBe('number');
  expect(typeof p.base_version, 'base_version must be a number').toBe('number');
  expect(p.operations.length, 'propose_cart must carry at least one operation').toBeGreaterThan(0);
  const r = z.array(cartOperationSchema).safeParse(p.operations);
  expect(
    r.success,
    r.success ? '' : `operations failed cartOperationSchema: ${JSON.stringify(r.error.issues)}`,
  ).toBe(true);
  return p;
}

// ---- correctness assertions (deterministic against the fixed fake menu) -----
// Beyond schema validity, assert the RIGHT operation was proposed. Keys are fixed by MENU, so an
// add must name the expected menu_item_key, a modifier must carry the expected modifier_key, and
// an edit must target the seeded line_id.

const addItemsOf = (p: OrderProposal): AddItemOp[] =>
  p.operations.filter((o): o is AddItemOp => o.action === 'add_item');

/** Assert the proposal adds `menu_item_key` with `quantity` (an add_item op). */
function expectAddsItem(p: OrderProposal, menu_item_key: string, quantity: number): AddItemOp {
  const adds = addItemsOf(p);
  const hit = adds.find((o) => o.menu_item_key === menu_item_key);
  expect(
    hit,
    `expected an add_item for "${menu_item_key}", got ops: ${JSON.stringify(p.operations)}`,
  ).toBeDefined();
  expect(hit!.quantity, `wrong quantity for "${menu_item_key}"`).toBe(quantity);
  return hit!;
}

/** Assert the add_item for `menu_item_key` carries `modifier_key` in its inline modifiers. */
function expectAddItemHasModifier(p: OrderProposal, menu_item_key: string, modifier_key: string): void {
  const hit = addItemsOf(p).find((o) => o.menu_item_key === menu_item_key);
  expect(hit, `expected an add_item for "${menu_item_key}", got ops: ${JSON.stringify(p.operations)}`).toBeDefined();
  const keys = hit!.modifiers.map((m) => m.modifier_key);
  expect(
    keys,
    `add_item for "${menu_item_key}" is missing modifier "${modifier_key}" (got: ${keys.join(', ') || 'none'})`,
  ).toContain(modifier_key);
}

/** Assert an add_modifier/remove_modifier op targets `line_id` with `modifier_key`. */
function expectModifierOp(
  p: OrderProposal,
  action: 'add_modifier' | 'remove_modifier',
  line_id: string,
  modifier_key: string,
): void {
  const op = p.operations.find(
    (o): o is AddModifierOp | RemoveModifierOp => o.action === action,
  );
  expect(op, `expected a ${action} op, got ops: ${JSON.stringify(p.operations)}`).toBeDefined();
  expect(op!.line_id, `${action} targeted the wrong line`).toBe(line_id);
  expect(op!.modifier_key, `${action} carried the wrong modifier_key`).toBe(modifier_key);
}

// ---- cart seeding (into the in-memory cache) --------------------------------

function seedEmptyCart(cart_id: string): Promise<void> {
  const cart: Cart = {
    cart_id,
    pos_config_id: POS,
    version: 0,
    items: [],
    subtotal_cents: 0,
    tax_cents: 0,
    total_cents: 0,
    last_updated: '2026-07-08T00:00:00.000Z',
  };
  return carts.set(cart);
}

/** Seed a cart (version 1) holding ONE line for a known fake item, so an edit turn has a
 *  pre-existing line_id to target. Optionally pre-attach a modifier (for a remove_modifier turn).
 *  Returns the seeded line. */
async function seedCartWithLine(
  cart_id: string,
  item: FakeItem,
  opts: { quantity?: number; withModifier?: FakeMod } = {},
): Promise<CartLine> {
  const line: CartLine = {
    line_id: `ln_${cart_id}`,
    product_tmpl_id: item.product_tmpl_id,
    name: item.names.en_US ?? item.menu_item_key,
    names: item.names,
    quantity: opts.quantity ?? 1,
    modifiers: opts.withModifier
      ? [{ ptav_id: opts.withModifier.ptav_id, name: opts.withModifier.name }]
      : [],
  };
  await carts.set({
    cart_id,
    pos_config_id: POS,
    version: 1,
    items: [line],
    subtotal_cents: 0,
    tax_cents: 0,
    total_cents: 0,
    last_updated: '2026-07-08T00:00:00.000Z',
  });
  return line;
}

let uid = 0;
function ids(tag: string) {
  uid += 1;
  return { cart_id: `e2e_${tag}_${uid}`, session_id: `e2e_sess_${uid}`, request_id: `e2e_req_${uid}` };
}

function emitFinal(
  text: string,
  o: { cart_id: string; session_id: string; request_id: string },
  language?: string,
): void {
  bus.emit('stt.final_transcript.received', {
    request_id: o.request_id,
    session_id: o.session_id,
    cart_id: o.cart_id,
    pos_config_id: POS,
    text,
    ...(language !== undefined ? { language } : {}),
  });
}

// ---- setup / teardown -------------------------------------------------------

beforeAll(() => {
  // The only external dependency is the LLM. Build the pipeline only if a real provider is
  // configured (production Gemini via .env); otherwise skip the whole suite (don't fail).
  const llmConfigured = config.llmProvider !== 'stub' && config.llmApiKey.length > 0;
  if (!llmConfigured) {
    infraSkipReason = `no production LLM configured (set LLM_PROVIDER + LLM_API_KEY in .env; got provider='${config.llmProvider}')`;
    return;
  }

  // Order Understanding pipeline with the DB mocked (in-memory cart cache + fake menu) and the
  // REAL production LLM. Mirrors app.ts minus the Cart module and voice/realtime/WS.
  carts = new InMemoryCartCache();
  const llm = recordingLlm(createLlmProvider());
  const intentLlm = createIntentLlmProvider();
  bus = new EventBus();

  const graph = new OrderGraph(fakeMenu, llm, carts, intentLlm);
  const ordering = new OrderUnderstandingService(graph, bus);
  registerOrderingHandlers(bus, ordering);

  infraReady = true;
});

beforeEach(() => {
  testStart = Date.now();
  llmLog.length = 0; // fresh capture per test (suite runs serially)
});

afterEach((ctx) => {
  if (infraReady) durations.push({ name: ctx.task.name, ms: Date.now() - testStart });
  if (ctx.task.result?.state === 'fail') dumpLlmHistory();
  subs.splice(0).forEach((off) => off());
  // Inter-turn spacing is handled globally by the LLM rate gate (rateGate), not here.
});

afterAll(() => {
  if (durations.length > 0) {
    const total = durations.reduce((sum, d) => sum + d.ms, 0);
    const avg = Math.round(total / durations.length);
    const lines = [
      `\n[llm_pipeline.e2e] model=${config.llmModel} provider=${config.llmProvider}`,
      ...durations.map((d) => `  ${String(d.ms).padStart(7)} ms  ${d.name}`),
      `  average: ${avg} ms over ${durations.length} test(s)\n`,
    ];
    process.stdout.write(lines.join('\n') + '\n');
  }
});

// ---- tests: customer text → schema-valid LLM output -------------------------

const chicken = MENU[0]!;
const wonton = MENU[1]!;
const addBroccoli = chicken.modifiers.find((m) => m.modifier_key === 'add_broccoli')!;
const noBroccoli = chicken.modifiers.find((m) => m.modifier_key === 'no_broccoli')!;

describe('final-transcript → schema-valid proposal (real LLM: production Gemini; DB mocked)', () => {
  it('single add: an order proposes schema-valid operations', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('add');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    const { name, payload } = await drive(o, 'I would like one order of sweet and sour chicken please');

    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');
    const proposal = expectSchemaValidProposal(proposals);
    expect(proposal.base_version).toBe(0); // from the seeded empty cart
    expectAddsItem(proposal, chicken.menu_item_key, 1);
  });

  it('quantity: "two ..." still yields a schema-valid proposal', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('qty');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    const { name, payload } = await drive(o, 'can I get two orders of deep fried wonton');

    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');
    expectAddsItem(expectSchemaValidProposal(proposals), wonton.menu_item_key, 2);
  });

  it('inline modifier (add): the requested extra rides on the add_item', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('modadd');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    const { name, payload } = await drive(o, 'one sweet and sour chicken with added broccoli please');

    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');
    const proposal = expectSchemaValidProposal(proposals);
    expectAddsItem(proposal, chicken.menu_item_key, 1);
    expectAddItemHasModifier(proposal, chicken.menu_item_key, addBroccoli.modifier_key);
  });

  it('inline modifier (omit): a "no <ingredient>" lands as the omit modifier on the add_item', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('modno');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    const { name, payload } = await drive(o, 'a sweet and sour chicken, no broccoli please');

    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');
    const proposal = expectSchemaValidProposal(proposals);
    expectAddsItem(proposal, chicken.menu_item_key, 1);
    expectAddItemHasModifier(proposal, chicken.menu_item_key, noBroccoli.modifier_key);
  });

  it('multi-item: one utterance with two dishes adds each with the right quantity', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('multi');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    const { name, payload } = await drive(o, 'one sweet and sour chicken and two deep fried wontons');

    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');
    const proposal = expectSchemaValidProposal(proposals);
    expectAddsItem(proposal, chicken.menu_item_key, 1);
    expectAddsItem(proposal, wonton.menu_item_key, 2);
  });

  it('update_quantity: "make that two" edits the seeded line in place', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('updqty');
    const line = await seedCartWithLine(o.cart_id, chicken);
    const proposals = captureProposals(o.cart_id);

    const { name, payload } = await drive(o, 'actually, make that two');

    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');
    const proposal = expectSchemaValidProposal(proposals);
    expect(proposal.base_version).toBe(1); // from the seeded v1 cart
    // Editing the single seeded line is unambiguous, but the model may still re-add; self-skip
    // (not fail) on a valid-but-different path, else assert the in-place edit is correct.
    const op = proposal.operations.find((o2) => o2.action === 'update_quantity');
    if (!op) return ctx.skip(`model chose [${proposal.operations.map((o2) => o2.action).join(', ')}], not update_quantity`);
    expect(op.line_id, 'update_quantity targeted the wrong line').toBe(line.line_id);
    expect(op.quantity, 'update_quantity set the wrong quantity').toBe(2);
  });

  it('add_modifier: "add broccoli to my chicken" attaches the modifier to the seeded line', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('addmod');
    const line = await seedCartWithLine(o.cart_id, chicken);
    const proposals = captureProposals(o.cart_id);

    const { name, payload } = await drive(o, 'can you add broccoli to my sweet and sour chicken');

    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');
    const proposal = expectSchemaValidProposal(proposals);
    expectModifierOp(proposal, 'add_modifier', line.line_id, addBroccoli.modifier_key);
  });

  it('remove_modifier: "take the broccoli off" drops the modifier from the seeded line', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('rmmod');
    const line = await seedCartWithLine(o.cart_id, chicken, { withModifier: addBroccoli });
    const proposals = captureProposals(o.cart_id);

    const { name, payload } = await drive(o, 'actually, take the broccoli off the sweet and sour chicken');

    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');
    const proposal = expectSchemaValidProposal(proposals);
    expectModifierOp(proposal, 'remove_modifier', line.line_id, addBroccoli.modifier_key);
  });

  it('Chinese input: a zh order adds the cross-language-matched item', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('zh');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    const { name, payload } = await drive(o, '我要一份咕噜鸡', 'zh_CN');

    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');
    // 咕噜鸡 → Sweet and Sour Chicken (the fake menu carries the zh_CN name 咕嚕雞).
    expectAddsItem(expectSchemaValidProposal(proposals), chicken.menu_item_key, 1);
  });

  // ---- tolerant cases: a spoken reply is a valid terminal; a proposal (if any) must be valid --

  it('menu question: does not fail, and any proposal is schema-valid', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('question');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    const { name, payload } = await drive(o, 'what kinds of soup do you have');

    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).not.toBe('voice.session_failed');
    // Answering in words (order.reply) is fine; if it proposed, the ops must be schema-valid.
    if (proposals.length > 0) expectSchemaValidProposal(proposals);
  });

  it('off-menu: does not fail, and any proposal is schema-valid', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('offmenu');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    const { name, payload } = await drive(o, 'can I get a cheeseburger please');

    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).not.toBe('voice.session_failed');
    if (proposals.length > 0) expectSchemaValidProposal(proposals);
  });
});
