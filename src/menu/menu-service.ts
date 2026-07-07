import type { PosConfigId, ProductTmplId } from '../shared/types.js';
import { MenuCache } from './menu-cache.js';
import { CandidateMatcher } from './candidate-matcher.js';
import { StubEmbeddingService } from './embedding-service.js';
import type { EmbeddingService } from './embedding-service.js';
import type { CandidateSet, MenuItem } from './menu-types.js';

/** Facade over the menu cache + candidate matcher (design §7). */
export class MenuService {
  readonly cache: MenuCache;
  private readonly matcher: CandidateMatcher;

  constructor(embedder: EmbeddingService = new StubEmbeddingService()) {
    this.cache = new MenuCache(embedder);
    this.matcher = new CandidateMatcher(this.cache, embedder);
  }

  loadMenu(pos_config_id: PosConfigId, items: MenuItem[]): Promise<void> {
    return this.cache.load(pos_config_id, items);
  }

  getCandidates(pos_config_id: PosConfigId, transcript: string): Promise<CandidateSet> {
    return this.matcher.match(pos_config_id, transcript);
  }

  /** Resolve an LLM menu_item_key back to its Odoo product_tmpl_id (design §8). */
  resolveItemKey(pos_config_id: PosConfigId, menu_item_key: string): MenuItem | undefined {
    return this.cache.findByKey(pos_config_id, menu_item_key);
  }

  findByTmplId(pos_config_id: PosConfigId, product_tmpl_id: ProductTmplId): MenuItem | undefined {
    return this.cache.findByTmplId(pos_config_id, product_tmpl_id);
  }
}
