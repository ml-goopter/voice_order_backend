import { RATE_LIMIT } from '../config/constants.js';
import type { AgentMessage, ToolSpec } from '../llm/llm-provider.js';

/** Per-message framing the provider bills on top of the content (role/separator tokens). */
const MESSAGE_ENVELOPE_TOKENS = 3;

function tokensForChars(chars: number): number {
  return Math.ceil(chars / RATE_LIMIT.charsPerToken);
}

function charTokens(text: string): number {
  return tokensForChars(text.length);
}

function messageChars(m: AgentMessage): number {
  if (m.role === 'assistant') {
    return (m.content?.length ?? 0) + (m.tool_calls !== undefined ? JSON.stringify(m.tool_calls).length : 0);
  }
  if (m.role === 'tool') return m.content.length + m.tool_call_id.length;
  return m.content.length;
}

/**
 * Cheap char-count token estimate for a TPM reservation.
 *
 * Deliberately NOT a real BPE tokenizer: `gpt-tokenizer` is a devDependency used only by
 * `scripts/estimate-prompt-tokens.ts`, and putting a BPE table in the hot path to refine a number
 * that post-call reconciliation corrects anyway is not worth it. Tool specs are measured as the
 * JSON the provider receives.
 */
export function estimateTokens(input: string | readonly (AgentMessage | ToolSpec)[]): number {
  if (typeof input === 'string') return charTokens(input);
  let total = 0;
  for (const item of input) {
    if ('role' in item) total += MESSAGE_ENVELOPE_TOKENS + tokensForChars(messageChars(item));
    else total += charTokens(JSON.stringify(item));
  }
  return total;
}
