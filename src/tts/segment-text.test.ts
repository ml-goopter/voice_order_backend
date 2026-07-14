import { describe, it, expect } from 'vitest';
import { segmentText } from './segment-text.js';

describe('segmentText', () => {
  it('returns a single segment for a one-sentence reply', () => {
    expect(segmentText('How about a Coke?')).toEqual(['How about a Coke?']);
  });

  it('splits on sentence boundaries', () => {
    expect(segmentText('Sure thing. Anything else?')).toEqual(['Sure thing.', 'Anything else?']);
  });

  it('keeps prices/decimals intact (no space after the dot)', () => {
    expect(segmentText("That's $2.50. Anything else?")).toEqual(["That's $2.50.", 'Anything else?']);
  });

  it('trims and drops empty fragments', () => {
    expect(segmentText('  One.   Two.  ')).toEqual(['One.', 'Two.']);
  });

  it('returns [] for empty / whitespace-only text', () => {
    expect(segmentText('   ')).toEqual([]);
    expect(segmentText('')).toEqual([]);
  });

  it('hard-wraps an over-long punctuation-free clause', () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const segments = segmentText(long);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.every((s) => s.length <= 160)).toBe(true);
    // Reassembling the words is lossless.
    expect(segments.join(' ').split(' ')).toEqual(long.split(' '));
  });
});
