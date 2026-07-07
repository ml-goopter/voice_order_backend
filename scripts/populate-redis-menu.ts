/**
 * Populate Redis with menu item data extracted from an Odoo POS Postgres
 * (the `jadegarden1` dump restored to Postgres).
 *
 * For each POS-available product it writes one JSON blob:
 *   menu:item:{pos_config_id}:{product_tmpl_id}  -> JSON (see MenuItemRecord)
 *   menu:items:{pos_config_id}                   -> SET of product_tmpl_ids
 *   menu:meta:{pos_config_id}                    -> JSON { count, languages, embedding, source }
 *
 * Each record also carries `vectors`: its per-language names embedded with the
 * 'passage' role (mirroring MenuCache.embedNames), so the app reads items AND
 * their vectors from Redis and never re-embeds the menu at boot.
 *
 * Translations are read from Odoo jsonb columns (name/descriptions) keyed by
 * res.lang code (e.g. en_US, zh_CN). Money is stored in integer cents.
 *
 * Env (all have defaults for the local restore container):
 *   SOURCE_DATABASE_URL  postgres://postgres:pass@localhost:5433/jadegarden1
 *   REDIS_URL            redis://localhost:6379
 *   POS_CONFIG_ID        1
 *   EMBEDDING_PROVIDER   set to `jina` (+ JINA_API_KEY) to write real vectors;
 *                        otherwise the stub writes items with no vectors.
 */
import { Client } from 'pg';
import Redis from 'ioredis';
import { createEmbeddingService } from '../src/menu/embedding-service.js';
import type { EmbeddingService } from '../src/menu/embedding-service.js';

const SOURCE_DATABASE_URL =
  process.env.SOURCE_DATABASE_URL ?? 'postgres://postgres:pass@localhost:5433/jadegarden1';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const POS_CONFIG_ID = Number.parseInt(process.env.POS_CONFIG_ID ?? '1', 10);

/** Odoo translatable text: { "en_US": "...", "zh_CN": "..." }. */
type Translations = Record<string, string>;

interface MenuModifier {
  ptav_id: number;
  modifier_key: string; // maps to ptav_id, string form for the LLM
  attribute: string; // attribute name (en_US), e.g. "size"
  names: Translations; // value name per language, e.g. { en_US: "Large" }
  price_extra_cents: number;
}

interface MenuCategory {
  id: number;
  names: Translations;
}

/** One name embedded for retrieval — matches the runtime MenuVector shape. */
interface StoredVector {
  text: string;
  vector: number[];
}

interface MenuItemRecord {
  product_tmpl_id: number;
  menu_item_key: string;
  default_code: string | null;
  names: Translations; // translated item names
  alternative_name: string | null; // Odoo single-string alt name (here: Chinese)
  descriptions: Translations; // translated descriptions (empty in this dataset)
  base_price_cents: number;
  available: boolean;
  categories: MenuCategory[];
  modifiers: MenuModifier[];
  vectors: StoredVector[]; // per-language name embeddings ('passage' role)
}

/** Embed an item's per-language names, mirroring MenuCache.embedNames. */
async function embedNames(names: Translations, embedder: EmbeddingService): Promise<StoredVector[]> {
  const texts = Object.values(names);
  if (texts.length === 0) return [];
  const vectors = await embedder.embedBatch(texts, 'passage');
  const out: StoredVector[] = [];
  for (let i = 0; i < texts.length; i++) {
    const vector = vectors[i] ?? [];
    if (vector.length > 0) out.push({ text: texts[i]!, vector });
  }
  return out;
}

function toCents(numeric: string | number | null): number {
  if (numeric === null) return 0;
  return Math.round(Number(numeric) * 100);
}

/** Trim every string value in an Odoo jsonb translation map (values often have trailing spaces). */
function cleanTranslations(raw: unknown): Translations {
  if (!raw || typeof raw !== 'object') return {};
  const out: Translations = {};
  for (const [lang, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val === 'string') {
      const t = val.trim();
      if (t) out[lang] = t;
    }
  }
  return out;
}

function slugify(name: string, fallback: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || fallback;
}

