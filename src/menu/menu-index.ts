import type { Redis } from 'ioredis';
import type { PosConfigId, ProductTmplId } from '../shared/types.js';

/**
 * RediSearch hybrid index over menu names (design §7/§13). The item JSON blobs
 * (`menu:item:{pos}:{id}`) stay the source of truth; this index is a *derived*
 * layer projected from them by `scripts/index-redis-menu.ts`.
 *
 * KNN needs one vector per indexed document, but an item carries a multi-vector
 * array (one name per language) — RediSearch can't KNN over a multi-value vector
 * field — so each (item, language) name is exploded into its own HASH doc:
 *   menu:vec:{pos}:{tmpl}:{i}  HASH { pos, tmpl, name(TEXT), vector(FLOAT32 blob) }
 * A single index spans all restaurants; `pos` is a TAG filter at query time. The
 * `name` TEXT field powers a lexical fallback that reranks alongside KNN (so
 * lexically-close items the vector recall misses are still retrieved). Availability
 * is NOT indexed — it is a mutable operational fact filtered at read time from the
 * source blob, so re-enabling an item takes effect without a reindex.
 *
 * Requires the RediSearch module (Redis Stack / Redis 8). On plain Redis the
 * FT.* commands error and the matcher falls back to a fuzzy scan.
 */
export const MENU_VEC_INDEX = 'idx:menuvec';
export const VEC_PREFIX = 'menu:vec:';
/** Records the schema version + vector width the live index was built with. */
const INDEX_META_KEY = 'menu:index:meta';
/** Bump whenever the FT.CREATE SCHEMA below changes, to force a rebuild on ensure. */
const SCHEMA_VERSION = 2;

export const vecKey = (pos: PosConfigId, tmpl: ProductTmplId, i: number): string =>
  `${VEC_PREFIX}${pos}:${tmpl}:${i}`;
export const keyIndexKey = (pos: PosConfigId, menu_item_key: string): string =>
  `menu:key:${pos}:${menu_item_key}`;

/** Pack a vector into the little-endian FLOAT32 blob RediSearch expects. */
export function encodeVector(vector: number[]): Buffer {
  const buf = Buffer.allocUnsafe(vector.length * 4);
  for (let i = 0; i < vector.length; i++) buf.writeFloatLE(vector[i] ?? 0, i * 4);
  return buf;
}

async function createIndex(redis: Redis, dims: number): Promise<void> {
  await redis.call(
    'FT.CREATE',
    MENU_VEC_INDEX,
    'ON',
    'HASH',
    'PREFIX',
    '1',
    VEC_PREFIX,
    'SCHEMA',
    'pos',
    'TAG',
    'tmpl',
    'NUMERIC',
    'name',
    'TEXT',
    'vector',
    'VECTOR',
    'FLAT',
    '6',
    'TYPE',
    'FLOAT32',
    'DIM',
    String(dims),
    'DISTANCE_METRIC',
    'COSINE',
  );
}

/** Drop the index definition (keeps the underlying HASH docs). No-op if absent. */
export async function dropMenuIndex(redis: Redis): Promise<void> {
  try {
    await redis.call('FT.DROPINDEX', MENU_VEC_INDEX);
  } catch (err) {
    if (!/unknown index name|no such index/i.test((err as Error).message)) throw err;
  }
}

/**
 * Ensure the index exists AND matches the current schema/vector width, rebuilding
 * it when either drifts (e.g. `EMBEDDING_DIMENSIONS` changed, or the SCHEMA above
 * was revised). A signature key records what the live index was built with, so an
 * up-to-date index is a cheap no-op and a stale one is dropped + recreated (the
 * HASH docs survive and RediSearch re-indexes them). No-op when `dims <= 0` (the
 * stub embedder emits no vectors, so there is nothing to index).
 */
export async function ensureMenuIndex(redis: Redis, dims: number): Promise<void> {
  if (dims <= 0) return;
  const want = `v${SCHEMA_VERSION}:${dims}`;
  if ((await redis.get(INDEX_META_KEY)) === want) return;
  // Stale dim/schema (or a leftover from older code) → rebuild fresh.
  await dropMenuIndex(redis);
  try {
    await createIndex(redis, dims);
  } catch (err) {
    // A concurrent creator won the race — accept the existing index.
    if (!(err as Error).message.includes('Index already exists')) throw err;
  }
  await redis.set(INDEX_META_KEY, want);
}
