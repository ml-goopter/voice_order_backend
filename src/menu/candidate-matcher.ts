import type { PosConfigId } from '../shared/types.js';
import type { MenuCache } from './menu-cache.js';
import type { CandidateItem, CandidateSet } from './menu-types.js';
import { LIMITS } from '../config/constants.js';

/**
 * Finds likely items before the LLM call (design §7) so the whole menu is never
 * sent. Real design: chunk transcript → embed → hybrid rank (embedding + fuzzy +
 * alias + modifier + popularity) across multi-language vectors.
 *
 * This scaffold ships a naive substring/popularity matcher as a placeholder.
 * TODO: add embedding-service + fuzzy-matcher + modifier-matcher for hybrid ranking.
 */
export class CandidateMatcher {
  constructor(private readonly cache: MenuCache) {}

  /** Split a transcript into likely item/modifier phrases (design §7). */
  chunk(text: string): string[] {
    return text
      .split(/,|\band\b|\bwith\b|\bno\b/i)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  match(pos_config_id: PosConfigId, text: string): CandidateSet {
    const phrases = this.chunk(text.toLowerCase());
    const items = this.cache.items(pos_config_id);
    const scored: Array<{ item: CandidateItem; score: number }> = [];

    for (const item of items) {
      if (!item.available) continue;
      const names = Object.values(item.names).map((n) => n.toLowerCase());
      let best = 0;
      for (const phrase of phrases) {
        for (const name of names) {
          if (name.includes(phrase) || phrase.includes(name)) best = Math.max(best, 0.9);
        }
      }
      if (best > 0) {
        scored.push({
          item: {
            menu_item_key: item.menu_item_key,
            product_tmpl_id: item.product_tmpl_id,
            name: item.names['en_US'] ?? Object.values(item.names)[0] ?? item.menu_item_key,
            score: best + item.popularity * 1e-6,
            available_modifiers: item.modifiers,
          },
          score: best + item.popularity * 1e-6,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return { items: scored.slice(0, LIMITS.maxCandidatesToLlm).map((s) => s.item) };
  }
}
