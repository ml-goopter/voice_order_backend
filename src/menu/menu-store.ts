import type { Redis } from 'ioredis';
import { config } from '../config/env.js';
import type { PosConfigId, ProductTmplId } from '../shared/types.js';
import type { CandidateModifier, MenuItem, MenuVector } from './menu-types.js';
import { MENU_VEC_INDEX, encodeVector, ensureMenuIndex, keyIndexKey } from './menu-index.js';
import { logger } from '../config/logger.js';
import { messageOf } from '../shared/errors.js';

/**
 * Over-fetch factor for KNN: each item explodes into one HASH doc per language
 * name, so fetching `k` docs would yield far fewer than `k` DISTINCT items on a
 * multilingual menu. We fetch `k * this` docs per query and dedupe to `k` items.
 */
const KNN_DOC_OVERFETCH = 4;
/** Cap on lexical hits pulled per phrase set (reranking trims to the final N). */
const LEXICAL_LIMIT = 64;

/**
 * The JSON blob `scripts/populate-redis-menu.ts` writes to `menu:item:{pos}:{id}`.
 * Richer than the runtime `MenuItem`; we read only the fields the matcher needs,
 * plus the precomputed `vectors` (added at seed/embed time).
 */
interface StoredModifier {
  ptav_id: number;
  modifier_key: string;
  attribute: string;
  names: Record<string, string>;
  price_extra_cents: number;
}

export interface StoredMenuItem {
  product_tmpl_id: number;
  menu_item_key: string;
  names: Record<string, string>;
  base_price_cents: number;
  available: boolean;
  modifiers?: StoredModifier[];
  vectors?: MenuVector[];
}

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
 * The query surface the matcher and cart lookups run against. Backed by Redis in
 * production (`RedisMenuStore`); an in-memory implementation drives the tests.
 * Every call hits the store at request time — there is no long-lived menu cache.
 */
export interface MenuStore {
  /** Create the RediSearch vector index if absent (idempotent). */
  ensureIndex(): Promise<void>;
  /**
   * KNN over the vector index. Returns up to `k` distinct candidate
   * `product_tmpl_id`s, each with its BEST cosine similarity in [0, 1] across the
   * supplied query vectors. Availability is NOT filtered here (the caller re-checks
   * it against the live blob). Empty when the index is missing or every search fails.
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

const parse = (raw: string | null): MenuItem | undefined => {
  if (raw === null) return undefined;
  try {
    return toMenuItem(JSON.parse(raw) as StoredMenuItem);
  } catch {
    return undefined;
  }
};

/**
 * A RediSearch TEXT query over the `name` field for the phrase words, scoped to
 * `pos`. Words are stripped to letters/digits (dropping query metacharacters), and
 * words ≥ 4 chars get a Levenshtein-1 fuzzy term (`%word%`) to tolerate ASR slips.
 * Returns null when no usable term remains (caller then does no lexical search).
 */
export function lexicalQuery(pos: PosConfigId, phrases: string[]): string | null {
  const terms = new Set<string>();
  for (const phrase of phrases) {
    for (const word of phrase.split(/\s+/)) {
      const t = word.replace(/[^\p{L}\p{N}]/gu, '');
      if (t.length >= 2) terms.add(t.length >= 4 ? `%${t}%` : t);
    }
  }
  if (terms.size === 0) return null;
  return `@pos:{${pos}} @name:(${[...terms].join(' | ')})`;
}

/**
 * Redis-backed store (design §7/§13). Reads item blobs written by the seed scripts
 * and runs KNN against the `idx:menuvec` RediSearch index (built by
 * `scripts/index-redis-menu.ts`). Holds no state between calls.
 */
export class RedisMenuStore implements MenuStore {
  constructor(
    private readonly redis: Redis,
    private readonly dims: number = config.embeddingDimensions,
  ) { }

  ensureIndex(): Promise<void> {
    return ensureMenuIndex(this.redis, this.dims);
  }

  async knnSearch(
    pos: PosConfigId,
    queryVectors: number[][],
    k: number,
  ): Promise<Map<ProductTmplId, number>> {
    // One KNN per phrase, run concurrently (a failed/missing index degrades to an
    // empty result → the matcher falls back to a fuzzy scan rather than throwing).
    const perDoc = k * KNN_DOC_OVERFETCH;
    const results = await Promise.all(
      queryVectors.filter((qv) => qv.length > 0).map((qv) => this.knnOne(pos, qv, perDoc)),
    );

    // Best cosine per DISTINCT item across all phrases, then keep the k nearest.
    const best = new Map<ProductTmplId, number>();
    for (const hits of results) {
      for (const { tmpl, sim } of hits) {
        const prev = best.get(tmpl);
        if (prev === undefined || sim > prev) best.set(tmpl, sim);
      }
    }
    if (best.size <= k) return best;
    return new Map([...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, k));
  }

