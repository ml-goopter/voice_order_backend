/** LangGraph output: proposed operations, or a clarification request (design §8). */
import { z } from 'zod';
import { cartOperationSchema } from './cart-operation.schema.js';
import type { CartOperation } from './cart-operation.schema.js';
import type { Result } from '../../shared/result.js';
import { err, ok } from '../../shared/result.js';
import { ValidationError } from '../../shared/errors.js';
import { formatZodError } from './zod-error.js';

const outputSchema = z
  .object({
    operations: z.array(cartOperationSchema).default([]),
    needs_clarification: z.boolean().default(false),
    clarification_question: z.string().nullable().default(null),
    clarification_options: z.array(z.string()).optional(),
  })
  .refine((o) => !o.needs_clarification || o.clarification_question !== null, {
    message: 'needs_clarification=true requires a clarification_question',
    path: ['clarification_question'],
  });

export interface OrderGraphOutput {
  operations: CartOperation[];
  needs_clarification: boolean;
  clarification_question: string | null;
  clarification_options?: string[];
}

export function parseOrderGraphOutput(u: unknown): Result<OrderGraphOutput> {
  const r = outputSchema.safeParse(u);
  if (!r.success) return err(new ValidationError(formatZodError(r.error)));
  const { operations, needs_clarification, clarification_question, clarification_options } = r.data;
  return ok(
    clarification_options === undefined
      ? { operations, needs_clarification, clarification_question }
      : { operations, needs_clarification, clarification_question, clarification_options },
  );
}
