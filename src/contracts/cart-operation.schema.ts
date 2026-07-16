/**
 * Proposed cart operations — the LLM output contract (design §8).
 *
 * The LLM speaks in catalog KEYS (menu_item_key / modifier_key); the Menu module
 * maps those to Odoo ids (product_tmpl_id / ptav_id) and the Cart Module resolves
 * them on apply. Edits target a stable `line_id`; only `add_item` omits it.
 *
 * Validated with zod; the exported TS types are inferred from the schemas so there
 * is a single source of truth. `parseCartOperation` keeps a Result-returning shape
 * so callers stay throw-free and get a repair-friendly error message (§11.3).
 */
import { z } from 'zod';
import type { Result } from '../shared/result.js';
import { err, ok } from '../shared/result.js';
import { ValidationError } from '../shared/errors.js';
import { formatZodError } from '../shared/zod-error.js';

const modifierRef = z.object({ modifier_key: z.string().min(1) });

const addItem = z.object({
  action: z.literal('add_item'),
  menu_item_key: z.string().min(1),
  quantity: z.number().int().positive(),
  modifiers: z.array(modifierRef).default([]),
});
const removeItem = z.object({
  action: z.literal('remove_item'),
  line_id: z.string().min(1),
});
const updateQuantity = z.object({
  action: z.literal('update_quantity'),
  line_id: z.string().min(1),
  quantity: z.number().int().positive(),
});
const addModifier = z.object({
  action: z.literal('add_modifier'),
  line_id: z.string().min(1),
  modifier_key: z.string().min(1),
});
const removeModifier = z.object({
  action: z.literal('remove_modifier'),
  line_id: z.string().min(1),
  modifier_key: z.string().min(1),
});

export const cartOperationSchema = z.discriminatedUnion('action', [
  addItem,
  removeItem,
  updateQuantity,
  addModifier,
  removeModifier,
]);

export type OpModifierRef = z.infer<typeof modifierRef>;
export type AddItemOp = z.infer<typeof addItem>;
export type RemoveItemOp = z.infer<typeof removeItem>;
export type UpdateQuantityOp = z.infer<typeof updateQuantity>;
export type AddModifierOp = z.infer<typeof addModifier>;
export type RemoveModifierOp = z.infer<typeof removeModifier>;
export type CartOperation = z.infer<typeof cartOperationSchema>;

export function parseCartOperation(u: unknown): Result<CartOperation> {
  const r = cartOperationSchema.safeParse(u);
  return r.success ? ok(r.data) : err(new ValidationError(formatZodError(r.error)));
}
