/**
 * Build the RediSearch KNN index from an ALREADY-SEEDED Redis menu.
 *
 * Purely ADDITIVE and derived: it reads each existing `menu:item:{pos}:{id}`
 * record (which already carries per-language name `vectors` written by
 * `populate-redis-menu.ts` / `embed-redis-menu.ts`) and projects two derived
 * layers — it NEVER touches the source blobs, item sets, or meta:
 *
 *   menu:vec:{pos}:{tmpl}:{i}   HASH { pos, tmpl, name, vector }       — KNN + lexical docs
 *   menu:key:{pos}:{menu_item_key} -> tmpl                             — O(1) resolve
 *   idx:menuvec                 RediSearch vector + TEXT index
 *
 * KNN needs one vector per document, so each language name becomes its own doc;
 * the `name` field also powers a lexical fallback. Availability is NOT indexed — it
 * is filtered at read time from the source blob, so re-enabling an item needs no
 * reindex. Vectors whose width ≠ EMBEDDING_DIMENSIONS are skipped (RediSearch would
 * refuse to index them), leaving the item to the lexical/fuzzy path.
 *
 * Re-runnable: it deletes only the derived `menu:vec:*` / `menu:key:*` keys for a
 * pos before rewriting them (so a shrunk vector count leaves no orphans), and
 * `ensureMenuIndex` rebuilds the index if the dimension or schema changed.
 *
 * Requires the RediSearch module (Redis Stack / Redis 8) and real vectors in the
 * blobs (run `embed:menu` first if they are missing).
 *
 * Env:
 *   REDIS_URL             redis://localhost:6379
 *   EMBEDDING_DIMENSIONS  index vector width (default 1024; must match the blobs)
 *
 * Run:  npm run index:menu
 */
import { Redis } from 'ioredis';
import { config } from '../src/config/env.js';
import { encodeVector, ensureMenuIndex, keyIndexKey, vecKey } from '../src/menu/menu-index.js';

const META_PREFIX = 'menu:meta:';

interface StoredVector {
  text: string;
  vector: number[];
}
interface MenuItemRecord {
  product_tmpl_id: number;
  menu_item_key: string;
  available: boolean;
  vectors?: StoredVector[];
}

/** pos_config_ids that have a `menu:meta:{pos}` record. */
async function listPosIds(redis: Redis): Promise<number[]> {
  const ids: number[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${META_PREFIX}*`, 'COUNT', 100);
    cursor = next;
    for (const k of keys) {
      const n = Number.parseInt(k.slice(META_PREFIX.length), 10);
      if (!Number.isNaN(n)) ids.push(n);
    }
  } while (cursor !== '0');
  return ids;
}

/** DEL every key matching a pattern (batched SCAN). Only ever the derived keys. */
async function delByPattern(redis: Redis, pattern: string): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}

async function indexPos(redis: Redis, pos: number): Promise<void> {
  const ids = await redis.smembers(`menu:items:${pos}`);
  if (ids.length === 0) {
    console.warn(`pos ${pos}: empty item set — skipped`);
    return;
  }

  // Clear stale derived keys for this pos before rewriting (source untouched).
  await delByPattern(redis, `menu:vec:${pos}:*`);
  await delByPattern(redis, `menu:key:${pos}:*`);

  const raws = await redis.mget(ids.map((id) => `menu:item:${pos}:${id}`));
  const pipeline = redis.pipeline();
  let vecDocs = 0;
  let itemsWithVectors = 0;
  let dimMismatch = 0;

  for (const raw of raws) {
    if (raw === null) continue;
    let rec: MenuItemRecord;
    try {
      rec = JSON.parse(raw) as MenuItemRecord;
    } catch {
      continue;
    }
    pipeline.set(keyIndexKey(pos, rec.menu_item_key), String(rec.product_tmpl_id));

    const vectors = (rec.vectors ?? []).filter((v) => v.vector.length > 0);
    if (vectors.length > 0) itemsWithVectors++;
    vectors.forEach((v, i) => {
      // A wrong-width vector cannot be indexed by RediSearch — skip it (only the
      // key lookup above is written for this item) rather than write a dead doc.
      if (v.vector.length !== config.embeddingDimensions) {
        dimMismatch++;
        return;
      }
      pipeline.hset(vecKey(pos, rec.product_tmpl_id, i), {
        pos: String(pos),
        tmpl: String(rec.product_tmpl_id),
        name: v.text,
        vector: encodeVector(v.vector),
      });
      vecDocs++;
    });
  }

  await pipeline.exec();
  console.log(
    `pos ${pos}: indexed ${vecDocs} vectors from ${itemsWithVectors} items` +
      (dimMismatch > 0 ? ` (WARNING: skipped ${dimMismatch} vectors ≠ ${config.embeddingDimensions} dims — re-run embed:menu)` : ''),
  );
}

async function main(): Promise<void> {
  if (config.embeddingDimensions <= 0) {
    console.error('EMBEDDING_DIMENSIONS must be > 0 to build a vector index.');
    process.exit(1);
  }
  const redis = new Redis(config.redisUrl);
  try {
    await ensureMenuIndex(redis, config.embeddingDimensions);
    const posIds = await listPosIds(redis);
    if (posIds.length === 0) {
      console.warn('No menu:meta:* keys found — nothing to index. Seed the menu first.');
      return;
    }
    console.log(`Indexing menus for pos_config_ids: ${posIds.join(', ')} (${config.embeddingDimensions} dims)`);
    for (const pos of posIds) await indexPos(redis, pos);
    console.log('Done. Vector index idx:menuvec is ready for KNN search.');
  } finally {
    redis.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
