import type { PosConfigId, ProductTmplId } from '../shared/types.js';
import { CandidateMatcher, toCandidate, withinPrice } from './candidate-matcher.js';
import type { MatchOptions } from './candidate-matcher.js';
import type { MenuStore } from './menu-store.js';
import { createEmbeddingService } from './embedding-service.js';
import type { EmbeddingService } from './embedding-service.js';
import type {
  CandidateItem,
  CandidateSet,
  MenuItem,
  MenuSearchOptions,
  PopularityTier,
} from './menu-types.js';
import { LIMITS, POPULARITY } from '../config/constants.js';

/** The item lookups the Cart Module needs (design §8/§9). */
export interface MenuLookup {
  resolveItemKey(pos_config_id: PosConfigId, menu_item_key: string): Promise<MenuItem | undefined>;
  findByTmplId(pos_config_id: PosConfigId, product_tmpl_id: ProductTmplId): Promise<MenuItem | undefined>;
  /** Batch-hydrate items by id (one round trip) — used to reprice a cart. */
  getItems(pos_config_id: PosConfigId, product_tmpl_ids: ProductTmplId[]): Promise<MenuItem[]>;
}

/**
 * Facade over the menu store + candidate matcher (design §7). Every method reads
 * the store at request time — matching runs a KNN vector search per call and item
 * lookups are direct reads; there is no in-memory menu cache.
 */
export class MenuService implements MenuLookup {
  private readonly matcher: CandidateMatcher;

  constructor(
    private readonly store: MenuStore,
    embedder: EmbeddingService = createEmbeddingService(),
  ) {
    this.matcher = new CandidateMatcher(store, embedder);
  }

  /** Ensure the vector index exists (called once at boot). */
  ensureIndex(): Promise<void> {
    return this.store.ensureIndex();
  }

  /**
   * The agent's retrieval surface (docs/plans/agent-search-extension.md §4): relevance search,
   * price filter, and popularity sort, composed so a two-constraint request ("popular AND has
   * fish") resolves in ONE call — the intersection is this method's job, not the model's.
   *
   * A relevance-sorted search runs no popularity query and takes the same path the retrieval
   * tool has always taken (`matcher.match`), so the default is unchanged.
   */
  async searchMenu(pos_config_id: PosConfigId, opts: MenuSearchOptions): Promise<CandidateSet> {
    const limit = Math.min(opts.limit ?? LIMITS.maxCandidatesToLlm, LIMITS.maxCandidatesToLlm);
    // With no query there is no relevance signal, so ranking by it would return an arbitrary
    // N. Popularity is the only meaningful order for a bare browse ("what do you suggest?").
    const byPopularity = opts.sort === 'popularity' || !opts.query;
    // Built key-by-key: `exactOptionalPropertyTypes` rejects an explicit `undefined` for an
    // optional field, so an absent bound must be an absent key.
    const price: MatchOptions = {};
    if (opts.min_price_cents !== undefined) price.min_price_cents = opts.min_price_cents;
    if (opts.max_price_cents !== undefined) price.max_price_cents = opts.max_price_cents;

    if (!byPopularity) {
      return this.matcher.match(pos_config_id, opts.query ?? '', { ...price, limit });
    }

    const qtySold = await this.store.popularity(pos_config_id, POPULARITY.windowDays);
    const items = opts.query
      ? // `limit: Infinity` — take the relevant set UNCUT. Any cut here is applied by relevance,
        // so re-sorting what survives it answers "the N most fish-like, ordered by popularity"
        // rather than "the most popular fish". Rank wide, re-rank, THEN cut (below). A finite
        // pool would only raise the N at which that bug reappears. Recall is still bounded
        // upstream by the matcher's KNN retrieval width, which is a recall concern and not this
        // method's to widen. The relevance threshold still applies, so popularity re-orders
        // relevant items — it never admits irrelevant ones.
        (await this.matcher.match(pos_config_id, opts.query, { ...price, limit: Infinity })).items
      : await this.browse(pos_config_id, price);

    const ranked = [...qtySold.keys()].sort((a, b) => (qtySold.get(b) ?? 0) - (qtySold.get(a) ?? 0));
    const rankOf = new Map(ranked.map((tmpl, i) => [tmpl, i + 1]));
    const unranked = ranked.length + 1;

    const sorted = items
      .map((item) => {
        const tier = tierOf(rankOf.get(item.product_tmpl_id));
        return tier === undefined ? item : { ...item, popularity: tier };
      })
      .sort(
        (a, b) =>
          (rankOf.get(a.product_tmpl_id) ?? unranked) - (rankOf.get(b.product_tmpl_id) ?? unranked),
      );
    return { items: sorted.slice(0, limit) };
  }

  /**
   * The no-query corpus: every available item, price-filtered. Ordering is the caller's job.
   *
   * Hydrates the whole menu to return `limit` of it. The obvious shortcut — hydrate only the
   * top-ranked ids from `popularity()` — does not survive the price filter, which can reject
   * any number of them and needs the item to evaluate. The corpus is a few hundred items, and
   * the fuzzy-scan path already reads it whole.
   */
  private async browse(pos_config_id: PosConfigId, price: MatchOptions): Promise<CandidateItem[]> {
    const items = await this.store.allItems(pos_config_id);
    return items
      .filter((i) => i.available && withinPrice(i.base_price_cents, price))
      .map(toCandidate);
  }

  /** Resolve an LLM menu_item_key back to its Odoo product_tmpl_id (design §8). */
  resolveItemKey(pos_config_id: PosConfigId, menu_item_key: string): Promise<MenuItem | undefined> {
    return this.store.getItemByKey(pos_config_id, menu_item_key);
  }

  findByTmplId(pos_config_id: PosConfigId, product_tmpl_id: ProductTmplId): Promise<MenuItem | undefined> {
    return this.store.getItem(pos_config_id, product_tmpl_id);
  }

  getItems(pos_config_id: PosConfigId, product_tmpl_ids: ProductTmplId[]): Promise<MenuItem[]> {
    return this.store.getItems(pos_config_id, product_tmpl_ids);
  }
}

/** Rank → coarse tier. Unsold/unranked items get no tier rather than a bottom one. */
function tierOf(rank: number | undefined): PopularityTier | undefined {
  if (rank === undefined) return undefined;
  if (rank <= POPULARITY.topRank) return 'top';
  if (rank <= POPULARITY.popularRank) return 'popular';
  return undefined;
}
