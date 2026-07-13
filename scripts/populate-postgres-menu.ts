/**
 * Populate the `item_vector` table (in the Odoo Postgres DB) for one restaurant.
 *
 * This is the pgvector analogue of the Redis seed/index scripts. `item_vector`
 * carries the per-restaurant membership + `menu_item_key` + one embedding row per
 * (item, language) name; Odoo's own tables (`product_template`, the attribute
 * tables) stay the read-only source of truth and are JOINed at read time by
 * `PostgresMenuStore`. So this script writes ONLY `item_vector` — never Odoo's rows.
 *
 * For the given pos_config_id it reads every `available_in_pos AND active`
 * template, slugifies a stable `menu_item_key`, embeds each language name with the
 * SAME model the matcher queries with (role 'passage'), and upserts the rows. It is
 * re-runnable: it clears this pos's rows before rewriting them.
 *
 * Env:
 *   ODOO_DATABASE_URL     postgres://localhost:5432/odoo
 *   EMBEDDING_PROVIDER    must NOT be 'stub' (real vectors required)
 *   EMBEDDING_DIMENSIONS  vector width (default 1024; must match the table)
 *   POS_CONFIG_ID         restaurant to seed (default 1)
 *
 * Run:  npm run seed:menu:pg
 */
import pg from 'pg';
import { config } from '../src/config/env.js';
import { createEmbeddingService } from '../src/menu/embedding-service.js';
import { PostgresMenuStore, encodeVector } from '../src/menu/postgres-menu-store.js';

const { Pool } = pg;

interface TemplateRow {
  id: number;
  name: Record<string, string> | null; // jsonb { en_US: "…", … }
}

/** LLM-facing key from a name: lowercased, non-alphanumerics → underscore. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
}

/** A stable, unique-per-pos key for a template (suffix the id on slug collisions). */
function menuItemKey(names: Record<string, string>, tmpl: number, seen: Set<string>): string {
  const base = slugify(names.en_US ?? Object.values(names)[0] ?? '') || `item_${tmpl}`;
  const key = seen.has(base) ? `${base}_${tmpl}` : base;
  seen.add(key);
  return key;
}

async function main(): Promise<void> {
  const posConfigId = Number.parseInt(process.env.POS_CONFIG_ID ?? '1', 10);
  const embedder = createEmbeddingService();
  if (embedder.dimensions <= 0) {
    console.error('EMBEDDING_PROVIDER must emit real vectors (not the stub) to seed item_vector.');
    process.exit(1);
  }
  if (embedder.dimensions !== config.embeddingDimensions) {
    console.error(
      `Embedder dims ${embedder.dimensions} ≠ EMBEDDING_DIMENSIONS ${config.embeddingDimensions}.`,
    );
    process.exit(1);
  }

  const pool = new Pool({ connectionString: config.odooDatabaseUrl });
  try {
    // Ensure the table + indexes exist (idempotent).
    await new PostgresMenuStore(pool, config.embeddingDimensions).ensureIndex();

    const { rows: templates } = await pool.query<TemplateRow>(
      `SELECT id, name FROM product_template WHERE available_in_pos AND active ORDER BY id`,
    );
    if (templates.length === 0) {
      console.warn('No available_in_pos templates found — nothing to seed.');
      return;
    }

    // Flatten to one embedding row per (item, language) name.
    const seenKeys = new Set<string>();
    const rows: Array<{ tmpl: number; key: string; lang: string; name: string }> = [];
    for (const t of templates) {
      const names = t.name ?? {};
      const key = menuItemKey(names, t.id, seenKeys);
      for (const [lang, name] of Object.entries(names)) {
        if (name.trim().length > 0) rows.push({ tmpl: t.id, key, lang, name });
      }
    }
    if (rows.length === 0) {
      console.warn('Templates carried no non-empty names — nothing to embed.');
      return;
    }

    console.log(
      `Embedding ${rows.length} names from ${templates.length} items (${embedder.dimensions} dims)…`,
    );
    const vectors = await embedder.embedBatch(
      rows.map((r) => r.name),
      'passage',
    );

    // Rewrite this pos's rows in one transaction (clear then bulk insert).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM item_vector WHERE pos_config_id = $1', [posConfigId]);
      let written = 0;
      let skipped = 0;
      for (let i = 0; i < rows.length; i++) {
        const vec = vectors[i] ?? [];
        if (vec.length !== embedder.dimensions) {
          skipped++;
          continue;
        }
        const r = rows[i]!;
        await client.query(
          `INSERT INTO item_vector (pos_config_id, product_tmpl_id, menu_item_key, lang, name, vector)
           VALUES ($1, $2, $3, $4, $5, $6::vector)`,
          [posConfigId, r.tmpl, r.key, r.lang, r.name, encodeVector(vec)],
        );
        written++;
      }
      await client.query('COMMIT');
      console.log(
        `pos ${posConfigId}: wrote ${written} item_vector rows` +
          (skipped > 0 ? ` (skipped ${skipped} with wrong vector width)` : ''),
      );
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
