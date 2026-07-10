import { describe, it, expect } from 'vitest';
import { intentSchema, INTENT_ROUTE, DEFAULT_INTENT } from './intents.js';

describe('INTENT_ROUTE', () => {
  it('has a non-empty destination node for every intent (guards enum/route drift)', () => {
    for (const intent of intentSchema.options) {
      expect(typeof INTENT_ROUTE[intent]).toBe('string');
      expect(INTENT_ROUTE[intent].length).toBeGreaterThan(0);
    }
  });

  it('routes the order intent through the proposer pipeline (normalize)', () => {
    expect(INTENT_ROUTE.order).toBe('normalize');
    expect(DEFAULT_INTENT).toBe('order');
  });
});
