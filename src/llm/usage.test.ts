import { describe, it, expect } from 'vitest';
import { addUsage, cacheHitRate, ZERO_TURN_USAGE } from './usage.js';

describe('addUsage', () => {
  it('sums token counts across calls and increments the call count', () => {
    const a = addUsage(ZERO_TURN_USAGE, { promptTokens: 100, completionTokens: 10, totalTokens: 110, cachedTokens: 40 });
    const b = addUsage(a, { promptTokens: 200, completionTokens: 20, totalTokens: 220, cachedTokens: 180 });
    expect(b).toEqual({
      promptTokens: 300,
      completionTokens: 30,
      totalTokens: 330,
      cachedTokens: 220,
      cachePromptTokens: 300,
      cacheReported: true,
      calls: 2,
    });
  });

  it('keeps cacheReported false when no call reports cached tokens', () => {
    const a = addUsage(ZERO_TURN_USAGE, { promptTokens: 100, completionTokens: 10, totalTokens: 110 });
    const b = addUsage(a, { promptTokens: 50, completionTokens: 5, totalTokens: 55 });
    expect(b.cacheReported).toBe(false);
    expect(b.cachedTokens).toBe(0);
    expect(b.cachePromptTokens).toBe(0);
    expect(b.calls).toBe(2);
  });

  it('flips cacheReported to true as soon as one call reports, even if that value is 0', () => {
    const a = addUsage(ZERO_TURN_USAGE, { promptTokens: 100, completionTokens: 10, totalTokens: 110 });
    const b = addUsage(a, { promptTokens: 50, completionTokens: 5, totalTokens: 55, cachedTokens: 0 });
    expect(b.cacheReported).toBe(true);
    expect(b.cachedTokens).toBe(0);
  });

  it('counts only cache-reporting calls in cachePromptTokens, so unknown-status tokens do not dilute the rate', () => {
    // Call A reports cache (1000 prompt, 800 cached); call B reports NO cache (1000 prompt, unknown).
    const a = addUsage(ZERO_TURN_USAGE, { promptTokens: 1000, completionTokens: 10, totalTokens: 1010, cachedTokens: 800 });
    const b = addUsage(a, { promptTokens: 1000, completionTokens: 10, totalTokens: 1010 });
    expect(b.promptTokens).toBe(2000); // full turn total
    expect(b.cachePromptTokens).toBe(1000); // only A's prompt tokens (B's status unknown)
    expect(b.cachedTokens).toBe(800);
    // Blended rate is 800/1000 = 0.8, NOT 800/2000 = 0.4 — B's unknown tokens are excluded.
    expect(cacheHitRate(b.cachePromptTokens, b.cachedTokens)).toBe(0.8);
  });
});

describe('cacheHitRate', () => {
  it('returns the cached fraction rounded to 3dp', () => {
    expect(cacheHitRate(1000, 875)).toBe(0.875);
    expect(cacheHitRate(3, 1)).toBe(0.333);
  });

  it('returns null when there are no prompt tokens (undefined rate, not 0%)', () => {
    expect(cacheHitRate(0, 0)).toBeNull();
  });

  it('is 0 for a genuine miss', () => {
    expect(cacheHitRate(500, 0)).toBe(0);
  });
});
