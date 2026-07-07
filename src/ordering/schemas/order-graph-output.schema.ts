/** LangGraph output: proposed operations, or a clarification request (design §8). */
import type { CartOperation } from './cart-operation.schema.js';
import { parseCartOperation } from './cart-operation.schema.js';
import type { Result } from '../../shared/result.js';
import { err, ok } from '../../shared/result.js';
import { ValidationError } from '../../shared/errors.js';

export interface OrderGraphOutput {
  operations: CartOperation[];
  needs_clarification: boolean;
  clarification_question: string | null;
  clarification_options?: string[];
}

export function parseOrderGraphOutput(u: unknown): Result<OrderGraphOutput> {
  if (typeof u !== 'object' || u === null) {
    return err(new ValidationError('output must be an object'));
  }
  const rec = u as Record<string, unknown>;
  const rawOps = Array.isArray(rec['operations']) ? rec['operations'] : [];
  const operations: CartOperation[] = [];
  for (const raw of rawOps) {
    const parsed = parseCartOperation(raw);
    if (!parsed.ok) return parsed;
    operations.push(parsed.value);
  }

  const needs = rec['needs_clarification'] === true;
  const question = typeof rec['clarification_question'] === 'string' ? rec['clarification_question'] : null;
  if (needs && question === null) {
    return err(new ValidationError('needs_clarification=true requires a clarification_question'));
  }

  const options = Array.isArray(rec['clarification_options'])
    ? rec['clarification_options'].filter((o): o is string => typeof o === 'string')
    : undefined;

  return ok(
    options === undefined
      ? { operations, needs_clarification: needs, clarification_question: question }
      : { operations, needs_clarification: needs, clarification_question: question, clarification_options: options },
  );
}
