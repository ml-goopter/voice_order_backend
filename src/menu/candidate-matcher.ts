import type { PosConfigId } from '../shared/types.js';
import type { MenuCache } from './menu-cache.js';
import type { EmbeddingService } from './embedding-service.js';
import type { CandidateItem, CandidateSet } from './menu-types.js';
import { LIMITS } from '../config/constants.js';
import { similarity } from './fuzzy-matcher.js';
import { modifierMatchScore } from './modifier-matcher.js';

/**
 * Hybrid ranking weights (design §7). Embedding dominates when available; fuzzy
 * and modifier signals keep the matcher useful when the embedder is a stub
 * (zero vectors → emb term contributes 0 uniformly, so ranking still works).
 */
const W_EMBED = 0.55;
const W_FUZZY = 0.35;
const W_MODIFIER = 0.1;
/** Combined relevance below this is treated as no match. */
const SCORE_THRESHOLD = 0.15;

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
 * Finds likely items before the LLM call (design §7) so the whole menu is never
 * sent: chunk transcript → embed each phrase once → hybrid-rank every available
 * item (embedding + fuzzy + modifier) across its multi-language name vectors →
 * return the top-N.
 */
export class CandidateMatcher {
  constructor(
    private readonly cache: MenuCache,
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

    // Customer transcript phrases are the search side → 'query' (design §7).
    const phraseVectors = await this.embedder.embedBatch(phrases, 'query');
    const scored: Array<{ item: CandidateItem; score: number }> = [];

    for (const { item, vectors } of this.cache.indexed(pos_config_id)) {
      if (!item.available) continue;
      const names = Object.values(item.names).map((n) => n.toLowerCase());

      let fuzzy = 0;
      for (const phrase of phrases) {
        for (const name of names) {
          const s = similarity(phrase, name);
          if (s > fuzzy) fuzzy = s;
        }
      }

      let emb = 0;
      for (const pv of phraseVectors) {
        for (const iv of vectors) {
          const s = cosine(pv, iv.vector);
          if (s > emb) emb = s;
        }
      }

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
