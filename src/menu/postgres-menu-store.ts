import type pg from 'pg';
import { config } from '../config/env.js';
import type { PosConfigId, ProductTmplId } from '../shared/types.js';
import type { CandidateModifier, MenuItem } from './menu-types.js';
import type { MenuStore } from './menu-store.js';
import { logger } from '../config/logger.js';
import { messageOf } from '../shared/errors.js';

/**
 * Over-fetch factor for KNN: an item explodes into one row per language name, so
 * fetching `k` rows would yield fewer than `k` DISTINCT items on a multilingual
 * menu. We fetch `k * this` rows per query and dedupe to `k` items.
 */
const KNN_ROW_OVERFETCH = 4;
/** Cap on lexical hits pulled per phrase set (reranking trims to the final N). */
const LEXICAL_LIMIT = 64;

/** Odoo translatable text: a jsonb `{ "en_US": "…", … }` (node-pg parses it to an object). */
type Translatable = Record<string, string> | null;

/** en_US-first, then any value, then the fallback. */
function firstName(t: Translatable, fallback = ''): string {
  if (!t) return fallback;
  return t.en_US ?? Object.values(t)[0] ?? fallback;
}

/** The full translatable map, falling back to `alt` when `t` is null/empty (mirrors `firstName`). */
function namesOf(t: Translatable, alt: Translatable): Record<string, string> {
  if (t && Object.keys(t).length > 0) return t;
  return alt ?? {};
}

