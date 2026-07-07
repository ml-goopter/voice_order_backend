import type { PosConfigId, ProductTmplId } from '../shared/types.js';
import type { MenuItem, MenuVector } from './menu-types.js';
import type { EmbeddingService } from './embedding-service.js';

/** A cached item with its precomputed name vectors (one per language). */
export interface IndexedMenuItem {
  item: MenuItem;
  vectors: MenuVector[];
}

/**
 * In-memory menu, loaded from Odoo (product_template + attributes). Fine below
 * ~2,000 items (design §7); a Redis vector cache is the scale-up path. Name
 * vectors are embedded once at load, not per query. With a stub embedder the
 * vectors are empty and the matcher degrades to fuzzy/modifier signals.
 * TODO: populate from menu-repository (reads the Odoo POS tables).
 */
export class MenuCache {
  private readonly byPos = new Map<PosConfigId, IndexedMenuItem[]>();

  constructor(private readonly embedder: EmbeddingService) {}

  async load(pos_config_id: PosConfigId, items: MenuItem[]): Promise<void> {
    const indexed = await Promise.all(
      items.map(async (item) => ({ item, vectors: await this.embedNames(item) })),
    );
    this.byPos.set(pos_config_id, indexed);
  }

  /**
   * Load items whose name vectors are already computed (e.g. read from Redis),
   * skipping the embedder entirely. This is the boot path when embeddings were
   * persisted at seed time.
   */
  loadIndexed(pos_config_id: PosConfigId, items: IndexedMenuItem[]): void {
    this.byPos.set(pos_config_id, items);
  }

  private async embedNames(item: MenuItem): Promise<MenuVector[]> {
    const texts = Object.values(item.names);
    // Menu names are the retrieval corpus → 'passage' (design §7 asymmetric).
    const vectors = await this.embedder.embedBatch(texts, 'passage');
    const out: MenuVector[] = [];
    for (let i = 0; i < texts.length; i++) {
      const vector = vectors[i] ?? [];
      if (vector.length > 0) out.push({ text: texts[i]!, vector });
    }
    return out;
  }

  indexed(pos_config_id: PosConfigId): IndexedMenuItem[] {
    return this.byPos.get(pos_config_id) ?? [];
  }

  items(pos_config_id: PosConfigId): MenuItem[] {
    return this.indexed(pos_config_id).map((i) => i.item);
  }

  findByKey(pos_config_id: PosConfigId, menu_item_key: string): MenuItem | undefined {
    return this.items(pos_config_id).find((i) => i.menu_item_key === menu_item_key);
  }

  findByTmplId(pos_config_id: PosConfigId, product_tmpl_id: ProductTmplId): MenuItem | undefined {
    return this.items(pos_config_id).find((i) => i.product_tmpl_id === product_tmpl_id);
  }
}
