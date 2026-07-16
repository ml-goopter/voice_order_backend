import { describe, it, expect } from 'vitest';
import { classifyIntent } from './classify-intent.node.js';
import { intentSchema } from '../../contracts/intent.js';
import type { LlmPrompt, LlmProvider } from '../../llm/llm-provider.js';

/** An LlmProvider whose single reply is fixed (or throws). */
function fakeLlm(reply: string | (() => Promise<string>)): LlmProvider {
  return {
    name: 'fake',
    complete: (_prompt: LlmPrompt) => (typeof reply === 'string' ? Promise.resolve(reply) : reply()),
    chat: () => Promise.reject(new Error('fakeLlm: chat not used by this test')),
  };
}

describe('classifyIntent', () => {
  it('returns the classified intent for well-formed output', async () => {
    for (const intent of intentSchema.options) {
      const llm = fakeLlm(JSON.stringify({ intent }));
      expect(await classifyIntent(llm, 'hi')).toBe(intent);
    }
  });

  it('defaults to service on non-JSON output', async () => {
    expect(await classifyIntent(fakeLlm('not json at all'), 'x')).toBe('service');
  });

  it('defaults to service on a valid-but-non-object payload (JSON null)', async () => {
    expect(await classifyIntent(fakeLlm('null'), 'x')).toBe('service');
  });

  it('defaults to service on an unrecognized intent label', async () => {
    expect(await classifyIntent(fakeLlm(JSON.stringify({ intent: 'banana' })), 'x')).toBe('service');
  });

  // The pre-binary label set. A model still echoing an old prompt must degrade to the pipeline,
  // not be read as a routable intent.
  it('defaults to service on a retired intent label', async () => {
    expect(await classifyIntent(fakeLlm(JSON.stringify({ intent: 'suggest' })), 'x')).toBe('service');
  });

  it('defaults to service when the LLM call throws', async () => {
    const llm = fakeLlm(() => Promise.reject(new Error('boom')));
    expect(await classifyIntent(llm, 'x')).toBe('service');
  });
});
