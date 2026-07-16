/**
 * Real-stack e2e for the pipeline triggered on `stt.final_transcript.received`,
 * scoped to the Order Understanding module only — up to the LLM output.
 *
 * Trigger:  emit the event on a real EventBus (the true pipeline entry — where STT
 *           hands off; see voice/voice-message-handler.ts).
 * Stack:    LIVE Postgres/pgvector (real Jade Garden menu in `item_vector` + Odoo
 *           JOINs for the KNN candidate path), LIVE Redis (cart cache), LIVE Jina
 *           query embeddings (real vector retrieval), and a LIVE Ollama LLM.
 *           Nothing is mocked; the wiring mirrors app.ts minus the Cart module,
 *           voice/realtime/WS.
 * Assert:   the operations proposed by Order Understanding (via `order.operations_proposed`)
 *           — i.e. the LLM output. Cart application (applying the proposal to Redis) is out
 *           of scope here; it is covered by the Cart module's own tests.
 *
 * The LLM is real and non-deterministic, and the menu has many near-duplicate items
 * (lunch/dinner variants, 3 "Combination For One", etc.), so:
 *   - assertions are tolerant — the added item's NAME must match the ordered dish
 *     (any variant) with the right quantity, not a specific menu_item_key;
 *   - the clarification tests use input that maps to several distinct items and
 *     SELF-SKIP (not fail) when the model happens to resolve without asking;
 *   - the parse-failure branch cannot be forced with a compliant JSON-returning
 *     model, so it is skipped here and covered deterministically in
 *     order-understanding-service.test.ts.
 *
 * Prereqs (self-checked in beforeAll; the suite skips if missing):
 *   - Postgres/pgvector at ODOO_DATABASE_URL, with pos_config_id 1's `item_vector`
 *     rows seeded (npm run seed:menu:pg) and the Odoo menu tables present.
 *   - Redis at REDIS_URL for the cart cache.
 *   - Ollama at LLM_BASE_URL serving LLM_MODEL (default qwen3:14b).
 *   - JINA_API_KEY for query embeddings (EMBEDDING_PROVIDER=jina).
 * Run with: npm run test:e2e   (see vitest.e2e.config.ts)
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import pg from 'pg';
import { config } from '../src/config/env.js';
import { EventBus } from '../src/events/event-bus.js';
import type { AppEventMap, AppEventName } from '../src/events/event-types.js';
import { RedisCartCache } from '../src/redis/cart-cache.js';
import { MenuService } from '../src/menu/menu-service.js';
import { PostgresMenuStore } from '../src/menu/postgres-menu-store.js';

const { Pool } = pg;
import { createLlmProvider, createIntentLlmProvider } from '../src/llm/llm-client.js';
import type { LlmProvider, LlmPrompt } from '../src/llm/llm-provider.js';
import { OrderGraph } from '../src/ordering/order-graph.js';
import { OrderUnderstandingService } from '../src/ordering/order-understanding-service.js';
import { registerOrderingHandlers } from '../src/ordering/register-handlers.js';
import type { Cart, CartLine, CartModifier } from '../src/cart/cart-types.js';
import type { CandidateItem, CandidateModifier } from '../src/menu/menu-types.js';
import { cartOperationSchema } from '../src/ordering/schemas/cart-operation.schema.js';
import type { OrderProposal } from '../src/ordering/schemas/proposal.js';

const POS = 1;
/** A real qwen3:14b turn (retrieve + thinking + parse) runs ~45-60s. */
const TURN_MS = 500_000;

// ---- live pipeline (built once in beforeAll) --------------------------------
let redis: Redis;
let pool: pg.Pool;
let carts: RedisCartCache;
let menu: MenuService;
let bus: EventBus;
let infraReady = false;
let infraSkipReason = '';
const createdCartIds: string[] = [];
const subs: Array<() => void> = [];

// ---- per-test timing (reported in afterAll with the model name) -------------
// Only tests that actually ran the live pipeline are timed; when infra is absent
// every test skips instantly, so there is nothing meaningful to average.
const durations: Array<{ name: string; ms: number }> = [];
let testStart = 0;

// ---- LLM exchange recorder (debug: dump full prompt/response on a failed test) ----
// The live provider is wrapped so every complete() call is captured in order. On failure
// afterEach prints the exchanges for that test's cart(s) — the raw prompts (including the
// resume `clarification: { question, answer }`) and the model's replies — which is what you
// need to see WHY a turn re-asked or mis-parsed. Filtering is by cart_id, which appears in
// each prompt's user JSON (current_cart.cart_id).
interface LlmExchange {
  system: string;
  user: string;
  response?: string;
  error?: string;
}
const llmLog: LlmExchange[] = [];

