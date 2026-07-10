import { describe, it, expect, beforeEach } from 'vitest';
import type { CartId, PosConfigId, PosOrderId } from '../shared/types.js';
import { EventBus } from '../events/event-bus.js';
import type { CartOperationRejected, CartUpdated } from '../events/event-types.js';
import { InMemoryCartCache } from '../redis/cart-cache.js';
import { MenuService } from '../menu/menu-service.js';
import { InMemoryMenuStore } from '../menu/in-memory-menu-store.js';
import type { MenuItem } from '../menu/menu-types.js';
import type { OrderProposal } from '../ordering/schemas/proposal.js';
import type { CartOperation } from '../ordering/schemas/cart-operation.schema.js';
import { CartController } from './cart-controller.js';
import { InMemoryCartRepository } from './cart-repository.js';
import type { Cart } from './cart-types.js';

const POS: PosConfigId = 1;
const CART: CartId = 'cart_1';

function makeMenu(): MenuService {
  const items: MenuItem[] = [
    {
      product_tmpl_id: 100,
      menu_item_key: 'chicken_burger',
      names: { en_US: 'Chicken Burger' },
      base_price_cents: 500,
      available: true,
      modifiers: [{ modifier_key: 'no_mayo', ptav_id: 900, name: 'No mayo' }],
    },
    {
      product_tmpl_id: 200,
      menu_item_key: 'fries',
      names: { en_US: 'Fries' },
      base_price_cents: 300,
      available: true,
      modifiers: [],
    },
  ];
  return new MenuService(InMemoryMenuStore.of(POS, items));
}

interface Harness {
  bus: EventBus;
  cache: InMemoryCartCache;
  repo: InMemoryCartRepository;
  controller: CartController;
  updated: CartUpdated[];
  rejected: CartOperationRejected[];
}

function setup(): Harness {
  const bus = new EventBus();
  const cache = new InMemoryCartCache();
  const repo = new InMemoryCartRepository(cache);
  const controller = new CartController(cache, makeMenu(), repo, bus);
  const updated: CartUpdated[] = [];
  const rejected: CartOperationRejected[] = [];
  bus.on('cart.updated', (e) => updated.push(e));
  bus.on('cart.operation_rejected', (e) => rejected.push(e));
  return { bus, cache, repo, controller, updated, rejected };
}

let seq = 0;
function proposal(operations: CartOperation[], overrides: Partial<OrderProposal> = {}): OrderProposal {
  return {
    request_id: `req_${(seq += 1)}`,
    cart_id: CART,
    pos_config_id: POS,
    base_version: 0,
    operations,
    ...overrides,
  };
}

const addBurger: CartOperation = { action: 'add_item', menu_item_key: 'chicken_burger', quantity: 1, modifiers: [] };
const addFries: CartOperation = { action: 'add_item', menu_item_key: 'fries', quantity: 1, modifiers: [] };

