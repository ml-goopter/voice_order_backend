import { describe, it, expect } from 'vitest';
import { buildIntentPrompt } from './intent-prompt-builder.js';
import { intentSchema } from '../ordering/graph/intents.js';

describe('buildIntentPrompt', () => {
  it('produces a non-empty system prompt that names every intent', () => {
    const { system } = buildIntentPrompt('two spring rolls');
    expect(system.length).toBeGreaterThan(0);
    for (const intent of intentSchema.options) {
      expect(system).toContain(intent);
    }
  });

  it('carries the utterance in a JSON-parseable user payload', () => {
    const { user } = buildIntentPrompt('what do you recommend');
    expect(JSON.parse(user)).toEqual({ customer_text: 'what do you recommend' });
  });
});