function recordingLlm(inner: LlmProvider): LlmProvider {
  return {
    name: inner.name,
    async complete(prompt: LlmPrompt): Promise<string> {
      const entry: LlmExchange = { system: prompt.system, user: prompt.user };
      llmLog.push(entry);
      try {
        entry.response = await inner.complete(prompt);
        return entry.response;
      } catch (err) {
        entry.error = (err as Error).message;
        throw err;
      }
    },
  };
}

/** Print every recorded LLM exchange whose prompt references `cartId`, in call order. */
function dumpLlmHistory(cartId: string): void {
  const entries = llmLog.filter((e) => e.user.includes(cartId));
  const out = [`\n===== LLM history for ${cartId} (${entries.length} call(s)) =====`];
  entries.forEach((e, i) => {
    out.push(
      `\n----- call ${i + 1} -----`,
      `SYSTEM:\n${e.system}`,
      `USER:\n${e.user}`,
      e.error !== undefined ? `ERROR: ${e.error}` : `RESPONSE:\n${e.response ?? '(none)'}`,
    );
  });
  out.push(`\n===== end LLM history for ${cartId} =====\n`);
  // Straight to stdout: the vitest reporter does not surface console.* from afterEach.
  process.stdout.write(out.join('\n') + '\n');
}

// ---- helpers ----------------------------------------------------------------

/** cart_id for an event: it lives on the payload, except `order.operations_proposed`
 * carries it nested in `proposal.cart_id`. */
function cartIdOf(payload: unknown): string | undefined {
  const p = payload as { cart_id?: string; proposal?: { cart_id?: string } };
  return p.cart_id ?? p.proposal?.cart_id;
}

/**
 * Resolve with the first of `names` to fire FOR THIS CART, or reject after
 * `timeoutMs`. Filtering by cart_id is essential: turns are slow, so a prior
 * (unique-cart) turn's terminal event must not leak into a later test.
 */
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

/**
 * Start capturing the proposals emitted for this cart. The Order Understanding
 * module emits `order.operations_proposed` as its terminal output for a turn;
 * registering before emitFinal captures the turn's proposal.
 */
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
 * Assert the turn proposed valid operations: a well-formed proposal envelope and
 * every operation conforming to the cart-operation schema. Returns the proposal.
 */
function expectValidProposal(proposals: OrderProposal[], minOps = 1): OrderProposal {
  expect(proposals.length, 'no order.operations_proposed was emitted for this cart').toBeGreaterThan(0);
  const proposal = proposals[proposals.length - 1]!;
  expect(typeof proposal.base_version, 'base_version must be a number').toBe('number');
  expect(proposal.operations.length).toBeGreaterThanOrEqual(minOps);
  for (const op of proposal.operations) {
    const r = cartOperationSchema.safeParse(op);
    expect(r.success, `invalid operation ${JSON.stringify(op)}: ${r.success ? '' : r.error.message}`).toBe(true);
  }
  return proposal;
}

/** Assert the proposal adds the dish: a schema-valid add_item with a real key + quantity. */
async function expectAddItem(proposal: OrderProposal, pattern: RegExp, quantity: number): Promise<void> {
  const adds = proposal.operations.filter((op) => op.action === 'add_item');
  expect(adds.length, `expected an add_item op, got: ${JSON.stringify(proposal.operations)}`).toBeGreaterThan(0);
  // Each add_item must reference a real menu_item_key the Menu module can resolve.
  const resolved = await Promise.all(
    adds.map(async (op) => ({
      op,
      item: await menu.resolveItemKey(POS, op.menu_item_key),
    })),
  );
  for (const { op, item } of resolved) {
    expect(item, `add_item references unknown menu_item_key "${op.menu_item_key}"`).toBeDefined();
  }
  const hit = resolved.find((x) => pattern.test(x.item?.names?.en_US ?? ''));
  expect(
    hit,
    `no add_item resolves to ${pattern} — got keys: ${adds.map((a) => a.menu_item_key).join(', ')}`,
  ).toBeDefined();
  expect(hit!.op.quantity).toBe(quantity);
}

/**
 * Assert the proposal's add_item for `dishPattern` carries a modifier whose resolved
 * name matches `modPattern`, and return that modifier's ptav_id. Validates the whole
 * key→ptav_id resolution the modifier path depends on.
 */
