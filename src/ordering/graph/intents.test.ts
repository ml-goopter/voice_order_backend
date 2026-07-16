import { describe, it, expect } from 'vitest';
import { END } from '@langchain/langgraph';
import { intentSchema, DEFAULT_INTENT } from '../../contracts/intent.js';
import { INTENT_ROUTE } from './intents.js';

describe('INTENT_ROUTE', () => {
  it('has a non-empty destination node for every intent (guards enum/route drift)', () => {
    for (const intent of intentSchema.options) {
      expect(typeof INTENT_ROUTE[intent]).toBe('string');
      expect(INTENT_ROUTE[intent].length).toBeGreaterThan(0);
    }
  });

  it('is a binary junk-gate: service enters the agent pipeline (load_cart → agent)', () => {
    expect(intentSchema.options).toEqual(['service', 'junk']);
    expect(INTENT_ROUTE.service).toBe('load_cart');
    expect(DEFAULT_INTENT).toBe('service');
  });

  it('short-circuits junk straight to END so it never pollutes history', () => {
    expect(INTENT_ROUTE.junk).toBe(END);
  });
});
