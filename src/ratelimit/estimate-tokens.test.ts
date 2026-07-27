import { describe, it, expect } from 'vitest';
import { estimateTokens } from './estimate-tokens.js';
import { RATE_LIMIT } from '../config/constants.js';
import { buildAgentSystemPrompt } from '../llm/agent-prompt-builder.js';
import { TOOL_SPECS } from '../ordering/tools/tool-specs.js';
import type { AgentMessage } from '../llm/llm-provider.js';

describe('estimateTokens', () => {
  it('costs an empty string at nothing', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('rounds a string up to the next whole token', () => {
    expect(estimateTokens('abcde')).toBe(2); // ceil(5 / 4)
  });

  it('adds one envelope per message', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'abcd' },
      { role: 'assistant', content: 'abcd' },
      { role: 'user', content: 'abcd' },
    ];
    // 3 × (1 content token + 3 envelope tokens)
    expect(estimateTokens(messages)).toBe(12);
  });

  it('measures tool specs as the JSON the provider receives', () => {
    const spec = { name: 'search_menu', description: 'find items', parameters: { type: 'object' } };
    expect(estimateTokens([spec])).toBe(Math.ceil(JSON.stringify(spec).length / RATE_LIMIT.charsPerToken));
  });

  it('stays within ±25% of the measured fixed agent-step cost', () => {
    // Tripwire against estimator drift AND unnoticed prompt bloat: docs/llm-prompt-cost-estimate.md
    // records 4,303 real tokens for the system prompt + tool specs re-sent on every agent step.
    const measured = 4_303;
    const estimated = estimateTokens(buildAgentSystemPrompt()) + estimateTokens(TOOL_SPECS);
    expect(estimated).toBeGreaterThan(measured * 0.75);
    expect(estimated).toBeLessThan(measured * 1.25);
  });
});
