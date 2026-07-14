import { describe, it, expect } from 'vitest';
import { END } from '@langchain/langgraph';
import { intentSchema, INTENT_ROUTE, DEFAULT_INTENT } from './intents.js';

describe('INTENT_ROUTE', () => {
  it('has a non-empty destination node for every intent (guards enum/route drift)', () => {
    for (const intent of intentSchema.options) {
      expect(typeof INTENT_ROUTE[intent]).toBe('string');
      expect(INTENT_ROUTE[intent].length).toBeGreaterThan(0);
    }
  });

  it('is a junk-gate: order and suggest both enter the proposer pipeline (load_cart → agent)', () => {
    expect(INTENT_ROUTE.order).toBe('load_cart');
    expect(INTENT_ROUTE.suggest).toBe('load_cart');
    expect(DEFAULT_INTENT).toBe('order');
  });

  it('short-circuits junk straight to END so it never pollutes history', () => {
    expect(INTENT_ROUTE.junk).toBe(END);
  });
});
