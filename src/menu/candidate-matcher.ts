import type { PosConfigId, ProductTmplId } from '../shared/types.js';
import type { MenuStore } from './menu-store.js';
import type { EmbeddingService } from './embedding-service.js';
import type { CandidateItem, CandidateSet, MenuItem } from './menu-types.js';
import { LIMITS } from '../config/constants.js';
import { similarity } from './fuzzy-matcher.js';
import { modifierMatchScore } from './modifier-matcher.js';

/**
 * Hybrid ranking weights (design §7). Embedding dominates when available; fuzzy
 * and modifier signals rerank the retrieved set (and carry the whole match when
 * no embeddings exist).
 */
const W_EMBED = 0.55;
const W_FUZZY = 0.35;
const W_MODIFIER = 0.1;
/** Combined relevance below this is treated as no match. */
const SCORE_THRESHOLD = 0.15;
/** How many neighbours to retrieve per phrase before reranking (> the final N). */
const KNN_K = 24;

/**
 * Finds likely items before the LLM call (design §7) so the whole menu is never
 * sent. Retrieve-then-rerank: chunk transcript → embed each phrase once → retrieve
 * a candidate union (vector KNN ∪ lexical name search, so items the vector recall
 * misses but that lexically match are still surfaced) → hybrid-rank (embedding +
 * fuzzy + modifier) → top-N. With no embeddings (stub embedder or an unbuilt index)
 * it falls back to a fuzzy/modifier scan over the full menu.
 */
export class CandidateMatcher {
  constructor(
    private readonly store: MenuStore,
    private readonly embedder: EmbeddingService,
  ) {}

  /** Split a transcript into likely item/modifier phrases (design §7). */
  chunk(text: string): string[] {
    return text
      .split(/,|\band\b|\bwith\b|\bno\b/i)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  async match(pos_config_id: PosConfigId, text: string): Promise<CandidateSet> {
    const phrases = this.chunk(text.toLowerCase());
    if (phrases.length === 0) return { items: [] };

    // No embeddings available → fuzzy/modifier scan over the whole menu.
    if (this.embedder.dimensions === 0) return this.fuzzyScan(pos_config_id, phrases);

    // Customer transcript phrases are the search side → 'query' (design §7).
    const phraseVectors = (await this.embedder.embedBatch(phrases, 'query')).filter(
      (v) => v.length > 0,
    );
    if (phraseVectors.length === 0) return this.fuzzyScan(pos_config_id, phrases);

    // Retrieve by BOTH vector similarity and lexical name match, then union — a
    // high-fuzzy item the KNN recall misses is still surfaced via lexicalSearch.
    const [sims, lexIds] = await Promise.all([
      this.store.knnSearch(pos_config_id, phraseVectors, KNN_K),
      this.store.lexicalSearch(pos_config_id, phrases),
    ]);
    const retrieveIds = new Set<ProductTmplId>([...sims.keys(), ...lexIds]);
    // Nothing retrieved (index missing/empty) → fuzzy fallback rather than fail.
    if (retrieveIds.size === 0) return this.fuzzyScan(pos_config_id, phrases);

    const items = await this.store.getItems(pos_config_id, [...retrieveIds]);
    return this.rank(items, phrases, (item) => sims.get(item.product_tmpl_id) ?? 0);
  }

  /** Rank hydrated candidates by W_EMBED·emb + W_FUZZY·fuzzy + W_MODIFIER·mod. */
  private async fuzzyScan(pos_config_id: PosConfigId, phrases: string[]): Promise<CandidateSet> {
    const items = await this.store.allItems(pos_config_id);
    return this.rank(items, phrases, () => 0);
  }

  private rank(items: MenuItem[], phrases: string[], embOf: (item: MenuItem) => number): CandidateSet {
    const scored: Array<{ item: CandidateItem; score: number }> = [];
    for (const item of items) {
      if (!item.available) continue;
      const names = Object.values(item.names).map((n) => n.toLowerCase());

      let fuzzy = 0;
      for (const phrase of phrases) {
        for (const name of names) {
          const s = similarity(phrase, name);
          if (s > fuzzy) fuzzy = s;
        }
      }

      const emb = embOf(item);
      const mod = modifierMatchScore(phrases, item.modifiers);
      const score = W_EMBED * emb + W_FUZZY * fuzzy + W_MODIFIER * mod;
      if (score < SCORE_THRESHOLD) continue;

      scored.push({
        item: {
          menu_item_key: item.menu_item_key,
          product_tmpl_id: item.product_tmpl_id,
          name: item.names['en_US'] ?? Object.values(item.names)[0] ?? item.menu_item_key,
          score,
          available_modifiers: item.modifiers,
        },
        score,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return { items: scored.slice(0, LIMITS.maxCandidatesToLlm).map((s) => s.item) };
  }
}
