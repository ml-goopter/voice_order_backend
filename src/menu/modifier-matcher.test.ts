import { describe, it, expect } from 'vitest';
import { modifierMatchScore } from './modifier-matcher.js';
import type { CandidateModifier } from './menu-types.js';

const MODS: CandidateModifier[] = [
  { modifier_key: 'no_pickles', ptav_id: 1, name: 'No pickles', price_extra_cents: 0 },
  { modifier_key: 'extra_cheese', ptav_id: 2, name: 'Extra cheese', price_extra_cents: 150 },
];

describe('modifierMatchScore', () => {
  it('fires when a phrase references a modifier', () => {
    expect(modifierMatchScore(['pickles'], MODS)).toBeGreaterThan(0);
  });

  it('is 0 when nothing resembles a modifier', () => {
    expect(modifierMatchScore(['lemonade'], MODS)).toBe(0);
  });

  it('is 0 for an item with no modifiers', () => {
    expect(modifierMatchScore(['no pickles'], [])).toBe(0);
  });
});
