import { describe, it, expect } from 'vitest';
import { MenuService } from './menu-service.js';
import { InMemoryMenuStore } from './in-memory-menu-store.js';
import type { MenuItem } from './menu-types.js';
import { LIMITS, POPULARITY } from '../config/constants.js';

const POS = 1;

function item(tmpl: number, name: string, price: number, available = true): MenuItem {
  return {
    product_tmpl_id: tmpl,
    menu_item_key: name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
    names: { en_US: name },
    base_price_cents: price,
    available,
    modifiers: [],
  };
}

/** Store + service over a menu, with an optional qty-sold signal. The stub embedder emits no
 *  vectors, so the matcher takes its fuzzy-scan path — the ranking under test is unaffected. */
function serviceWith(items: MenuItem[], qtySold?: Array<[number, number]>): MenuService {
  const store = InMemoryMenuStore.of(POS, items);
  if (qtySold) store.setQtySold(POS, new Map(qtySold));
  return new MenuService(store);
}

const names = (set: { items: Array<{ name: string }> }): string[] => set.items.map((i) => i.name);

describe('MenuService.searchMenu', () => {
  describe('relevance (the default)', () => {
    it('finds an item by name and does not tier it — a relevance search runs no popularity query', async () => {
      const svc = serviceWith([item(10, 'Chicken Burger', 1000), item(12, 'Coke', 300)]);

      const set = await svc.searchMenu(POS, { query: 'chicken burger' });

      expect(names(set)).toContain('Chicken Burger');
      expect(set.items[0]?.popularity).toBeUndefined();
    });

    it('omits unavailable items', async () => {
      const svc = serviceWith([item(10, 'Chicken Burger', 1000, false)]);

      expect(names(await svc.searchMenu(POS, { query: 'chicken burger' }))).toEqual([]);
    });
  });

  describe('price filters', () => {
    it('filters BEFORE the top-N cut, so a cheap match ranked past the cut still surfaces', async () => {
      // The decoys carry the query verbatim, so they all tie at a perfect name score and the
      // cheap item necessarily sorts BELOW them — past the maxCandidatesToLlm (8) cut. That
      // ordering is the point: filter-then-cut returns the cheap item, cut-then-filter returns
      // nothing (the 8 survivors are all $20). A cheap item that also matched best would pass
      // either way and pin nothing.
      const menu = [
        ...Array.from({ length: 12 }, (_, i) => item(100 + i, 'Rice Bowl Deluxe', 2000)),
        item(50, 'Rice Bowl', 300),
      ];
      const svc = serviceWith(menu);

      const set = await svc.searchMenu(POS, { query: 'rice bowl deluxe', max_price_cents: 500 });

      expect(names(set)).toEqual(['Rice Bowl']);
    });

    it('applies min and max as an inclusive window', async () => {
      const svc = serviceWith([item(10, 'Soup', 500), item(11, 'Salad', 1000), item(12, 'Steak', 3000)]);

      const set = await svc.searchMenu(POS, { min_price_cents: 500, max_price_cents: 1000 });

      expect(names(set).sort()).toEqual(['Salad', 'Soup']);
    });
  });

  describe('popularity', () => {
    it('ranks by quantity, never revenue — a $0 best-seller outranks a pricey rare item', async () => {
      // The Izumi all-you-can-eat shape: its top seller is $0.00 salmon. Ranking by revenue
      // would put the restaurant's most popular food last.
      const svc = serviceWith(
        [item(10, 'Free Salmon', 0), item(11, 'Pricey Steak', 5000)],
        [
          [10, 89],
          [11, 2],
        ],
      );

      expect(names(await svc.searchMenu(POS, { sort: 'popularity' }))).toEqual([
        'Free Salmon',
        'Pricey Steak',
      ]);
    });

    it('answers a bare browse ("what do you suggest?") with no query at all', async () => {
      const svc = serviceWith(
        [item(10, 'Gyoza', 800), item(11, 'Ramen', 1200)],
        [
          [11, 30],
          [10, 5],
        ],
      );

      expect(names(await svc.searchMenu(POS, {}))).toEqual(['Ramen', 'Gyoza']);
    });

    it('over-fetches before re-ranking: the most popular match survives past the relevance cut', async () => {
      // THE TRAP. The decoys out-match "fish" lexically and crowd out the popular one, so a
      // relevance leg that truncates before the re-rank answers "the N most fish-like, ordered
      // by popularity" instead of "the most popular fish".
      //
      // 40 decoys, not 10: the relevance leg must take the set UNCUT, and any finite pool only
      // moves the N at which the trap reappears. A decoy count above any plausible cap (the
      // final 8, and the 32 an earlier revision used) is what makes this test pin that.
      const menu = [
        ...Array.from({ length: 40 }, (_, i) => item(100 + i, `Fish ${i}`, 900)),
        item(50, 'Fish Special Deluxe Platter', 1500),
      ];
      const svc = serviceWith(menu, [[50, 500]]);

      const set = await svc.searchMenu(POS, { query: 'fish', sort: 'popularity' });

      expect(set.items[0]?.name).toBe('Fish Special Deluxe Platter');
      expect(set.items[0]?.popularity).toBe('top');
    });

    it('re-orders relevant items but never admits irrelevant ones', async () => {
      // Coke is wildly popular but is not a fish; sorting by popularity must not surface it.
      const svc = serviceWith(
        [item(10, 'Salmon Sashimi', 900), item(12, 'Coke', 300)],
        [
          [12, 999],
          [10, 5],
        ],
      );

      expect(names(await svc.searchMenu(POS, { query: 'salmon', sort: 'popularity' }))).toEqual([
        'Salmon Sashimi',
      ]);
    });

    it('tiers by rank band, and leaves an unsold item untiered rather than bottom-tiered', async () => {
      // 30 items ranked 1..30 by descending qty, id 100+r-1 for rank r. Results cap at
      // maxCandidatesToLlm (8), so the rank-20/21 boundary is unobservable in a plain browse —
      // a price window pulls out exactly the ranks under test. Price, not a query: an exact
      // filter can't drift the way a fuzzy relevance score can.
      const RANKS = [1, POPULARITY.topRank, POPULARITY.topRank + 1, POPULARITY.popularRank, POPULARITY.popularRank + 1];
      const PROBE = 111;
      const idOfRank = (r: number): number => 100 + r - 1;
      const probed = new Set(RANKS.map(idOfRank));

      const menu = [
        ...Array.from({ length: 30 }, (_, i) =>
          item(100 + i, `Ranked ${i + 1}`, probed.has(100 + i) ? PROBE : 999),
        ),
        item(500, 'Never Sold', PROBE),
      ];
      const svc = serviceWith(
        menu,
        Array.from({ length: 30 }, (_, i) => [100 + i, 1000 - i] as [number, number]),
      );

      const set = await svc.searchMenu(POS, {
        sort: 'popularity',
        min_price_cents: PROBE,
        max_price_cents: PROBE,
      });
      const tierAt = (rank: number): string | undefined =>
        set.items.find((i) => i.product_tmpl_id === idOfRank(rank))?.popularity;

      expect(tierAt(1)).toBe('top');
      expect(tierAt(POPULARITY.topRank)).toBe('top'); // last 'top'
      expect(tierAt(POPULARITY.topRank + 1)).toBe('popular'); // first 'popular'
      expect(tierAt(POPULARITY.popularRank)).toBe('popular'); // last 'popular'
      expect(tierAt(POPULARITY.popularRank + 1)).toBeUndefined(); // past the band
      expect(set.items.find((i) => i.name === 'Never Sold')?.popularity).toBeUndefined();
    });

    it('degrades to an unranked list when the popularity signal is unavailable', async () => {
      // PostgresMenuStore returns an empty map on any query error (e.g. item_vector missing),
      // so the turn must still answer rather than fail.
      const svc = serviceWith([item(10, 'Gyoza', 800)]);

      const set = await svc.searchMenu(POS, { sort: 'popularity' });

      expect(names(set)).toEqual(['Gyoza']);
      expect(set.items[0]?.popularity).toBeUndefined();
    });

    it('never returns more than maxCandidatesToLlm, even when asked for more', async () => {
      const menu = Array.from({ length: 20 }, (_, i) => item(100 + i, `Item ${i}`, 500));
      const svc = serviceWith(menu);

      const set = await svc.searchMenu(POS, { sort: 'popularity', limit: 999 });

      expect(set.items).toHaveLength(LIMITS.maxCandidatesToLlm);
    });
  });
});

