import type { LlmProvider } from '../../llm/llm-provider.js';
import type { OrderGraphInput } from '../schemas/order-graph-input.schema.js';
import type { OrderGraphOutput } from '../schemas/order-graph-output.schema.js';
import { buildRepairPrompt } from '../../llm/prompt-builder.js';
import { parseOrder } from './parse-order.node.js';
import { validateOperations } from './validate-operations.node.js';
import { logger } from '../../config/logger.js';

/**
 * Parse the transcript into structured output, with up to `maxRepairs` schema-repair
 * retries (design §11.3 stages 2/3). Each retry re-prompts the model with its rejected
 * output plus the validation error. Throws the last ValidationError if still invalid —
 * the graph node lets it propagate so invoke() rejects and the turn fails gracefully.
 */
export async function parseAndValidate(
  llm: LlmProvider,
  input: OrderGraphInput,
  maxRepairs: number,
): Promise<OrderGraphOutput> {
  let raw = await parseOrder(llm, input);

  for (let attempt = 0; ; attempt += 1) {
    const validated = validateOperations(raw);
    if (validated.ok) return validated.value;

    if (attempt >= maxRepairs) {
      logger.warn('order.schema_repair_exhausted', {
        request_id: input.request_id,
        error: validated.error.message,
      });
      throw validated.error;
    }

    logger.info('order.schema_repair_retry', {
      request_id: input.request_id,
      attempt: attempt + 1,
      error: validated.error.message,
    });
    raw = await llm.complete(buildRepairPrompt(input, raw, validated.error.message));
  }
}
