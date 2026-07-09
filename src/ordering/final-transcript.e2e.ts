/**
 * Real-stack e2e for the pipeline triggered on `stt.final_transcript.received`.
 *
 * Trigger:  emit the event on a real EventBus (the true pipeline entry — where STT
 *           hands off; see voice/voice-message-handler.ts).
 * Stack:    LIVE Redis Stack (real Jade Garden menu + idx:menuvec KNN index), LIVE
 *           Jina query embeddings (real vector retrieval), and a LIVE Ollama LLM.
 *           Nothing is mocked; the wiring mirrors app.ts minus voice/realtime/WS.
 * Assert:   the cart state written to Redis by the Cart module (via cart.updated).
 *
 * The LLM is real and non-deterministic, and the menu has many near-duplicate items
 * (lunch/dinner variants, 3 "Combination For One", etc.), so:
 *   - assertions are tolerant — the added item's NAME must match the ordered dish
 *     (any variant) with the right quantity, not a specific product_tmpl_id;
 *   - the clarification tests use input that maps to several distinct items and
 *     SELF-SKIP (not fail) when the model happens to resolve without asking;
 *   - the parse-failure branch cannot be forced with a compliant JSON-returning
 *     model, so it is skipped here and covered deterministically in
 *     order-understanding-service.test.ts.
 *
 * Prereqs (self-checked in beforeAll; the suite skips if missing):
 *   - Redis Stack at REDIS_URL, populated with pos_config_id 1's menu + index.
 *   - Ollama at LLM_BASE_URL serving LLM_MODEL (default qwen3:14b).
 *   - JINA_API_KEY for query embeddings (EMBEDDING_PROVIDER=jina).
 * Run with: npm run test:e2e   (see vitest.e2e.config.ts)
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import { config } from '../config/env.js';
import { TIMEOUTS } from '../config/constants.js';
import { EventBus } from '../events/event-bus.js';
import type { AppEventMap, AppEventName } from '../events/event-types.js';
import { RedisCartCache } from '../redis/cart-cache.js';
import { MenuService } from '../menu/menu-service.js';
import { RedisMenuStore } from '../menu/menu-store.js';
import { createLlmProvider } from '../llm/llm-client.js';
import { OrderGraph } from './order-graph.js';
import { OrderUnderstandingService } from './order-understanding-service.js';
import { registerOrderingHandlers } from './register-handlers.js';
import { RedisCartRepository } from '../cart/cart-repository.js';
import { CartController } from '../cart/cart-controller.js';
import { registerCartHandlers } from '../cart/register-handlers.js';
import type { Cart, CartLine, CartModifier } from '../cart/cart-types.js';
import type { CandidateItem, CandidateModifier } from '../menu/menu-types.js';
import { cartOperationSchema } from './schemas/cart-operation.schema.js';
import type { OrderProposal } from './schemas/proposal.js';

const POS = 1;
/** A real qwen3:14b turn (retrieve + thinking + parse) runs ~45-60s. */
const TURN_MS = 500_000;

// ---- live pipeline (built once in beforeAll) --------------------------------
let redis: Redis;
let carts: RedisCartCache;
let menu: MenuService;
let bus: EventBus;
let infraReady = false;
let infraSkipReason = '';
const createdCartIds: string[] = [];
const createdRequestIds: string[] = [];
const subs: Array<() => void> = [];

// ---- helpers ----------------------------------------------------------------

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
        if ((payload as { cart_id?: string }).cart_id !== cartId) return; // not our turn
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
 * module emits `order.operations_proposed` BEFORE the Cart module applies it, so
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
 * name matches `modPattern`, and return that modifier's ptav_id so the caller can
 * confirm it landed on the cart line. Validates the whole key→ptav_id resolution the
 * modifier path depends on.
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

/** English display name of a menu item, read straight from Redis. */
async function nameOfTmpl(tmpl: number): Promise<string> {
  const raw = await redis.get(`menu:item:${POS}:${tmpl}`);
  if (!raw) return '';
  return (JSON.parse(raw).names?.en_US as string) ?? '';
}