  /** One phrase's KNN → its hits as (tmpl, similarity). [] on any FT error. */
  private async knnOne(
    pos: PosConfigId,
    qv: number[],
    limit: number,
  ): Promise<Array<{ tmpl: ProductTmplId; sim: number }>> {
    let reply: unknown[];
    try {
      // COSINE distance is in [0, 2]; similarity = 1 - distance, clamped to [0, 1].
      reply = (await this.redis.call(
        'FT.SEARCH',
        MENU_VEC_INDEX,
        `(@pos:{${pos}})=>[KNN ${limit} @vector $BLOB AS vec_score]`,
        'PARAMS',
        '2',
        'BLOB',
        encodeVector(qv),
        'SORTBY',
        'vec_score',
        'RETURN',
        '2',
        'tmpl',
        'vec_score',
        'DIALECT',
        '2',
        'LIMIT',
        '0',
        String(limit),
      )) as unknown[];
    } catch (err) {
      logger.warn('menu.knn_unavailable', { message: messageOf(err) });
      return [];
    }

    // Reply shape: [total, docId, [field, val, ...], docId, [...], ...].
    const hits: Array<{ tmpl: ProductTmplId; sim: number }> = [];
    for (let i = 1; i + 1 < reply.length; i += 2) {
      const fields = reply[i + 1] as string[];
      let tmpl = Number.NaN;
      let dist = Number.NaN;
      for (let j = 0; j + 1 < fields.length; j += 2) {
        if (fields[j] === 'tmpl') tmpl = Number(fields[j + 1]);
        else if (fields[j] === 'vec_score') dist = Number(fields[j + 1]);
      }
      if (Number.isNaN(tmpl) || Number.isNaN(dist)) continue;
      hits.push({ tmpl, sim: Math.max(0, 1 - dist) });
    }
    return hits;
  }

  async lexicalSearch(pos: PosConfigId, phrases: string[]): Promise<Set<ProductTmplId>> {
    const query = lexicalQuery(pos, phrases);
    if (query === null) return new Set();
    let reply: unknown[];
    try {
      reply = (await this.redis.call(
        'FT.SEARCH',
        MENU_VEC_INDEX,
        query,
        'RETURN',
        '1',
        'tmpl',
        'DIALECT',
        '2',
        'LIMIT',
        '0',
        String(LEXICAL_LIMIT),
      )) as unknown[];
    } catch (err) {
      logger.warn('menu.lexical_unavailable', { message: messageOf(err) });
      return new Set();
    }

    const ids = new Set<ProductTmplId>();
    for (let i = 1; i + 1 < reply.length; i += 2) {
      const fields = reply[i + 1] as string[];
      for (let j = 0; j + 1 < fields.length; j += 2) {
        if (fields[j] === 'tmpl') {
          const t = Number(fields[j + 1]);
          if (!Number.isNaN(t)) ids.add(t);
        }
      }
    }
    return ids;
  }

  async getItems(pos: PosConfigId, tmpls: ProductTmplId[]): Promise<MenuItem[]> {
    if (tmpls.length === 0) return [];
    const raws = await this.redis.mget(tmpls.map((t) => itemKey(pos, t)));
    return raws.map(parse).filter((i): i is MenuItem => i !== undefined);
  }

  async allItems(pos: PosConfigId): Promise<MenuItem[]> {
    const ids = await this.redis.smembers(itemsSetKey(pos));
    return this.getItems(pos, ids.map(Number));
  }

  getItem(pos: PosConfigId, tmpl: ProductTmplId): Promise<MenuItem | undefined> {
    return this.redis.get(itemKey(pos, tmpl)).then(parse);
  }

  async getItemByKey(pos: PosConfigId, menu_item_key: string): Promise<MenuItem | undefined> {
    // Fast path: the `menu:key:*` secondary index (written by index-redis-menu.ts).
    const id = await this.redis.get(keyIndexKey(pos, menu_item_key));
    if (id !== null) return this.getItem(pos, Number(id));
    // Fallback (index not built yet): scan items so cart ops still resolve keys.
    return (await this.allItems(pos)).find((i) => i.menu_item_key === menu_item_key);
  }
}
