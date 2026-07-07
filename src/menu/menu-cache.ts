import type { PosConfigId, ProductTmplId } from '../shared/types.js';
import type { MenuItem } from './menu-types.js';

/**
 * In-memory menu, loaded from Odoo (product_template + attributes). Fine below
 * ~2,000 items (design §7); move to Postgres + pgvector beyond that.
 * TODO: populate from menu-repository (reads the Odoo POS tables).
 */
export class MenuCache {
  private readonly byPos = new Map<PosConfigId, MenuItem[]>();

  load(pos_config_id: PosConfigId, items: MenuItem[]): void {
    this.byPos.set(pos_config_id, items);
  }

  items(pos_config_id: PosConfigId): MenuItem[] {
    return this.byPos.get(pos_config_id) ?? [];
  }

  findByKey(pos_config_id: PosConfigId, menu_item_key: string): MenuItem | undefined {
    return this.items(pos_config_id).find((i) => i.menu_item_key === menu_item_key);
  }

  findByTmplId(pos_config_id: PosConfigId, product_tmpl_id: ProductTmplId): MenuItem | undefined {
    return this.items(pos_config_id).find((i) => i.product_tmpl_id === product_tmpl_id);
  }
}
