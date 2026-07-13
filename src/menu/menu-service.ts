import type { PosConfigId, ProductTmplId } from '../shared/types.js';
import { CandidateMatcher } from './candidate-matcher.js';
import type { MenuStore } from './menu-store.js';
import { createEmbeddingService } from './embedding-service.js';
import type { EmbeddingService } from './embedding-service.js';
import type { CandidateSet, MenuItem } from './menu-types.js';

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

  getCandidates(pos_config_id: PosConfigId, transcript: string): Promise<CandidateSet> {
    return this.matcher.match(pos_config_id, transcript);
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
