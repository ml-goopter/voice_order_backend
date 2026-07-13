import type { PosConfigId, ProductTmplId } from '../shared/types.js';
import type { MenuItem } from './menu-types.js';

/**
 * The query surface the matcher and cart lookups run against. Backed by
 * Postgres/pgvector in production (`PostgresMenuStore`); an in-memory
 * implementation drives the tests. Every call hits the store at request time —
 * there is no long-lived menu cache.
 */
export interface MenuStore {
  /** Create the vector index if absent (idempotent). */
  ensureIndex(): Promise<void>;
  /**
   * KNN over the vector index. Returns up to `k` distinct candidate
   * `product_tmpl_id`s, each with its BEST cosine similarity in [0, 1] across the
   * supplied query vectors. Availability is NOT filtered here (the caller re-checks
   * it against the live item). Empty when the index is missing or every search fails.
   */
  knnSearch(pos: PosConfigId, queryVectors: number[][], k: number): Promise<Map<ProductTmplId, number>>;
  /**
   * Lexical retrieval over the indexed `name` text: the `product_tmpl_id`s whose
   * names match the phrases (fuzzy/token). Complements KNN so lexically-close items
   * the vector recall misses are still retrieved. Empty when the index is missing.
   */
  lexicalSearch(pos: PosConfigId, phrases: string[]): Promise<Set<ProductTmplId>>;
  /** Hydrate specific items by `product_tmpl_id` (skips missing ids). */
  getItems(pos: PosConfigId, tmpls: ProductTmplId[]): Promise<MenuItem[]>;
  /** Every seeded item for a restaurant (the fuzzy-fallback corpus). */
  allItems(pos: PosConfigId): Promise<MenuItem[]>;
  getItem(pos: PosConfigId, tmpl: ProductTmplId): Promise<MenuItem | undefined>;
  getItemByKey(pos: PosConfigId, menu_item_key: string): Promise<MenuItem | undefined>;
}