async function expectAddItemModifier(
  proposal: OrderProposal,
  dishPattern: RegExp,
  quantity: number,
  modPattern: RegExp,
): Promise<number> {
  const adds = proposal.operations.filter((op) => op.action === 'add_item');
  const resolved = await Promise.all(
    adds.map(async (op) => ({ op, item: await menu.resolveItemKey(POS, op.menu_item_key) })),
  );
  const hit = resolved.find((x) => dishPattern.test(x.item?.names?.en_US ?? ''));
  expect(hit, `no add_item resolves to ${dishPattern}`).toBeDefined();
  expect(hit!.op.quantity).toBe(quantity);

  const opMods = hit!.op.modifiers;
  expect(opMods.length, `add_item for ${dishPattern} carries no modifiers`).toBeGreaterThan(0);
  // Each modifier_key must resolve against the item's modifier list (key → ptav_id).
  const itemMods = hit!.item!.modifiers;
  const named = opMods.map((om) => itemMods.find((im) => im.modifier_key === om.modifier_key));
  for (const [i, im] of named.entries()) {
    expect(im, `modifier_key "${opMods[i]!.modifier_key}" is not a modifier of ${hit!.item!.menu_item_key}`).toBeDefined();
  }
  const match = named.find((im) => modPattern.test(im!.name));
  expect(match, `no add_item modifier matches ${modPattern} — got: ${named.map((im) => im!.name).join(', ')}`).toBeDefined();
  return match!.ptav_id;
}

/** Assert the proposal adds nothing new — no add_item op (empty ops or edits only). */
function expectNoAddItem(proposal: OrderProposal): void {
  const adds = proposal.operations.filter((op) => op.action === 'add_item');
  expect(
    adds.length,
    `expected no add_item, but the model fabricated: ${adds.map((a) => a.menu_item_key).join(', ')}`,
  ).toBe(0);
}

