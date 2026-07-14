/** The `propose_cart` tool's validated output: the operations to apply (docs/agent-tools.md §3).
 *  Clarifications/recommendations are no longer part of this contract — the agent expresses those
 *  by ending the turn with a spoken reply, not a proposal. */
import { z } from 'zod';
import { cartOperationSchema } from './cart-operation.schema.js';
import type { CartOperation } from './cart-operation.schema.js';
import type { Result } from '../../shared/result.js';
import { err, ok } from '../../shared/result.js';
import { ValidationError } from '../../shared/errors.js';
import { formatZodError } from './zod-error.js';

const outputSchema = z.object({
  operations: z.array(cartOperationSchema).default([]),
});

export interface OrderGraphOutput {
  operations: CartOperation[];
}

export function parseOrderGraphOutput(u: unknown): Result<OrderGraphOutput> {
  const r = outputSchema.safeParse(u);
  if (!r.success) return err(new ValidationError(formatZodError(r.error)));
  return ok({ operations: r.data.operations });
}
