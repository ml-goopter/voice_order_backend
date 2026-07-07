import type { Redis } from 'ioredis';
import { logger } from '../config/logger.js';
import { config } from '../config/env.js';
import type { PosConfigId } from '../shared/types.js';
import type { IndexedMenuItem } from './menu-cache.js';
import type { CandidateModifier, MenuItem, MenuVector } from './menu-types.js';

/**
 * The JSON blob `scripts/populate-redis-menu.ts` writes to `menu:item:{pos}:{id}`.
 * Richer than the runtime `MenuItem`; we read only the fields the matcher needs,
 * plus the precomputed `vectors` (added at seed time).
 */
interface StoredModifier {
  ptav_id: number;
  modifier_key: string;
  attribute: string;
  names: Record<string, string>;
  price_extra_cents: number;
}

interface StoredMenuItem {
  product_tmpl_id: number;
  menu_item_key: string;
  names: Record<string, string>;
  base_price_cents: number;
  available: boolean;
  modifiers?: StoredModifier[];
  vectors?: MenuVector[];
}

const META_PREFIX = 'menu:meta:';

const itemsSetKey = (pos: PosConfigId): string => `menu:items:${pos}`;
const itemKey = (pos: PosConfigId, id: number): string => `menu:item:${pos}:${id}`;

/** A modifier record → the single-`name` shape the matcher/LLM consume (en_US first). */
export function toCandidateModifier(m: StoredModifier): CandidateModifier {
  return {
    modifier_key: m.modifier_key,
    ptav_id: m.ptav_id,
    name: m.names?.en_US ?? Object.values(m.names ?? {})[0] ?? m.attribute,
  };
}

/** A stored menu record → the runtime `MenuItem`. */
export function toMenuItem(record: StoredMenuItem): MenuItem {
  return {
    product_tmpl_id: record.product_tmpl_id,
    menu_item_key: record.menu_item_key,
    names: record.names,
    base_price_cents: record.base_price_cents,
    available: record.available,
    modifiers: (record.modifiers ?? []).map(toCandidateModifier),
  };
}

/**
 * Reads seeded menu items and their precomputed name vectors from Redis so the
 * matcher runs without re-embedding at boot (design §7). Written by
 * `scripts/populate-redis-menu.ts`.
 */
export class RedisMenuRepository {
  constructor(private readonly redis: Redis) {}

  /** pos_config_ids that have a `menu:meta:{pos}` record (i.e. a seeded menu). */
  async listPosConfigIds(): Promise<PosConfigId[]> {
    const ids: PosConfigId[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${META_PREFIX}*`, 'COUNT', 100);
      cursor = next;
      for (const k of keys) {
        const n = Number.parseInt(k.slice(META_PREFIX.length), 10);
        if (!Number.isNaN(n)) ids.push(n);
      }
    } while (cursor !== '0');
    return ids;
  }

  /** Load one restaurant's menu (+ vectors) into `IndexedMenuItem`s. */
  async load(pos_config_id: PosConfigId): Promise<IndexedMenuItem[]> {
    const ids = await this.redis.smembers(itemsSetKey(pos_config_id));
    if (ids.length === 0) {
      logger.warn('menu.empty', { pos_config_id });
      return [];
    }

    const raws = await this.redis.mget(ids.map((id: string) => itemKey(pos_config_id, Number(id))));
    const indexed: IndexedMenuItem[] = [];
    let dimMismatch = 0;

    for (const raw of raws) {
      if (raw === null) continue;
      let record: StoredMenuItem;
      try {
        record = JSON.parse(raw) as StoredMenuItem;
      } catch (err) {
        logger.error('menu.parse_failed', { pos_config_id, message: (err as Error).message });
        continue;
      }
      const vectors = (record.vectors ?? []).filter((v) => v.vector.length > 0);
      for (const v of vectors) {
        if (config.embeddingDimensions > 0 && v.vector.length !== config.embeddingDimensions) {
          dimMismatch++;
        }
      }
      indexed.push({ item: toMenuItem(record), vectors });
    }

    logger.info('menu.loaded', {
      pos_config_id,
      items: indexed.length,
      with_vectors: indexed.filter((i) => i.vectors.length > 0).length,
    });
    if (dimMismatch > 0) {
      logger.warn('menu.vector_dim_mismatch', {
        pos_config_id,
        count: dimMismatch,
        expected: config.embeddingDimensions,
      });
    }
    return indexed;
  }
}
