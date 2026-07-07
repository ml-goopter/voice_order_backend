import type { CandidateModifier } from './menu-types.js';
import { similarity } from './fuzzy-matcher.js';

/** Below this a phrase↔modifier pairing is treated as unrelated. */
const MODIFIER_MATCH_THRESHOLD = 0.6;

/**
 * Ranking signal (design §7): best similarity between any transcript phrase and
 * any of the item's modifiers, in [0, 1]. Boosts an item when the customer
 * mentioned one of its modifiers ("no pickles", "extra cheese"). Returns 0 when
 * nothing clears the threshold.
 */
export function modifierMatchScore(phrases: string[], modifiers: CandidateModifier[]): number {
  let best = 0;
  for (const phrase of phrases) {
    for (const mod of modifiers) {
      const s = similarity(phrase, mod.name);
      if (s > best) best = s;
    }
  }
  return best >= MODIFIER_MATCH_THRESHOLD ? best : 0;
}
