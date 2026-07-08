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
import { CartRepository } from '../cart/cart-repository.js';
import { CartController } from '../cart/cart-controller.js';
import { registerCartHandlers } from '../cart/register-handlers.js';
import type { Cart, CartLine } from '../cart/cart-types.js';
import { cartOperationSchema } from './schemas/cart-operation.schema.js';
import type { OrderProposal } from './schemas/proposal.js';

const POS = 1;
/** A real qwen3:14b turn (retrieve + thinking + parse) runs ~45-60s. */
const TURN_MS = 150_000;

// ---- live pipeline (built once in beforeAll) --------------------------------
let redis: Redis;
let carts: RedisCartCache;
let menu: MenuService;
let bus: EventBus;
let infraReady = false;
let infraSkipReason = '';
const createdCartIds: string[] = [];
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

let uid = 0;
function ids(tag: string) {
  uid += 1;
  return {
    cart_id: `e2e_${tag}_${uid}`,
    session_id: `e2e_sess_${uid}`,
    request_id: `e2e_req_${uid}`,
  };
}

function emitFinal(text: string, o: { cart_id: string; session_id: string; request_id: string }): void {
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

  const cartController = new CartController(carts, menu, new CartRepository(), bus);
  registerCartHandlers(bus, cartController);

  infraReady = true;
});

afterEach(async () => {
  subs.splice(0).forEach((off) => off());
  if (!infraReady) return;
  await Promise.all(createdCartIds.splice(0).map((id) => redis.del(`cart:${id}`)));
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
    // Best-effort: if the model resolved without asking, there is no clarify branch to test.
    if (first.name !== 'order.clarification_needed') {
      return ctx.skip(`model did not request clarification this run (got ${first.name})`);
    }
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
    if (first.name !== 'order.clarification_needed') {
      return ctx.skip(`model did not request clarification this run (got ${first.name})`);
    }

    // Never answer → the service expires the wait after TIMEOUTS.clarificationMs.
    const { name, payload } = await waitForAny(
      ['voice.session_failed', 'cart.updated'],
      o.cart_id,
      TIMEOUTS.clarificationMs + 60_000,
    );
    expect(name).toBe('voice.session_failed');
    expect((payload as AppEventMap['voice.session_failed']).reason).toBe('clarification_timeout');
  });

  // Parse-failure (voice.session_failed / order_parse_failed) requires the LLM to
  // return invalid JSON twice (after one schema-repair retry). A compliant model in
  // json_object mode won't do that on demand, so it can't be forced end-to-end here.
  // It is covered deterministically with a scripted LLM in
  // order-understanding-service.test.ts ("fails the turn when repair is exhausted").
  it.skip('parse-failure: exhausted schema repair fails the turn (see unit test)', () => {});
});