/** Pack a vector into the pgvector text literal `[a,b,c]` (cast `::vector` in SQL). */
export function encodeVector(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * The lexical `ILIKE` patterns for a set of phrases: words stripped to
 * letters/digits (dropping query metacharacters), each wrapped as `%word%`.
 * Empty when no usable word remains (caller then does no lexical search).
 */
export function lexicalTerms(phrases: string[]): string[] {
  const terms = new Set<string>();
  for (const phrase of phrases) {
    for (const word of phrase.split(/\s+/)) {
      const t = word.replace(/[^\p{L}\p{N}]/gu, '');
      if (t.length >= 2) terms.add(`%${t}%`);
    }
  }
  return [...terms];
}

interface ItemRow {
  product_tmpl_id: number;
  menu_item_key: string;
  names: Translatable;
  list_price: string | null; // numeric → string in node-pg
  available: boolean;
}

interface ModifierRow {
  product_tmpl_id: number;
  ptav_id: number;
  price_extra: string | null; // numeric → string in node-pg
  names: Translatable;
  attr_name: Translatable;
}

/**
 * Postgres/pgvector-backed store (design §7/§13). Our `item_vector` table lives in
 * the Odoo DB and carries the per-restaurant membership + `menu_item_key` + one
 * embedding row per (item, language); Odoo's own tables (`product_template`,
 * `product_template_attribute_value`, …) supply live names / price / availability /
 * modifiers via JOIN at read time. Holds no state between calls.
 *
 * Requires the pgvector extension (`CREATE EXTENSION vector`). On a plain Postgres
 * the KNN query errors and the matcher falls back to a fuzzy scan.
 */
export class PostgresMenuStore implements MenuStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly dims: number = config.embeddingDimensions,
  ) {}

  /**
   * Create the pgvector extension, the `item_vector` table, and its indexes if
   * absent (idempotent). No-op when `dims <= 0` (the stub embedder emits no
   * vectors, so there is nothing to store or index).
   */
  async ensureIndex(): Promise<void> {
    if (this.dims <= 0) return;
    await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS item_vector (
        id              bigserial PRIMARY KEY,
        pos_config_id   integer NOT NULL,
        product_tmpl_id integer NOT NULL,
        menu_item_key   text    NOT NULL,
        lang            text    NOT NULL,
        name            text    NOT NULL,
        vector          vector(${this.dims})
      )`);
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS item_vector_pos_tmpl_idx ON item_vector (pos_config_id, product_tmpl_id)',
    );
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS item_vector_vec_idx ON item_vector USING hnsw (vector vector_cosine_ops)',
    );
  }

  async knnSearch(
    pos: PosConfigId,
    queryVectors: number[][],
    k: number,
  ): Promise<Map<ProductTmplId, number>> {
    // One KNN per phrase, run concurrently (an error/missing extension degrades to
    // an empty result → the matcher falls back to a fuzzy scan rather than throwing).
    const limit = k * KNN_ROW_OVERFETCH;
    const results = await Promise.all(
      queryVectors.filter((qv) => qv.length > 0).map((qv) => this.knnOne(pos, qv, limit)),
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

  /** One phrase's KNN → its hits as (tmpl, similarity). [] on any query error. */
  private async knnOne(
    pos: PosConfigId,
    qv: number[],
    limit: number,
  ): Promise<Array<{ tmpl: ProductTmplId; sim: number }>> {
    try {
      // pgvector `<=>` is cosine DISTANCE in [0, 2]; similarity = 1 - distance,
      // clamped to [0, 1].
      const { rows } = await this.pool.query<{ product_tmpl_id: number; sim: string }>(
        `SELECT product_tmpl_id, 1 - (vector <=> $1::vector) AS sim
           FROM item_vector
          WHERE pos_config_id = $2
          ORDER BY vector <=> $1::vector
          LIMIT $3`,
        [encodeVector(qv), pos, limit],
      );
      return rows.map((r) => ({ tmpl: r.product_tmpl_id, sim: Math.max(0, Math.min(1, Number(r.sim))) }));
    } catch (err) {
      logger.warn('menu.knn_unavailable', { message: messageOf(err) });
      return [];
    }
  }

  async lexicalSearch(pos: PosConfigId, phrases: string[]): Promise<Set<ProductTmplId>> {
    const terms = lexicalTerms(phrases);
    if (terms.length === 0) return new Set();
    try {
      const { rows } = await this.pool.query<{ product_tmpl_id: number }>(
        `SELECT DISTINCT product_tmpl_id
           FROM item_vector
          WHERE pos_config_id = $1 AND name ILIKE ANY($2::text[])
          LIMIT $3`,
        [pos, terms, LEXICAL_LIMIT],
      );
      return new Set(rows.map((r) => r.product_tmpl_id));
    } catch (err) {
      logger.warn('menu.lexical_unavailable', { message: messageOf(err) });
      return new Set();
    }
  }

  getItems(pos: PosConfigId, tmpls: ProductTmplId[]): Promise<MenuItem[]> {
    if (tmpls.length === 0) return Promise.resolve([]);
    return this.hydrate(pos, tmpls);
  }

  allItems(pos: PosConfigId): Promise<MenuItem[]> {
    return this.hydrate(pos, null);
  }

  async getItem(pos: PosConfigId, tmpl: ProductTmplId): Promise<MenuItem | undefined> {
    return (await this.hydrate(pos, [tmpl]))[0];
  }

  async getItemByKey(pos: PosConfigId, menu_item_key: string): Promise<MenuItem | undefined> {
    const { rows } = await this.pool.query<{ product_tmpl_id: number }>(
      'SELECT product_tmpl_id FROM item_vector WHERE pos_config_id = $1 AND menu_item_key = $2 LIMIT 1',
      [pos, menu_item_key],
    );
    const id = rows[0]?.product_tmpl_id;
    return id === undefined ? undefined : this.getItem(pos, id);
  }

  /**
   * Hydrate items from `item_vector` (menu_item_key, membership) joined to Odoo's
   * `product_template` (names/price/availability), attaching modifiers from
   * `product_template_attribute_value`. `tmpls === null` hydrates every item for
   * the restaurant (the fuzzy-fallback corpus). Availability is returned, not
   * filtered — the matcher re-checks it.
   */
  private async hydrate(pos: PosConfigId, tmpls: ProductTmplId[] | null): Promise<MenuItem[]> {
    const filter = tmpls === null ? '' : ' AND iv.product_tmpl_id = ANY($2::int[])';
    const params: unknown[] = tmpls === null ? [pos] : [pos, tmpls];
    const { rows: itemRows } = await this.pool.query<ItemRow>(
      `SELECT DISTINCT ON (iv.product_tmpl_id)
              iv.product_tmpl_id,
              iv.menu_item_key,
              pt.name AS names,
              pt.list_price,
              (COALESCE(pt.available_in_pos, false) AND COALESCE(pt.active, false)) AS available
         FROM item_vector iv
         JOIN product_template pt ON pt.id = iv.product_tmpl_id
        WHERE iv.pos_config_id = $1${filter}
        ORDER BY iv.product_tmpl_id`,
      params,
    );
    if (itemRows.length === 0) return [];

    const ids = itemRows.map((r) => r.product_tmpl_id);
    const { rows: modRows } = await this.pool.query<ModifierRow>(
      `SELECT ptav.product_tmpl_id,
              ptav.id AS ptav_id,
              ptav.price_extra,
              pav.name AS names,
              pa.name  AS attr_name
         FROM product_template_attribute_value ptav
         JOIN product_attribute_value pav ON pav.id = ptav.product_attribute_value_id
         JOIN product_attribute pa       ON pa.id  = ptav.attribute_id
        WHERE ptav.product_tmpl_id = ANY($1::int[])
          AND COALESCE(ptav.ptav_active, true)
        ORDER BY ptav.product_tmpl_id, ptav.id`,
      [ids],
    );

    const modsByTmpl = new Map<number, CandidateModifier[]>();
    for (const m of modRows) {
      const list = modsByTmpl.get(m.product_tmpl_id) ?? [];
      list.push({
        modifier_key: String(m.ptav_id),
        ptav_id: m.ptav_id,
        price_extra_cents: Math.round(Number(m.price_extra ?? 0) * 100),
        name: firstName(m.names, firstName(m.attr_name)),
        // Full translatable map for the client; falls back to the attribute's names
        // when the value itself has none (mirrors the `name` fallback chain).
        names: namesOf(m.names, m.attr_name),
      });
      modsByTmpl.set(m.product_tmpl_id, list);
    }

    return itemRows.map((r) => ({
      product_tmpl_id: r.product_tmpl_id,
      menu_item_key: r.menu_item_key,
      names: r.names ?? {},
      base_price_cents: Math.round(Number(r.list_price ?? 0) * 100),
      available: r.available,
      modifiers: modsByTmpl.get(r.product_tmpl_id) ?? [],
    }));
  }
}
