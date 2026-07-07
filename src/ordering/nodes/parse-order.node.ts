import type { LlmProvider } from '../../llm/llm-provider.js';
import type { OrderGraphInput } from '../schemas/order-graph-input.schema.js';
import { buildPrompt } from '../../llm/prompt-builder.js';

/** Call the LLM parser; returns raw JSON text to be schema-validated (design §8). */
export async function parseOrder(llm: LlmProvider, input: OrderGraphInput): Promise<string> {
  return llm.complete(buildPrompt(input));
}
