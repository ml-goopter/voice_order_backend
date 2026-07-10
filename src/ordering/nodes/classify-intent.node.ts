import type { LlmProvider } from '../../llm/llm-provider.js';
import { buildIntentPrompt } from '../../llm/intent-prompt-builder.js';
import { intentSchema, DEFAULT_INTENT } from '../graph/intents.js';
import type { Intent } from '../graph/intents.js';
import { logger } from '../../config/logger.js';
import { messageOf } from '../../shared/errors.js';

/**
 * Classify an utterance into an {@link Intent} via the LLM (design §6). The graph's first hop:
 * its label drives routing. DEGRADES TO `order` on any failure — a transport error, non-JSON
 * output, or an unrecognized label must never drop a real order, so the safe default runs the
 * full proposer pipeline. Pure with respect to graph state (takes text, returns an Intent) so
 * it can be unit-tested with a fake LlmProvider, mirroring the other nodes.
 */
export async function classifyIntent(llm: LlmProvider, customerText: string): Promise<Intent> {
  let raw: string;
  try {
    raw = await llm.complete(buildIntentPrompt(customerText));
  } catch (error) {
    logger.warn('order.classify_failed', { reason: messageOf(error) });
    return DEFAULT_INTENT;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn('order.classify_unparseable', { raw });
    return DEFAULT_INTENT;
  }

  const result = intentSchema.safeParse((parsed as { intent?: unknown }).intent);
  if (!result.success) {
    logger.warn('order.classify_invalid', { raw });
    return DEFAULT_INTENT;
  }
  return result.data;
}