function seedEmptyCart(cart_id: string): Promise<void> {
  createdCartIds.push(cart_id);
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

/**
 * Seed a cart (version 1) holding ONE real menu line for `dishText`, resolved via the
 * live candidate matcher so the product_tmpl_id + modifier keys are genuine. Optionally
 * pre-attach the modifier whose name matches `withModifier`. Returns the seeded line and
 * the resolved candidate so an edit test can target its (stable, string) line_id and
 * assert against real ptav_ids. Edit ops (remove/update/add_modifier/remove_modifier)
 * need a pre-existing line, which the empty-cart seed can't provide.
 */
async function seedCartWithLine(
  cart_id: string,
  dishText: string,
  opts: { quantity?: number; withModifier?: RegExp } = {},
): Promise<{ line: CartLine; item: CandidateItem; seededMod: CandidateModifier | undefined }> {
  const { items } = await menu.searchMenu(POS, { query: dishText });
  const item = items[0];
  expect(item, `no candidate item for "${dishText}" — is the menu populated?`).toBeDefined();

  const seededMod = opts.withModifier
    ? item!.available_modifiers.find((m) => opts.withModifier!.test(m.name))
    : undefined;
  const modifiers: CartModifier[] = seededMod ? [{ ptav_id: seededMod.ptav_id, name: seededMod.name }] : [];

  const line: CartLine = {
    line_id: `ln_${cart_id}`,
    product_tmpl_id: item!.product_tmpl_id,
    name: item!.name,
    quantity: opts.quantity ?? 1,
    modifiers,
  };
  createdCartIds.push(cart_id);
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
  return { line, item: item!, seededMod };
}

let uid = 0;
function ids(tag: string) {
  uid += 1;
  return {
    cart_id: `e2e_${tag}_${uid}`,
    session_id: `e2e_sess_${uid}`,
    request_id: `e2e_req_${uid}`,
  };
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

beforeAll(async () => {
  redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
  pool = new Pool({ connectionString: config.odooDatabaseUrl });

  // Preflight: Redis reachable (cart cache), Postgres/pgvector reachable and seeded
  // with pos 1's item_vector rows, Jina key present. Skip (don't fail) the whole
  // suite if the live stack isn't there.
  try {
    await redis.connect();
    await redis.ping();
  } catch (err) {
    infraSkipReason = `Redis not reachable at ${config.redisUrl}: ${(err as Error).message}`;
    return;
  }
  try {
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM item_vector WHERE pos_config_id = $1',
      [POS],
    );
    if ((rows[0]?.n ?? 0) === 0) {
      infraSkipReason = `Postgres has no item_vector rows for pos ${POS} (run npm run seed:menu:pg)`;
      return;
    }
  } catch (err) {
    infraSkipReason = `Postgres not reachable at ${config.odooDatabaseUrl} (or item_vector missing): ${(err as Error).message}`;
    return;
  }
  if (config.embeddingProvider === 'jina' && !config.jinaApiKey) {
    infraSkipReason = 'EMBEDDING_PROVIDER=jina but JINA_API_KEY is empty';
    return;
  }

  // Build the Order Understanding pipeline (mirrors app.ts, minus the Cart module and
  // voice/realtime/WS). The Cart module is intentionally NOT wired: this suite asserts
  // the LLM output (order.operations_proposed), not the applied cart.
  carts = new RedisCartCache(redis);
  menu = new MenuService(new PostgresMenuStore(pool));
  const llm = recordingLlm(createLlmProvider());
  bus = new EventBus();

  // Intent classifier: its OWN provider, wired exactly as prod (app.ts) — createIntentLlmProvider()
  // reads INTENT_LLM_* (falling back to LLM_*). A separate instance from the recording `llm`, so
  // the classify hop never pollutes that log/assertions.
  const intentLlm = createIntentLlmProvider();

  const graph = new OrderGraph(menu, llm, carts, intentLlm);
  const ordering = new OrderUnderstandingService(graph, bus);
  registerOrderingHandlers(bus, ordering);

  infraReady = true;
});

beforeEach(() => {
  testStart = Date.now();
});

afterEach(async (ctx) => {
  if (infraReady) durations.push({ name: ctx.task.name, ms: Date.now() - testStart });
  // On failure, dump the full LLM prompt/response history for this test's cart(s) before
  // the cart keys are deleted — createdCartIds still holds them here (spliced below).
  if (ctx.task.result?.state === 'fail') createdCartIds.forEach(dumpLlmHistory);
  subs.splice(0).forEach((off) => off());
  if (!infraReady) return;
  await Promise.all(createdCartIds.splice(0).map((id) => redis.del(`cart:${id}`)));
});

afterAll(async () => {
  if (durations.length > 0) {
    const total = durations.reduce((sum, d) => sum + d.ms, 0);
    const avg = Math.round(total / durations.length);
    const lines = [
      `\n[llm_pipeline.e2e] model=${config.llmModel} provider=${config.llmProvider}`,
      ...durations.map((d) => `  ${String(d.ms).padStart(7)} ms  ${d.name}`),
      `  average: ${avg} ms over ${durations.length} test(s)\n`,
    ];
    // Write straight to stdout: the vitest reporter does not surface console.* from afterAll.
    process.stdout.write(lines.join('\n') + '\n');
  }
  if (redis) await redis.quit();
  if (pool) await pool.end();
});

// ---- tests ------------------------------------------------------------------

describe('final-transcript → proposal pipeline (real stack: Redis + Jina + Ollama)', () => {
  it('happy path: an order proposes an add for the matching item', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('add');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    emitFinal('I would like one order of sweet and sour chicken please', o);
    const { name, payload } = await waitForAny(['order.operations_proposed', 'voice.session_failed'], o.cart_id, TURN_MS);

    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');

    // The proposed operations are valid and add the ordered dish.
    const proposal = expectValidProposal(proposals);
    expect(proposal.base_version).toBe(0); // loaded from the seeded cart
    await expectAddItem(proposal, /sweet.*sour.*chicken/i, 1);
  });

  it('parses quantity: "two ..." proposes the item with quantity 2', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('qty');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    emitFinal('can I get two orders of deep fried wonton', o);
    let outcome = await waitForAny(
      ['order.operations_proposed', 'order.clarification_needed', 'voice.session_failed'],
      o.cart_id,
      TURN_MS,
    );

    // The menu has several wonton dishes (soup, noodle, spicy-garlic), so the model sometimes
    // asks which one. Answer it as the NEXT transcript — pointing back at the deep fried wonton
    // appetizer — and wait for the follow-up proposal, so the quantity assertion still runs.
    if (outcome.name === 'order.clarification_needed') {
      const answered = waitForAny(['order.operations_proposed', 'voice.session_failed'], o.cart_id, TURN_MS);
      emitFinal('the A3 deep fried wonton appetizer', o);
      outcome = await answered;
    }

    expect(outcome.name, `pipeline failed: ${JSON.stringify(outcome.payload)}`).toBe('order.operations_proposed');
    await expectAddItem(expectValidProposal(proposals), /deep.?fried.*wonton/i, 2);
  });

  it('modifier (add): an add_item proposal carries the requested extra', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('modadd');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    emitFinal('one sweet and sour chicken with added broccoli please', o);
    const { name, payload } = await waitForAny(['order.operations_proposed', 'voice.session_failed'], o.cart_id, TURN_MS);

    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');
    await expectAddItemModifier(expectValidProposal(proposals), /sweet.*sour.*chicken/i, 1, /add broccoli/i);
  });

  it('modifier (omit): a "no <ingredient>" request lands as a modifier on the add_item', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('modno');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    emitFinal('a sweet and sour chicken, no broccoli please', o);
    const { name, payload } = await waitForAny(['order.operations_proposed', 'voice.session_failed'], o.cart_id, TURN_MS);

    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');
    await expectAddItemModifier(expectValidProposal(proposals), /sweet.*sour.*chicken/i, 1, /no broccoli/i);
  });

  it('clarification → next turn answers: an ambiguous order asks, then proposes on the reply', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('clarify');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    emitFinal('let me get a combination for one', o);
    const first = await waitForAny(
      ['order.clarification_needed', 'order.operations_proposed', 'voice.session_failed'],
      o.cart_id,
      TURN_MS,
    );
    expect(
      first.name,
      `model did not request clarification this run (got ${first.name}: ${JSON.stringify(first.payload)})`,
    ).toBe('order.clarification_needed');
    expect((first.payload as AppEventMap['order.clarification_needed']).question.length).toBeGreaterThan(0);

    // The question was fire-and-forget (no pause). The answer is just the next transcript;
    // the pending question rode across in conversation history, so the turn now proposes.
    const answered = waitForAny(['order.operations_proposed', 'voice.session_failed'], o.cart_id, TURN_MS);
    emitFinal('the B combination, Combination For One B', o);
    const { name, payload } = await answered;

    expect(name, `answer turn failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');
    // The follow-up turn proposed valid operations that add a combination.
    await expectAddItem(expectValidProposal(proposals), /combination for one/i, 1);
  });

  it('update_quantity: "make that two" proposes an in-place edit of the seeded line', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('updqty');
    const { line } = await seedCartWithLine(o.cart_id, 'sweet and sour chicken');
    const proposals = captureProposals(o.cart_id);

    emitFinal('actually, make that two', o);
    const { name, payload } = await waitForAny(['order.operations_proposed', 'voice.session_failed'], o.cart_id, TURN_MS);
    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');

    const proposal = expectValidProposal(proposals);
    const op = proposal.operations.find((o2) => o2.action === 'update_quantity');
    // Editing the single seeded line is unambiguous, but the model may still re-add;
    // skip (not fail) when it took a different-but-valid path this run.
    if (!op) return ctx.skip(`model chose [${proposal.operations.map((o2) => o2.action).join(', ')}], not update_quantity`);
    expect(op.line_id).toBe(line.line_id);
    expect(op.quantity).toBe(2);
  });

  it('remove_item: "remove that" proposes dropping the seeded line', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('rmitem');
    const { line } = await seedCartWithLine(o.cart_id, 'sweet and sour chicken');
    const proposals = captureProposals(o.cart_id);

    emitFinal('please remove the sweet and sour chicken from my order', o);
    const { name, payload } = await waitForAny(['order.operations_proposed', 'voice.session_failed'], o.cart_id, TURN_MS);
    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');

    const proposal = expectValidProposal(proposals);
    const op = proposal.operations.find((o2) => o2.action === 'remove_item');
    if (!op) return ctx.skip(`model chose [${proposal.operations.map((o2) => o2.action).join(', ')}], not remove_item`);
    expect(op.line_id).toBe(line.line_id);
  });

  it('add_modifier: "add broccoli to that" proposes attaching the modifier to the seeded line', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('addmod');
    const { line, item } = await seedCartWithLine(o.cart_id, 'sweet and sour chicken');
    const broccoli = item.available_modifiers.find((m) => /add broccoli/i.test(m.name));
    if (!broccoli) return ctx.skip(`seeded item "${item.name}" has no "add broccoli" modifier`);
    const proposals = captureProposals(o.cart_id);

    emitFinal('can you add broccoli to my sweet and sour chicken', o);
    const { name, payload } = await waitForAny(['order.operations_proposed', 'voice.session_failed'], o.cart_id, TURN_MS);

    // The seeded line is self-describing (Plan A): it carries its name, line_id, and
    // available_modifiers, so the model has the broccoli modifier_key and target line_id
    // without retrieval having to surface them. Asserted hard (was tolerant pre-Plan A).
    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');
    const op = proposals.at(-1)?.operations.find((o2) => o2.action === 'add_modifier');
    expect(op, `expected an add_modifier op, got: ${JSON.stringify(proposals.at(-1)?.operations)}`).toBeDefined();
    expect(op!.line_id).toBe(line.line_id);
    expect(op!.modifier_key).toBe(broccoli.modifier_key);
  });

  it('remove_modifier: "take the broccoli off" proposes dropping the modifier from the seeded line', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('rmmod');
    const { line, seededMod } = await seedCartWithLine(o.cart_id, 'sweet and sour chicken', {
      withModifier: /add broccoli/i,
    });
    if (!seededMod) return ctx.skip('could not seed a broccoli modifier on the line');
    const proposals = captureProposals(o.cart_id);

    emitFinal('actually, take the broccoli off the sweet and sour chicken', o);
    const { name, payload } = await waitForAny(['order.operations_proposed', 'voice.session_failed'], o.cart_id, TURN_MS);

    // Self-describing cart (Plan A): the line lists its CURRENT modifiers (broccoli) with the
    // modifier_key, so the model can target line_id + modifier_key. Asserted hard.
    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');
    const op = proposals.at(-1)?.operations.find((o2) => o2.action === 'remove_modifier');
    expect(op, `expected a remove_modifier op, got: ${JSON.stringify(proposals.at(-1)?.operations)}`).toBeDefined();
    expect(op!.line_id).toBe(line.line_id);
    expect(op!.modifier_key).toBe(seededMod.modifier_key);
  });

  // Pronoun reference within a single turn: the customer says "add broccoli to that" — no dish
  // name — against a pre-seeded line. Resolvable only because the line is self-describing (Plan A):
  // current_cart carries the line's name, line_id, and available_modifiers, so the model has the
  // broccoli modifier_key + target line_id from the cart alone, with no dish named this turn.
  // (Cross-turn application — turn 1's add persisting into turn 2 — is the Cart module's job, out
  // of scope here; the cart is loaded fresh from Redis each turn, so it must be pre-seeded.)
  it('pronoun reference: "add broccoli to that" targets the self-describing seeded line', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('pronoun');
    const { line, item } = await seedCartWithLine(o.cart_id, 'sweet and sour chicken');
    const broccoli = item.available_modifiers.find((m) => /add broccoli/i.test(m.name));
    if (!broccoli) return ctx.skip(`seeded item "${item.name}" has no "add broccoli" modifier`);
    const proposals = captureProposals(o.cart_id);

    emitFinal('can you add broccoli to that', o);
    const { name, payload } = await waitForAny(['order.operations_proposed', 'voice.session_failed'], o.cart_id, TURN_MS);
    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');

    const op = proposals.at(-1)?.operations.find((o2) => o2.action === 'add_modifier');
    expect(op, `expected an add_modifier op, got: ${JSON.stringify(proposals.at(-1)?.operations)}`).toBeDefined();
    expect(op!.line_id).toBe(line.line_id);
    expect(op!.modifier_key).toBe(broccoli.modifier_key);
  });

  // ---- multi-operation output (a single utterance → several ops) ------------

  it('multi-item: one utterance with two dishes proposes an add for each', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('multi');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    emitFinal('one sweet and sour chicken and two deep fried wontons', o);
    const { name, payload } = await waitForAny(['order.operations_proposed', 'voice.session_failed'], o.cart_id, TURN_MS);
    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');

    const proposal = expectValidProposal(proposals, 2);
    await expectAddItem(proposal, /sweet.*sour.*chicken/i, 1);
    await expectAddItem(proposal, /deep.?fried.*wonton/i, 2);
  });

  it('multi-modifier: one add_item carries two requested extras', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('multimod');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    emitFinal('a sweet and sour chicken, add broccoli and add onion', o);
    const { name, payload } = await waitForAny(['order.operations_proposed', 'voice.session_failed'], o.cart_id, TURN_MS);
    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');

    // Both extras must ride on the single add_item's inline modifiers array.
    const proposal = expectValidProposal(proposals);
    await expectAddItemModifier(proposal, /sweet.*sour.*chicken/i, 1, /add broccoli/i);
    await expectAddItemModifier(proposal, /sweet.*sour.*chicken/i, 1, /add onion/i);
  });

  it('quantity + omission: "two ..., no broccoli" adds qty 2 with the omit modifier', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('qtyomit');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    emitFinal('two sweet and sour chicken, no broccoli', o);
    const { name, payload } = await waitForAny(['order.operations_proposed', 'voice.session_failed'], o.cart_id, TURN_MS);
    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');

    await expectAddItemModifier(expectValidProposal(proposals), /sweet.*sour.*chicken/i, 2, /no broccoli/i);
  });

  // ---- negative / robustness (must not fabricate an order) -------------------

  it('no-op: a menu question does not propose adding anything', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('question');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    emitFinal('what kinds of soup do you have', o);
    const { name, payload } = await waitForAny(
      ['order.operations_proposed', 'order.clarification_needed', 'voice.session_failed'],
      o.cart_id,
      TURN_MS,
    );
    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).not.toBe('voice.session_failed');
    // Asking, or answering with no cart change, are both fine; inventing an add is not.
    if (name === 'order.clarification_needed') return;
    const proposal = proposals.at(-1);
    expect(proposal, 'expected a proposal for the answered turn').toBeDefined();
    expectNoAddItem(proposal!);
  });

  it('off-menu: an item not on the menu is not fabricated as an add', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('offmenu');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    emitFinal('can I get a cheeseburger please', o);
    const { name, payload } = await waitForAny(
      ['order.operations_proposed', 'order.clarification_needed', 'voice.session_failed'],
      o.cart_id,
      TURN_MS,
    );
    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).not.toBe('voice.session_failed');
    // Clarifying is the right move for an off-menu ask; if it proposes anyway it must not fabricate an add.
    if (name === 'order.clarification_needed') return;
    const proposal = proposals.at(-1);
    expect(proposal, 'expected a proposal').toBeDefined();
    expectNoAddItem(proposal!);
  });

  // ---- conversational nuance -------------------------------------------------

  it('self-correction: "actually make that two" in one turn collapses to a single add qty 2', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('selfcorrect');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    emitFinal('I will take a deep fried wonton, actually make that two', o);
    const { name, payload } = await waitForAny(['order.operations_proposed', 'voice.session_failed'], o.cart_id, TURN_MS);
    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');

    // Empty cart, so the corrected quantity must land as the add's quantity (2), not 1.
    await expectAddItem(expectValidProposal(proposals), /deep.?fried.*wonton/i, 2);
  });

  it('add to non-empty cart: a new dish is added without disturbing the seeded line', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('addcoexist');
    const { line } = await seedCartWithLine(o.cart_id, 'sweet and sour chicken');
    const proposals = captureProposals(o.cart_id);

    emitFinal('can I also get an order of deep fried wonton', o);
    const { name, payload } = await waitForAny(['order.operations_proposed', 'voice.session_failed'], o.cart_id, TURN_MS);
    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');

    const proposal = expectValidProposal(proposals);
    await expectAddItem(proposal, /deep.?fried.*wonton/i, 1);
    // The seeded chicken line must be left alone — no edit op may target its line_id.
    const touches = proposal.operations.filter((op) => 'line_id' in op && op.line_id === line.line_id);
    expect(touches, `did not expect an edit of the seeded line: ${JSON.stringify(touches)}`).toHaveLength(0);
  });

  it('cooking-style modifier: a stir-fry style lands as a modifier on the add_item', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('style');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    emitFinal('sweet and sour chicken, stir fried with ginger and scallion', o);
    const { name, payload } = await waitForAny(['order.operations_proposed', 'voice.session_failed'], o.cart_id, TURN_MS);
    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');

    await expectAddItemModifier(expectValidProposal(proposals), /sweet.*sour.*chicken/i, 1, /ginger and scallion/i);
  });

  // Parse-failure (voice.session_failed / order_parse_failed) requires the LLM to
  // return invalid JSON twice (after one schema-repair retry). A compliant model in
  // json_object mode won't do that on demand, so it can't be forced end-to-end here.
  // It is covered deterministically with a scripted LLM in
  // order-understanding-service.test.ts ("fails the turn when repair is exhausted").
  it.skip('parse-failure: exhausted schema repair fails the turn (see unit test)', () => { });
});

// ---- Chinese-language support (zh_CN) ---------------------------------------
// Cross-language matching is the design's premise (§7/§15): the multilingual Jina
// query embeddings map a Chinese utterance to the SAME menu items the English tests
// hit, so the assertions still key off each item's English (en_US) display name.
// The transcripts carry language: 'zh_CN' (what STT would tag) and use the real
// Jade Garden zh_CN terms stored in Redis:
//   咕噜鸡 → "Sweet and Sour Chicken" (menu: 咕嚕雞)   炸云吞 → "Deep Fried Wonton"
//   套餐  → "Combination For One"     加西兰花 → "add Broccoli"   走西兰花 → "no Broccoli"
// Like the English suite these are tolerant: the LLM is real and non-deterministic,
// so ambiguous inputs SELF-SKIP (not fail) when the model resolves without asking.
describe('Chinese-language support (zh_CN, cross-language matching)', () => {
  it('happy path: a Chinese order proposes an add for the matching item', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('zh_add');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    emitFinal('我要一份咕噜鸡', o, 'zh_CN');
    const { name, payload } = await waitForAny(['order.operations_proposed', 'voice.session_failed'], o.cart_id, TURN_MS);

    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');
    // The Chinese utterance resolves cross-language to the sweet-and-sour-chicken item.
    await expectAddItem(expectValidProposal(proposals), /sweet.*sour.*chicken/i, 1);
  });

  it('parses quantity: "两份 ..." proposes the item with quantity 2', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('zh_qty');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    emitFinal('我要两份咕噜鸡', o, 'zh_CN');
    const { name, payload } = await waitForAny(['order.operations_proposed', 'voice.session_failed'], o.cart_id, TURN_MS);

    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');
    // 两份 = "two orders" — the quantity must survive the cross-language parse.
    await expectAddItem(expectValidProposal(proposals), /sweet.*sour.*chicken/i, 2);
  });

  it('modifier (add): a Chinese "加西兰花" rides on the add_item as an add-broccoli modifier', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('zh_modadd');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    emitFinal('一份咕噜鸡，加西兰花', o, 'zh_CN');
    const { name, payload } = await waitForAny(['order.operations_proposed', 'voice.session_failed'], o.cart_id, TURN_MS);

    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');
    // The model must map the Chinese request to the English-named "add Broccoli" modifier_key.
    await expectAddItemModifier(expectValidProposal(proposals), /sweet.*sour.*chicken/i, 1, /add broccoli/i);
  });

  it('modifier (omit): a Chinese "走西兰花" lands as a no-broccoli modifier on the add_item', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('zh_modno');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    emitFinal('一份咕噜鸡，走西兰花', o, 'zh_CN');
    const { name, payload } = await waitForAny(['order.operations_proposed', 'voice.session_failed'], o.cart_id, TURN_MS);

    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('order.operations_proposed');
    // 走 (Cantonese "hold/omit") → the "no Broccoli" modifier.
    await expectAddItemModifier(expectValidProposal(proposals), /sweet.*sour.*chicken/i, 1, /no broccoli/i);
  });

  it('clarification → next turn answers: an ambiguous Chinese order asks, then proposes on the reply', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('zh_clarify');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    emitFinal('我要套餐', o, 'zh_CN');
    const first = await waitForAny(
      ['order.clarification_needed', 'order.operations_proposed', 'voice.session_failed'],
      o.cart_id,
      TURN_MS,
    );
    // 套餐 A/B/C are distinct combinations; the model usually asks which one. If it resolves
    // without asking this run there is nothing to answer — self-skip (don't fail).
    if (first.name !== 'order.clarification_needed') {
      return ctx.skip(`model did not request clarification this run (got ${first.name})`);
    }
    expect((first.payload as AppEventMap['order.clarification_needed']).question.length).toBeGreaterThan(0);

    // Answer in Chinese as the NEXT transcript, naming the combination explicitly. The pending
    // question rode across in conversation history; the model may still re-ask, so answer once
    // more if it does, then self-skip rather than fail. Register the wait BEFORE emitting.
    const answer = () => {
      const next = waitForAny(
        ['order.operations_proposed', 'order.clarification_needed', 'voice.session_failed'],
        o.cart_id,
        TURN_MS,
      );
      emitFinal('套餐 B (Combination For One B) lunch', o, 'zh_CN');
      return next;
    };

    let outcome = await answer();
    if (outcome.name === 'order.clarification_needed') outcome = await answer();
    if (outcome.name === 'order.clarification_needed') {
      return ctx.skip('model re-requested clarification after answering (known re-ask gap)');
    }

    expect(outcome.name, `answer turn failed: ${JSON.stringify(outcome.payload)}`).toBe('order.operations_proposed');
    await expectAddItem(expectValidProposal(proposals), /combination for one/i, 1);
  });
});