describe('CartController.applyProposal', () => {
  let h: Harness;
  beforeEach(() => {
    seq = 0;
    h = setup();
  });

  it('creates the cart on first apply and emits cart.updated at version 1', async () => {
    const p = proposal([addBurger]);
    await h.controller.applyProposal(p);

    const cart = await h.cache.get(CART);
    expect(cart?.version).toBe(1);
    expect(cart?.pos_config_id).toBe(POS);
    expect(cart?.items).toHaveLength(1);

    expect(h.updated).toHaveLength(1);
    expect(h.updated[0]!.version).toBe(1);
    expect(h.updated[0]!.cart.items).toHaveLength(1);
    // request_id is carried on cart.updated so the event bus can trace the turn.
    expect(h.updated[0]!.request_id).toBe(p.request_id);
    expect(h.rejected).toHaveLength(0);
  });

  it('bumps the version once per proposal, not once per operation', async () => {
    await h.controller.applyProposal(proposal([addBurger, addFries]));

    const cart = await h.cache.get(CART);
    expect(cart?.version).toBe(1);
    expect(cart?.items).toHaveLength(2);
    expect(h.updated).toHaveLength(1);
  });

  it('is idempotent — the same request_id is never applied twice', async () => {
    const p = proposal([addBurger]);
    await h.controller.applyProposal(p);
    await h.controller.applyProposal(p);

    const cart = await h.cache.get(CART);
    expect(cart?.version).toBe(1);
    expect(cart?.items).toHaveLength(1);
    expect(h.updated).toHaveLength(1);
  });

  it('rejects a bad op with cart.operation_rejected and leaves the cart untouched', async () => {
    await h.controller.applyProposal(proposal([{ action: 'remove_item', line_id: 'ln_missing' }]));

    expect(await h.cache.get(CART)).toBeUndefined();
    expect(h.updated).toHaveLength(0);
    expect(h.rejected).toHaveLength(1);
    const r = h.rejected[0]!;
    expect(r.reason).toBe('line_gone');
    expect(r.message).toBeTruthy();
    expect(r.operation).toEqual({ action: 'remove_item', line_id: 'ln_missing' });
  });

  it('applies the good ops and rejects the bad ones in a mixed batch', async () => {
    await h.controller.applyProposal(proposal([addBurger, { action: 'remove_item', line_id: 'ln_missing' }]));

    const cart = await h.cache.get(CART);
    expect(cart?.version).toBe(1);
    expect(cart?.items).toHaveLength(1);
    expect(h.updated).toHaveLength(1);
    expect(h.rejected).toHaveLength(1);
    expect(h.rejected[0]!.reason).toBe('line_gone');
  });

  it('forwards session_id on rejection events and omits it when absent', async () => {
    await h.controller.applyProposal(proposal([{ action: 'remove_item', line_id: 'ln_x' }]), 'sess_42');
    await h.controller.applyProposal(proposal([{ action: 'remove_item', line_id: 'ln_y' }]));

    expect(h.rejected[0]!.session_id).toBe('sess_42');
    expect(h.rejected[1]!.session_id).toBeUndefined();
  });

  describe('rebase against a moved cart (Tier 2)', () => {
    it('still applies add_item from a stale base_version', async () => {
      await h.controller.applyProposal(proposal([addBurger])); // cart now at v1
      // Stale proposal computed against version 0, but adds commute.
      await h.controller.applyProposal(proposal([addFries], { base_version: 0 }));

      const cart = await h.cache.get(CART);
      expect(cart?.version).toBe(2);
      expect(cart?.items).toHaveLength(2);
      expect(h.updated).toHaveLength(2);
    });

    it('rejects a stale edit whose target line is gone, applying the rest', async () => {
      await h.controller.applyProposal(proposal([addBurger])); // v1, one line
      // Edit targets a line that never existed in the current cart; the add still lands.
      await h.controller.applyProposal(
        proposal([addFries, { action: 'update_quantity', line_id: 'ln_stale', quantity: 5 }], { base_version: 0 }),
      );

      const cart = await h.cache.get(CART);
      expect(cart?.version).toBe(2);
      expect(cart?.items).toHaveLength(2); // burger + fries; stale edit dropped
      expect(h.rejected).toHaveLength(1);
      expect(h.rejected[0]!.reason).toBe('line_gone');
    });
  });

  it('serializes concurrent applies on the same cart without clobbering (apply lock)', async () => {
    await Promise.all([
      h.controller.applyProposal(proposal([addBurger])),
      h.controller.applyProposal(proposal([addFries])),
    ]);

    const cart = await h.cache.get(CART);
    expect(cart?.version).toBe(2);
    expect(cart?.items).toHaveLength(2);
    // Two distinct updates at versions 1 and 2 — neither overwrote the other.
    expect(h.updated.map((u) => u.version).sort()).toEqual([1, 2]);
  });

  it('marks an all-rejected proposal processed so a retry stays a no-op', async () => {
    const p = proposal([{ action: 'remove_item', line_id: 'ln_missing' }]);
    await h.controller.applyProposal(p);
    await h.controller.applyProposal(p);

    // Second call short-circuits on idempotency: still exactly one rejection emitted.
    expect(h.rejected).toHaveLength(1);
    expect(h.updated).toHaveLength(0);
  });

  it('surfaces an infra error as internal_error and leaves the request unmarked for retry', async () => {
    // A menu that throws stands in for Redis/menu being unavailable mid-apply.
    const throwingMenu = {
      resolveItemKey: async () => {
        throw new Error('redis down');
      },
      findByTmplId: async () => undefined,
      getItems: async () => [],
    } as unknown as MenuService;
    const bus = new EventBus();
    const cache = new InMemoryCartCache();
    const repo = new InMemoryCartRepository(cache);
    const controller = new CartController(cache, throwingMenu, repo, bus);
    const updated: CartUpdated[] = [];
    const rejected: CartOperationRejected[] = [];
    bus.on('cart.updated', (e) => updated.push(e));
    bus.on('cart.operation_rejected', (e) => rejected.push(e));

    const p = proposal([addBurger]);
    await controller.applyProposal(p, 'sess_1');

    expect(updated).toHaveLength(0);
    expect(await cache.get(CART)).toBeUndefined(); // nothing persisted
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBe('internal_error');
    expect(rejected[0]!.session_id).toBe('sess_1');
    expect(await repo.wasProcessed(p.request_id)).toBe(false); // retry can reprocess
  });

  it('does nothing and emits nothing for an empty operations batch', async () => {
    await h.controller.applyProposal(proposal([]));

    expect(await h.cache.get(CART)).toBeUndefined();
    expect(h.updated).toHaveLength(0);
    expect(h.rejected).toHaveLength(0);
  });

  it('treats request_id as globally unique — a reused id on another cart is skipped', async () => {
    // The idempotency ledger keys on request_id alone while the apply lock keys on
    // cart_id, so a second proposal reusing the id (even for a different cart) is
    // short-circuited by wasProcessed and never creates the second cart.
    const p1 = proposal([addBurger], { cart_id: 'cart_A' });
    await h.controller.applyProposal(p1);
    await h.controller.applyProposal({ ...p1, cart_id: 'cart_B' });

    expect(await h.cache.get('cart_A')).toBeDefined();
    expect(await h.cache.get('cart_B')).toBeUndefined();
    expect(h.updated).toHaveLength(1);
  });

  describe('confirm', () => {
    it('is a no-op when the cart does not exist', async () => {
      const confirmed: Cart[] = [];
      const cache = new InMemoryCartCache();
      const repo = new (class extends InMemoryCartRepository {
        override async confirmOrder(cart: Cart): Promise<PosOrderId> {
          confirmed.push(cart);
          return 0;
        }
      })(cache);
      const controller = new CartController(cache, makeMenu(), repo, new EventBus());

      await controller.confirm('missing');
      expect(confirmed).toHaveLength(0);
    });

    it('confirms an existing cart through the repository', async () => {
      const confirmed: Cart[] = [];
      const cache = new InMemoryCartCache();
      const repo = new (class extends InMemoryCartRepository {
        override async confirmOrder(cart: Cart): Promise<PosOrderId> {
          confirmed.push(cart);
          return 0;
        }
      })(cache);
      const controller = new CartController(cache, makeMenu(), repo, new EventBus());
      await controller.applyProposal(proposal([addBurger]));

      await controller.confirm(CART);
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0]!.cart_id).toBe(CART);
    });
  });
});