/** Assert exactly one line matches the dish name pattern, with the expected quantity. */
async function expectLine(cart: Cart, pattern: RegExp, quantity: number): Promise<CartLine> {
  const named = await Promise.all(
    cart.items.map(async (i) => ({ line: i, name: await nameOfTmpl(i.product_tmpl_id) })),
  );
  const hit = named.find((x) => pattern.test(x.name));
  expect(hit, `no cart line matches ${pattern} — cart had: ${named.map((x) => x.name).join(' | ')}`).toBeDefined();
  expect(hit!.line.quantity).toBe(quantity);
  return hit!.line;
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
  const { items } = await menu.getCandidates(POS, dishText);
  const item = items[0];
  expect(item, `no candidate item for "${dishText}" — is the menu populated?`).toBeDefined();

  const seededMod = opts.withModifier
    ? item!.available_modifiers.find((m) => opts.withModifier!.test(m.name))
    : undefined;
  const modifiers: CartModifier[] = seededMod ? [{ ptav_id: seededMod.ptav_id }] : [];

  const line: CartLine = {
    line_id: `ln_${cart_id}`,
    product_tmpl_id: item!.product_tmpl_id,
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

// The idempotency ledger (cart:req:{request_id}) is now Redis-backed and TTL-bounded
// (CART_IDEMPOTENCY_TTL_SECONDS, default 24h), so it SURVIVES across test runs. A
// per-run salt keeps request_ids unique per run: a re-run within the TTL that reused a
// prior id would be dropped as cart.duplicate_request and hang the turn to its timeout.
const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

let uid = 0;
function ids(tag: string) {
  uid += 1;
  return {
    cart_id: `e2e_${tag}_${uid}`,
    session_id: `e2e_sess_${uid}`,
    request_id: `e2e_req_${RUN}_${uid}`,
  };
}

function emitFinal(text: string, o: { cart_id: string; session_id: string; request_id: string }): void {
  // Every ledger-writing request_id flows through here (including the cross-turn
  // `_edit` variant), so recording it lets afterEach clear the ledger key it leaves.
  createdRequestIds.push(o.request_id);
  bus.emit('stt.final_transcript.received', {
    request_id: o.request_id,
    session_id: o.session_id,
    cart_id: o.cart_id,
    pos_config_id: POS,
    text,
  });
}

// ---- setup / teardown -------------------------------------------------------

beforeAll(async () => {
  redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });

  // Preflight: Redis reachable + populated, Jina key present, Ollama reachable.
  // Skip (don't fail) the whole suite if the live stack isn't there.
  try {
    await redis.connect();
    await redis.ping();
    if ((await redis.scard(`menu:items:${POS}`)) === 0) {
      infraSkipReason = `Redis has no menu for pos ${POS} (populate it + npm run index:menu)`;
      return;
    }
    if (config.embeddingProvider === 'jina' && !config.jinaApiKey) {
      infraSkipReason = 'EMBEDDING_PROVIDER=jina but JINA_API_KEY is empty';
      return;
    }
    const tags = await fetch(`${config.llmBaseUrl.replace(/\/v1\/?$/, '')}/api/tags`).catch(() => null);
    if (!tags || !tags.ok) {
      infraSkipReason = `Ollama not reachable at ${config.llmBaseUrl}`;
      return;
    }
  } catch (err) {
    infraSkipReason = `Redis not reachable at ${config.redisUrl}: ${(err as Error).message}`;
    return;
  }

  // Build the live pipeline (mirrors app.ts, minus voice/realtime/WS).
  carts = new RedisCartCache(redis);
  menu = new MenuService(new RedisMenuStore(redis));
  const llm = createLlmProvider();
  bus = new EventBus();

  const graph = new OrderGraph(menu, llm, carts);
  const ordering = new OrderUnderstandingService(graph, bus);
  registerOrderingHandlers(bus, ordering);

  const cartController = new CartController(carts, menu, new RedisCartRepository(redis, config.cartIdempotencyTtlSeconds), bus);
  registerCartHandlers(bus, cartController);

  infraReady = true;
});

afterEach(async () => {
  subs.splice(0).forEach((off) => off());
  if (!infraReady) return;
  await Promise.all([
    ...createdCartIds.splice(0).map((id) => redis.del(`cart:${id}`)),
    ...createdRequestIds.splice(0).map((id) => redis.del(`cart:req:${id}`)),
  ]);
});

afterAll(async () => {
  if (redis) await redis.quit();
});

// ---- tests ------------------------------------------------------------------

