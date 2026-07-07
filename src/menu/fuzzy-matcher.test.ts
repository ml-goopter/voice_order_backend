import { describe, it, expect } from 'vitest';
import { similarity } from './fuzzy-matcher.js';

describe('similarity', () => {
  it('is 1 for identical strings (case/whitespace-insensitive)', () => {
    expect(similarity('Chicken Burger', 'chicken  burger')).toBe(1);
  });

  it('scores substring containment high', () => {
    expect(similarity('burger', 'chicken burger')).toBeGreaterThanOrEqual(0.9);
  });

  it('is 0 when either input is empty', () => {
    expect(similarity('', 'coke')).toBe(0);
    expect(similarity('coke', '')).toBe(0);
  });

  it('rewards near matches over unrelated ones', () => {
    expect(similarity('coke', 'cola')).toBeGreaterThan(similarity('coke', 'fries'));
  });
});
