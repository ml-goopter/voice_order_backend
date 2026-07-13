import type { PosConfigId, ProductTmplId } from '../shared/types.js';
import type { MenuItem, MenuVector } from './menu-types.js';
import type { MenuStore } from './menu-store.js';
import type { EmbeddingService } from './embedding-service.js';
import { similarity } from './fuzzy-matcher.js';

/** A name matches a phrase if it contains it or is fuzzy-close (mirrors FT TEXT). */
const LEXICAL_FUZZY = 0.6;

/** An item with its precomputed name vectors (one per language). */
interface IndexedMenuItem {
  item: MenuItem;
  vectors: MenuVector[];
}

/** Cosine similarity in [0, 1]; 0 for empty/mismatched-length vectors. */
function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * In-memory `MenuStore` — the test double and a dependency-free local option. It
 * runs KNN as an in-process cosine scan, mirroring `PostgresMenuStore` semantics.
 * Not wired into the production app, which uses `PostgresMenuStore` exclusively.
 */
export class InMemoryMenuStore implements MenuStore {
  private readonly byPos = new Map<PosConfigId, IndexedMenuItem[]>();

  /** Items only, no vectors — enough for the cart lookups / fuzzy fallback. */
  static of(pos: PosConfigId, items: MenuItem[]): InMemoryMenuStore {
    const store = new InMemoryMenuStore();
    store.byPos.set(pos, items.map((item) => ({ item, vectors: [] })));
    return store;
  }

  /** Embed each item's per-language names ('passage'), mirroring the seed path. */
  async load(pos: PosConfigId, items: MenuItem[], embedder: EmbeddingService): Promise<void> {
    const indexed = await Promise.all(
      items.map(async (item) => {
        const texts = Object.values(item.names);
        const vectors = await embedder.embedBatch(texts, 'passage');
        const out: MenuVector[] = [];
        for (let i = 0; i < texts.length; i++) {
          const vector = vectors[i] ?? [];
          if (vector.length > 0) out.push({ text: texts[i]!, vector });
        }
        return { item, vectors: out };
      }),
    );
    this.byPos.set(pos, indexed);
  }

  private indexed(pos: PosConfigId): IndexedMenuItem[] {
    return this.byPos.get(pos) ?? [];
  }

  ensureIndex(): Promise<void> {
    return Promise.resolve();
  }

  knnSearch(
    pos: PosConfigId,
    queryVectors: number[][],
    k: number,
  ): Promise<Map<ProductTmplId, number>> {
    // Availability is NOT filtered here (mirrors PostgresMenuStore); the matcher's
    // rank() re-checks it against the live item.
    const best = new Map<ProductTmplId, number>();
    for (const { item, vectors } of this.indexed(pos)) {
      let sim = 0;
      for (const qv of queryVectors) {
        for (const iv of vectors) {
          const s = cosine(qv, iv.vector);
          if (s > sim) sim = s;
        }
      }
      if (sim > 0) best.set(item.product_tmpl_id, sim);
    }
    // Keep the k nearest, matching a real KNN's top-k cutoff.
    if (best.size <= k) return Promise.resolve(best);
    const top = [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
    return Promise.resolve(new Map(top));
  }

  lexicalSearch(pos: PosConfigId, phrases: string[]): Promise<Set<ProductTmplId>> {
    const ids = new Set<ProductTmplId>();
    for (const { item } of this.indexed(pos)) {
      const names = Object.values(item.names).map((n) => n.toLowerCase());
      const hit = phrases.some((p) =>
        names.some((n) => n.includes(p) || similarity(p, n) >= LEXICAL_FUZZY),
      );
      if (hit) ids.add(item.product_tmpl_id);
    }
    return Promise.resolve(ids);
  }

  getItems(pos: PosConfigId, tmpls: ProductTmplId[]): Promise<MenuItem[]> {
    const set = new Set(tmpls);
    return Promise.resolve(
      this.indexed(pos)
        .map((i) => i.item)
        .filter((i) => set.has(i.product_tmpl_id)),
    );
  }

  allItems(pos: PosConfigId): Promise<MenuItem[]> {
    return Promise.resolve(this.indexed(pos).map((i) => i.item));
  }

  getItem(pos: PosConfigId, tmpl: ProductTmplId): Promise<MenuItem | undefined> {
    return Promise.resolve(this.indexed(pos).find((i) => i.item.product_tmpl_id === tmpl)?.item);
  }

  getItemByKey(pos: PosConfigId, menu_item_key: string): Promise<MenuItem | undefined> {
    return Promise.resolve(this.indexed(pos).find((i) => i.item.menu_item_key === menu_item_key)?.item);
  }
}
