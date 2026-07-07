import type { Result } from '../../shared/result.js';
import { err } from '../../shared/result.js';
import { ValidationError } from '../../shared/errors.js';
import type { OrderGraphOutput } from '../schemas/order-graph-output.schema.js';
import { parseOrderGraphOutput } from '../schemas/order-graph-output.schema.js';

/**
 * Validate structured output (design §8/§11.3). Schema check here; business rules
 * (key exists, item available, modifier valid) are enforced by the Cart Validator.
 * TODO: on schema failure, retry once with a repair prompt (§11.3 stage 2/3).
 */
export function validateOperations(raw: string): Result<OrderGraphOutput> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err(new ValidationError('LLM output was not valid JSON'));
  }
  return parseOrderGraphOutput(parsed);
}