async function main(): Promise<void> {
  const pg = new Client({ connectionString: SOURCE_DATABASE_URL });
  await pg.connect();
  const redis = new Redis(REDIS_URL);

  try {
    // 1. Products available in POS.
    const products = await pg.query<{
      id: number;
      default_code: string | null;
      name: unknown;
      alternative_name: string | null;
      public_description: unknown;
      description_sale: unknown;
      list_price: string | null;
      available_in_pos: boolean;
    }>(
      `SELECT id, default_code, name, alternative_name,
              public_description, description_sale, list_price, available_in_pos
         FROM product_template
        WHERE available_in_pos = true AND active = true
        ORDER BY id`,
    );

    // 2. Modifiers (product_template_attribute_value) for all products, grouped in JS.
    const modifierRows = await pg.query<{
      product_tmpl_id: number;
      ptav_id: number;
      attribute: string | null;
      value_name: unknown;
      price_extra: string | null;
    }>(
      `SELECT ptav.product_tmpl_id,
              ptav.id                        AS ptav_id,
              pa.name ->> 'en_US'            AS attribute,
              pav.name                       AS value_name,
              ptav.price_extra
         FROM product_template_attribute_value ptav
         JOIN product_attribute_value pav ON pav.id = ptav.product_attribute_value_id
         JOIN product_template_attribute_line ptal ON ptal.id = ptav.attribute_line_id
         JOIN product_attribute pa ON pa.id = ptal.attribute_id
        WHERE ptav.ptav_active = true
        ORDER BY ptav.product_tmpl_id, ptav.id`,
    );
    const modifiersByTmpl = new Map<number, MenuModifier[]>();
    for (const r of modifierRows.rows) {
      const list = modifiersByTmpl.get(r.product_tmpl_id) ?? [];
      list.push({
        ptav_id: r.ptav_id,
        modifier_key: String(r.ptav_id),
        attribute: r.attribute ?? '',
        names: cleanTranslations(r.value_name),
        price_extra_cents: toCents(r.price_extra),
      });
      modifiersByTmpl.set(r.product_tmpl_id, list);
    }

    // 3. POS categories per product, grouped in JS.
    const categoryRows = await pg.query<{
      product_template_id: number;
      cat_id: number;
      name: unknown;
    }>(
      `SELECT rel.product_template_id, pc.id AS cat_id, pc.name
         FROM pos_category_product_template_rel rel
         JOIN pos_category pc ON pc.id = rel.pos_category_id
        ORDER BY rel.product_template_id, pc.id`,
    );
    const categoriesByTmpl = new Map<number, MenuCategory[]>();
    for (const r of categoryRows.rows) {
      const list = categoriesByTmpl.get(r.product_template_id) ?? [];
      list.push({ id: r.cat_id, names: cleanTranslations(r.name) });
      categoriesByTmpl.set(r.product_template_id, list);
    }

    // 4. Build records (embedding each item's names) and write in one pipeline.
    const embedder = createEmbeddingService();
    if (embedder.dimensions === 0) {
      console.warn(
        'EMBEDDING_PROVIDER yields no vectors (dimensions=0); items will be written ' +
          'WITHOUT embeddings. Set EMBEDDING_PROVIDER=jina and JINA_API_KEY for retrieval.',
      );
    }

    const itemsSetKey = `menu:items:${POS_CONFIG_ID}`;
    const pipeline = redis.pipeline();
    pipeline.del(itemsSetKey);

    let withModifiers = 0;
    let withVectors = 0;
    for (const p of products.rows) {
      const names = cleanTranslations(p.name);
      const descriptions = {
        ...cleanTranslations(p.public_description),
        ...cleanTranslations(p.description_sale),
      };
      const modifiers = modifiersByTmpl.get(p.id) ?? [];
      if (modifiers.length > 0) withModifiers++;

      const vectors = await embedNames(names, embedder);
      if (vectors.length > 0) withVectors++;

      const record: MenuItemRecord = {
        product_tmpl_id: p.id,
        menu_item_key: slugify(names.en_US ?? '', p.default_code ?? `item_${p.id}`),
        default_code: p.default_code,
        names,
        alternative_name: p.alternative_name,
        descriptions,
        base_price_cents: toCents(p.list_price),
        available: p.available_in_pos,
        categories: categoriesByTmpl.get(p.id) ?? [],
        modifiers,
        vectors,
      };

      pipeline.set(`menu:item:${POS_CONFIG_ID}:${p.id}`, JSON.stringify(record));
      pipeline.sadd(itemsSetKey, String(p.id));
    }

    const languages = Array.from(
      new Set(products.rows.flatMap((p) => Object.keys(cleanTranslations(p.name)))),
    ).sort();
    pipeline.set(
      `menu:meta:${POS_CONFIG_ID}`,
      JSON.stringify({
        pos_config_id: POS_CONFIG_ID,
        count: products.rows.length,
        languages,
        embedding: { model: embedder.model, dimensions: embedder.dimensions },
        source: 'jadegarden1 (Odoo POS)',
      }),
    );

    const results = await pipeline.exec();
    const failed = results?.filter(([err]) => err) ?? [];
    if (failed.length > 0) {
      throw new Error(`Redis pipeline had ${failed.length} errors: ${String(failed[0]?.[0])}`);
    }

    console.log(
      `Loaded ${products.rows.length} menu items into Redis under pos_config_id=${POS_CONFIG_ID}\n` +
        `  languages: ${languages.join(', ')}\n` +
        `  items with modifiers: ${withModifiers}\n` +
        `  items with vectors: ${withVectors} (${embedder.model}, ${embedder.dimensions} dims)\n` +
        `  keys: menu:item:${POS_CONFIG_ID}:{id}, menu:items:${POS_CONFIG_ID}, menu:meta:${POS_CONFIG_ID}`,
    );
  } finally {
    await pg.end();
    redis.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