describe('final-transcript pipeline (real stack: Redis + Jina + Ollama)', () => {
  it('happy path: an order adds the matching item to the cart', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('add');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    emitFinal('I would like one order of sweet and sour chicken please', o);
    const { name, payload } = await waitForAny(['cart.updated', 'voice.session_failed'], o.cart_id, TURN_MS);

    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('cart.updated');

    // The proposed operations are valid and add the ordered dish.
    const proposal = expectValidProposal(proposals);
    expect(proposal.base_version).toBe(0); // loaded from the seeded cart
    await expectAddItem(proposal, /sweet.*sour.*chicken/i, 1);

    // ...and the Cart module applied them to the cart in Redis.
    const { cart } = payload as AppEventMap['cart.updated'];
    expect(cart.version).toBe(1);
    await expectLine(cart, /sweet.*sour.*chicken/i, 1);
    expect(cart.total_cents).toBeGreaterThan(0);
  });

  it('parses quantity: "two ..." adds the item with quantity 2', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('qty');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    emitFinal('can I get two orders of deep fried wonton', o);
    const { name, payload } = await waitForAny(['cart.updated', 'voice.session_failed'], o.cart_id, TURN_MS);

    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('cart.updated');
    await expectAddItem(expectValidProposal(proposals), /deep.?fried.*wonton/i, 2);
    await expectLine((payload as AppEventMap['cart.updated']).cart, /deep.?fried.*wonton/i, 2);
  });

  it('modifier (add): an add_item carries the requested extra onto the cart line', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('modadd');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    emitFinal('one sweet and sour chicken with added broccoli please', o);
    const { name, payload } = await waitForAny(['cart.updated', 'voice.session_failed'], o.cart_id, TURN_MS);

    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('cart.updated');
    const ptav = await expectAddItemModifier(expectValidProposal(proposals), /sweet.*sour.*chicken/i, 1, /add broccoli/i);

    // The modifier is present on the applied cart line (as a ptav_id).
    const line = await expectLine((payload as AppEventMap['cart.updated']).cart, /sweet.*sour.*chicken/i, 1);
    expect(line.modifiers.some((m) => m.ptav_id === ptav), `cart line missing modifier ptav_id ${ptav}`).toBe(true);
  });

  it('modifier (omit): a "no <ingredient>" request lands as a modifier on the cart line', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('modno');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    emitFinal('a sweet and sour chicken, no broccoli please', o);
    const { name, payload } = await waitForAny(['cart.updated', 'voice.session_failed'], o.cart_id, TURN_MS);

    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('cart.updated');
    const ptav = await expectAddItemModifier(expectValidProposal(proposals), /sweet.*sour.*chicken/i, 1, /no broccoli/i);

    const line = await expectLine((payload as AppEventMap['cart.updated']).cart, /sweet.*sour.*chicken/i, 1);
    expect(line.modifiers.some((m) => m.ptav_id === ptav), `cart line missing modifier ptav_id ${ptav}`).toBe(true);
  });

  it('clarification → resume: an ambiguous order asks, then applies the answer', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('clarify');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    emitFinal('let me get a combination for one', o);
    const first = await waitForAny(
      ['order.clarification_needed', 'cart.updated', 'voice.session_failed'],
      o.cart_id,
      TURN_MS,
    );
    expect(
      first.name,
      `model did not request clarification this run (got ${first.name}: ${JSON.stringify(first.payload)})`,
    ).toBe('order.clarification_needed');
    expect((first.payload as AppEventMap['order.clarification_needed']).question.length).toBeGreaterThan(0);

    // Answer, then expect the resumed turn to apply a combination.
    const applied = waitForAny(['cart.updated', 'voice.session_failed'], o.cart_id, TURN_MS);
    bus.emit('order.clarification_answered', {
      cart_id: o.cart_id,
      session_id: o.session_id,
      request_id: o.request_id,
      answer: 'the B combination, Combination For One B',
    });
    const { name, payload } = await applied;

    expect(name, `resume failed: ${JSON.stringify(payload)}`).toBe('cart.updated');
    // The resumed turn proposed valid operations that add a combination.
    await expectAddItem(expectValidProposal(proposals), /combination for one/i, 1);
    await expectLine((payload as AppEventMap['cart.updated']).cart, /combination for one/i, 1);
  });

  it('clarification → timeout: an unanswered clarification fails the turn', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('timeout');
    await seedEmptyCart(o.cart_id);

    emitFinal('let me get a combination for one', o);
    const first = await waitForAny(
      ['order.clarification_needed', 'cart.updated', 'voice.session_failed'],
      o.cart_id,
      TURN_MS,
    );
    expect(
      first.name,
      `model did not request clarification this run (got ${first.name}: ${JSON.stringify(first.payload)})`,
    ).toBe('order.clarification_needed');

    // Never answer → the service expires the wait after TIMEOUTS.clarificationMs.
    const { name, payload } = await waitForAny(
      ['voice.session_failed', 'cart.updated'],
      o.cart_id,
      TIMEOUTS.clarificationMs + 60_000,
    );
    expect(name).toBe('voice.session_failed');
    expect((payload as AppEventMap['voice.session_failed']).reason).toBe('clarification_timeout');
  });

  it('update_quantity: "make that two" edits the seeded line in place', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('updqty');
    const { line } = await seedCartWithLine(o.cart_id, 'sweet and sour chicken');
    const proposals = captureProposals(o.cart_id);

    emitFinal('actually, make that two', o);
    const { name, payload } = await waitForAny(['cart.updated', 'voice.session_failed'], o.cart_id, TURN_MS);
    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('cart.updated');

    const proposal = expectValidProposal(proposals);
    const op = proposal.operations.find((o2) => o2.action === 'update_quantity');
    // Editing the single seeded line is unambiguous, but the model may still re-add;
    // skip (not fail) when it took a different-but-valid path this run.
    if (!op) return ctx.skip(`model chose [${proposal.operations.map((o2) => o2.action).join(', ')}], not update_quantity`);
    expect(op.line_id).toBe(line.line_id);
    expect(op.quantity).toBe(2);

    const edited = (payload as AppEventMap['cart.updated']).cart.items.find((l) => l.line_id === line.line_id);
    expect(edited?.quantity, 'seeded line quantity was not updated to 2').toBe(2);
  });

  it('remove_item: "remove that" drops the seeded line from the cart', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('rmitem');
    const { line } = await seedCartWithLine(o.cart_id, 'sweet and sour chicken');
    const proposals = captureProposals(o.cart_id);

    emitFinal('please remove the sweet and sour chicken from my order', o);
    const { name, payload } = await waitForAny(['cart.updated', 'voice.session_failed'], o.cart_id, TURN_MS);
    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('cart.updated');

    const proposal = expectValidProposal(proposals);
    const op = proposal.operations.find((o2) => o2.action === 'remove_item');
    if (!op) return ctx.skip(`model chose [${proposal.operations.map((o2) => o2.action).join(', ')}], not remove_item`);
    expect(op.line_id).toBe(line.line_id);

    const stillThere = (payload as AppEventMap['cart.updated']).cart.items.some((l) => l.line_id === line.line_id);
    expect(stillThere, 'seeded line was not removed').toBe(false);
  });

  it('add_modifier: "add broccoli to that" attaches the modifier to the seeded line', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('addmod');
    const { line, item } = await seedCartWithLine(o.cart_id, 'sweet and sour chicken');
    const broccoli = item.available_modifiers.find((m) => /add broccoli/i.test(m.name));
    if (!broccoli) return ctx.skip(`seeded item "${item.name}" has no "add broccoli" modifier`);
    const proposals = captureProposals(o.cart_id);

    emitFinal('can you add broccoli to my sweet and sour chicken', o);
    const { name, payload } = await waitForAny(['cart.updated', 'voice.session_failed'], o.cart_id, TURN_MS);

    // The seeded line is self-describing (Plan A): it carries its name, line_id, and
    // available_modifiers, so the model has the broccoli modifier_key and target line_id
    // without retrieval having to surface them. Asserted hard (was tolerant pre-Plan A).
    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('cart.updated');
    const op = proposals.at(-1)?.operations.find((o2) => o2.action === 'add_modifier');
    expect(op, `expected an add_modifier op, got: ${JSON.stringify(proposals.at(-1)?.operations)}`).toBeDefined();
    expect(op!.line_id).toBe(line.line_id);
    expect(op!.modifier_key).toBe(broccoli.modifier_key);

    const edited = (payload as AppEventMap['cart.updated']).cart.items.find((l) => l.line_id === line.line_id);
    expect(edited?.modifiers.some((m) => m.ptav_id === broccoli.ptav_id), 'broccoli ptav_id not on line').toBe(true);
  });

  it('remove_modifier: "take the broccoli off" drops the modifier from the seeded line', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('rmmod');
    const { line, seededMod } = await seedCartWithLine(o.cart_id, 'sweet and sour chicken', {
      withModifier: /add broccoli/i,
    });
    if (!seededMod) return ctx.skip('could not seed a broccoli modifier on the line');
    const proposals = captureProposals(o.cart_id);

    emitFinal('actually, take the broccoli off the sweet and sour chicken', o);
    const { name, payload } = await waitForAny(['cart.updated', 'voice.session_failed'], o.cart_id, TURN_MS);

    // Self-describing cart (Plan A): the line lists its CURRENT modifiers (broccoli) with the
    // modifier_key, so the model can target line_id + modifier_key. Asserted hard.
    expect(name, `pipeline failed: ${JSON.stringify(payload)}`).toBe('cart.updated');
    const op = proposals.at(-1)?.operations.find((o2) => o2.action === 'remove_modifier');
    expect(op, `expected a remove_modifier op, got: ${JSON.stringify(proposals.at(-1)?.operations)}`).toBeDefined();
    expect(op!.line_id).toBe(line.line_id);
    expect(op!.modifier_key).toBe(seededMod.modifier_key);

    const edited = (payload as AppEventMap['cart.updated']).cart.items.find((l) => l.line_id === line.line_id);
    expect(edited?.modifiers.some((m) => m.ptav_id === seededMod.ptav_id), 'broccoli ptav_id still on line').toBe(false);
  });

  // Cross-turn modifier edit by reference. Turn 1 names the dish (adds the line); turn 2 says
  // "add broccoli to that" — a pronoun, no dish name — on the SAME cart. This works because the
  // cart-keyed MemorySaver thread carries state across turns AND the line is self-describing:
  // Plan A enriches the added line in current_cart with its name + available_modifiers, so the
  // model has the broccoli modifier_key + target line_id from the cart alone — no dependence on
  // this turn's retrieval. Real-stack + non-deterministic; asserted hard (was tolerant pre-Plan A).
  it('cross-turn modifier edit by reference: "add broccoli to that" edits an item named earlier', async (ctx) => {
    if (!infraReady) return ctx.skip(infraSkipReason);
    const o = ids('xturn');
    await seedEmptyCart(o.cart_id);
    const proposals = captureProposals(o.cart_id);

    // Turn 1 — name the dish; it is added and enriched into current_cart for the next turn.
    emitFinal('I would like one sweet and sour chicken', o);
    const t1 = await waitForAny(['cart.updated', 'voice.session_failed'], o.cart_id, TURN_MS);
    expect(t1.name, `turn 1 failed: ${JSON.stringify(t1.payload)}`).toBe('cart.updated');
    const seededLine = await expectLine((t1.payload as AppEventMap['cart.updated']).cart, /sweet.*sour.*chicken/i, 1);

    // Confirm the seeded item actually offers a broccoli modifier; otherwise nothing to assert.
    const { items } = await menu.getCandidates(POS, 'sweet and sour chicken');
    const broccoli = items[0]?.available_modifiers.find((m) => /add broccoli/i.test(m.name));
    if (!broccoli) return ctx.skip('seeded item has no "add broccoli" modifier');

    // Turn 2 — pronoun, names no dish. Resolvable only from cross-turn state (Plan A cart + Plan B).
    emitFinal('can you add broccoli to that', o);
    const t2 = await waitForAny(['cart.updated', 'voice.session_failed'], o.cart_id, TURN_MS);
    expect(t2.name, `turn 2 failed: ${JSON.stringify(t2.payload)}`).toBe('cart.updated');
    const op = proposals.at(-1)?.operations.find((o2) => o2.action === 'add_modifier');
    expect(op, `expected an add_modifier op, got: ${JSON.stringify(proposals.at(-1)?.operations)}`).toBeDefined();
    expect(op!.line_id).toBe(seededLine.line_id);
    expect(op!.modifier_key).toBe(broccoli.modifier_key);

    const edited = (t2.payload as AppEventMap['cart.updated']).cart.items.find((l) => l.line_id === seededLine.line_id);
    expect(edited?.modifiers.some((m) => m.ptav_id === broccoli.ptav_id), 'broccoli ptav_id not on line').toBe(true);
  });

  // Parse-failure (voice.session_failed / order_parse_failed) requires the LLM to
  // return invalid JSON twice (after one schema-repair retry). A compliant model in
  // json_object mode won't do that on demand, so it can't be forced end-to-end here.
  // It is covered deterministically with a scripted LLM in
  // order-understanding-service.test.ts ("fails the turn when repair is exhausted").
  it.skip('parse-failure: exhausted schema repair fails the turn (see unit test)', () => { });
});
