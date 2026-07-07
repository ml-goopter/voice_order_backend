/**
 * Backfill name embeddings into an ALREADY-SEEDED Redis menu.
 *
 * Unlike `populate-redis-menu.ts` (which sources rows from Odoo Postgres), this
 * touches ONLY Redis: it reads each existing `menu:item:{pos}:{id}` record,
 * embeds its per-language names ('passage' role, mirroring `MenuCache.embedNames`),
 * writes the `vectors` back into the record, and stamps
 * `menu:meta:{pos}.embedding = { model, dimensions }`. Re-runnable (idempotent).
 *
 * Env:
 *   REDIS_URL           redis://localhost:6379
 *   EMBEDDING_PROVIDER  jina   (+ JINA_API_KEY)  — required; stub yields no vectors
 *   EMBEDDING_MODEL / EMBEDDING_DIMENSIONS       — as per src/config/env.ts
 *
 * Run:  EMBEDDING_PROVIDER=jina JINA_API_KEY=... npx tsx scripts/embed-redis-menu.ts
 */
import { Redis } from 'ioredis';
import { config } from '../src/config/env.js';
import { createEmbeddingService } from '../src/menu/embedding-service.js';
import type { EmbeddingService } from '../src/menu/embedding-service.js';

const META_PREFIX = 'menu:meta:';
const EMBED_BATCH = 100; // texts per embedding request

interface StoredVector {
  text: string;
  vector: number[];
}

/** The record shape written by populate-redis-menu.ts; we only touch `names`/`vectors`. */
interface MenuItemRecord {
  names: Record<string, string>;
  vectors?: StoredVector[];
  [key: string]: unknown;
}

/** pos_config_ids that have a `menu:meta:{pos}` record. */
export async function listPosIds(redis: Redis): Promise<number[]> {
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

/** Embed one pos's items in place: mutate each record's `vectors`, return #items with vectors. */
export async function embedPos(redis: Redis, pos: number, embedder: EmbeddingService): Promise<void> {
  const ids = await redis.smembers(`menu:items:${pos}`);
  if (ids.length === 0) {
    console.warn(`pos ${pos}: empty item set — skipped`);
    return;
  }
  const keys = ids.map((id: string) => `menu:item:${pos}:${id}`);
  const raws = await redis.mget(keys);

  // Parse records and gather the flat list of texts to embed (with per-record spans).
  const records: (MenuItemRecord | null)[] = [];
  const recordTexts: string[][] = [];
  const flatTexts: string[] = [];
  const spanStart: number[] = [];
  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i];
    if (raw == null) {
      records.push(null);
      recordTexts.push([]);
      spanStart.push(flatTexts.length);
      continue;
    }
    let rec: MenuItemRecord;
    try {
      rec = JSON.parse(raw) as MenuItemRecord;
    } catch {
      console.warn(`pos ${pos}: skip ${keys[i]} — invalid JSON`);
      records.push(null);
      recordTexts.push([]);
      spanStart.push(flatTexts.length);
      continue;
    }
    const texts = Object.values(rec.names ?? {}).filter((t): t is string => typeof t === 'string' && t.length > 0);
    spanStart.push(flatTexts.length);
    recordTexts.push(texts);
    flatTexts.push(...texts);
    records.push(rec);
  }

  // Embed all texts in chunks — one request per chunk (order preserved).
  const flatVectors: number[][] = new Array(flatTexts.length);
  for (let start = 0; start < flatTexts.length; start += EMBED_BATCH) {
    const chunk = flatTexts.slice(start, start + EMBED_BATCH);
    const embedded = await embedder.embedBatch(chunk, 'passage');
    for (let j = 0; j < chunk.length; j++) flatVectors[start + j] = embedded[j] ?? [];
    console.log(`pos ${pos}: embedded ${Math.min(start + chunk.length, flatTexts.length)}/${flatTexts.length} names`);
  }

  // Attach vectors back per record (drop empties) and write in one pipeline.
  const pipeline = redis.pipeline();
  let withVectors = 0;
  let liveRecords = 0;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) continue;
    liveRecords++;
    const texts = recordTexts[i]!;
    const start = spanStart[i]!;
    const vectors: StoredVector[] = [];
    for (let j = 0; j < texts.length; j++) {
      const vector = flatVectors[start + j] ?? [];
      if (vector.length > 0) vectors.push({ text: texts[j]!, vector });
    }
    rec.vectors = vectors;
    if (vectors.length > 0) withVectors++;
    pipeline.set(keys[i]!, JSON.stringify(rec));
  }

  // Stamp meta with the embedding model/dims used.
  const metaKey = `${META_PREFIX}${pos}`;
  const metaRaw = await redis.get(metaKey);
  const meta = metaRaw ? (JSON.parse(metaRaw) as Record<string, unknown>) : {};
  meta.embedding = { model: embedder.model, dimensions: embedder.dimensions };
  pipeline.set(metaKey, JSON.stringify(meta));

  await pipeline.exec();
  console.log(
    `pos ${pos}: wrote vectors for ${withVectors}/${liveRecords} items ` +
      `(${embedder.model}, ${embedder.dimensions} dims)`,
  );
}

async function main(): Promise<void> {
  const embedder = createEmbeddingService();
  if (embedder.dimensions === 0) {
    console.error(
      'EMBEDDING_PROVIDER yields no vectors (dimensions=0). ' +
        'Set EMBEDDING_PROVIDER=jina and JINA_API_KEY, then re-run.',
    );
    process.exit(1);
  }

  const redis = new Redis(config.redisUrl);
  try {
    const posIds = await listPosIds(redis);
    if (posIds.length === 0) {
      console.warn('No menu:meta:* keys found — nothing to embed. Seed the menu first.');
      return;
    }
    console.log(`Embedding menus for pos_config_ids: ${posIds.join(', ')}`);
    for (const pos of posIds) await embedPos(redis, pos, embedder);
  } finally {
    redis.disconnect();
  }
}

// Auto-run only when invoked directly (so the functions above stay importable).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