describe('InMemoryMenuStore.lexicalSearch', () => {
  // The double is only useful if it retrieves what `name ILIKE ANY('%word%')` retrieves. It
  // previously mirrored the RediSearch store deleted on 2026-07-13 (whole-phrase `includes` OR
  // fuzzy >= 0.6), which both over- and under-recalled against the SQL it now stands in for.
  const menu = [item(1, 'Cheeseburger', 800), item(2, 'Chicken Teriyaki Don', 1400)];

  it('matches per WORD, not on the whole phrase', async () => {
    const store = InMemoryMenuStore.of(POS, menu);

    // The regression that mattered: the phrase matched 'Cheeseburger' fuzzily but MISSED
    // 'Chicken Teriyaki Don', so the double under-recalled what production would retrieve.
    expect([...(await store.lexicalSearch(POS, ['chicken burger']))].sort()).toEqual([1, 2]);
  });

  it('does not match a typo — the SQL side is a plain ILIKE with no fuzzy leg', async () => {
    const store = InMemoryMenuStore.of(POS, menu);

    // 'cheesburger' is 0.917 similar to 'Cheeseburger', so the old fuzzy leg retrieved it while
    // `ILIKE '%cheesburger%'` finds nothing. Any phrase under the old 0.6 threshold (e.g.
    // 'burgr', at 0.417) would pass this test against either rule and pin nothing.
    expect([...(await store.lexicalSearch(POS, ['cheesburger']))]).toEqual([]);
  });

  it('drops words under 2 characters and phrases with no usable word', async () => {
    const store = InMemoryMenuStore.of(POS, menu);

    // 'a' as a substring hits both names; the real query never gets the chance, and a bare
    // space matched every multi-word name.
    expect([...(await store.lexicalSearch(POS, ['a']))]).toEqual([]);
    expect([...(await store.lexicalSearch(POS, ['!', ' ']))]).toEqual([]);
  });
});

describe('InMemoryMenuStore.popularity', () => {
  it('drops items that net <= 0, mirroring the store HAVING clause that hides a refund product', async () => {
    // A refund product nets negative (refund lines carry negative qty), which is why the real
    // Refund product sits at rank ~198 rather than anywhere near the top.
    const store = InMemoryMenuStore.of(POS, [item(10, 'Gyoza', 800), item(99, 'Refund', 0)]);
    store.setQtySold(POS, new Map([[10, 5], [99, -1]]));

    const popular = await store.popularity(POS);

    expect([...popular.keys()]).toEqual([10]);
  });

  it('drops qty for items that are not on this menu', async () => {
    const store = InMemoryMenuStore.of(POS, [item(10, 'Gyoza', 800)]);
    store.setQtySold(POS, new Map([[10, 5], [1206, 54]])); // 1206 = an excluded cover charge

    expect([...(await store.popularity(POS)).keys()]).toEqual([10]);
  });
});
