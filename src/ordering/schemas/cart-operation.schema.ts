/**
 * Proposed cart operations — the LLM output contract (design §8).
 *
 * The LLM speaks in catalog KEYS (menu_item_key / modifier_key); the Menu module
 * maps those to Odoo ids (product_tmpl_id / ptav_id) and the Cart Module resolves
 * them on apply. Edits target a stable `line_id`; only `add_item` omits it.
 *
 * These hand-written validators keep the scaffold dependency-free. TODO: replace
 * with zod (`npm i zod`) for richer errors — keep the same exported types.
 */
import type { LineId } from '../../shared/types.js';
import type { Result } from '../../shared/result.js';
import { err, ok } from '../../shared/result.js';
import { ValidationError } from '../../shared/errors.js';

export type OperationAction =
  | 'add_item'
  | 'remove_item'
  | 'update_quantity'
  | 'add_modifier'
  | 'remove_modifier';

export interface OpModifierRef {
  modifier_key: string;
}

export interface AddItemOp {
  action: 'add_item';
  menu_item_key: string;
  quantity: number;
  modifiers: OpModifierRef[];
}
export interface RemoveItemOp {
  action: 'remove_item';
  line_id: LineId;
}
export interface UpdateQuantityOp {
  action: 'update_quantity';
  line_id: LineId;
  quantity: number;
}
export interface AddModifierOp {
  action: 'add_modifier';
  line_id: LineId;
  modifier_key: string;
}
export interface RemoveModifierOp {
  action: 'remove_modifier';
  line_id: LineId;
  modifier_key: string;
}

export type CartOperation =
  | AddItemOp
  | RemoveItemOp
  | UpdateQuantityOp
  | AddModifierOp
  | RemoveModifierOp;

// ── Runtime validation ────────────────────────────────────────────────────────

function isRecord(u: unknown): u is Record<string, unknown> {
  return typeof u === 'object' && u !== null;
}

function parseModifiers(u: unknown): OpModifierRef[] {
  if (!Array.isArray(u)) return [];
  const out: OpModifierRef[] = [];
  for (const m of u) {
    if (isRecord(m) && typeof m['modifier_key'] === 'string') {
      out.push({ modifier_key: m['modifier_key'] });
    }
  }
  return out;
}

export function parseCartOperation(u: unknown): Result<CartOperation> {
  if (!isRecord(u) || typeof u['action'] !== 'string') {
    return err(new ValidationError('operation must be an object with an "action"'));
  }
  const action = u['action'];
  switch (action) {
    case 'add_item': {
      if (typeof u['menu_item_key'] !== 'string' || typeof u['quantity'] !== 'number') {
        return err(new ValidationError('add_item requires menu_item_key and quantity'));
      }
      return ok({
        action: 'add_item',
        menu_item_key: u['menu_item_key'],
        quantity: u['quantity'],
        modifiers: parseModifiers(u['modifiers']),
      });
    }
    case 'remove_item': {
      if (typeof u['line_id'] !== 'string') return err(new ValidationError('remove_item requires line_id'));
      return ok({ action: 'remove_item', line_id: u['line_id'] });
    }
    case 'update_quantity': {
      if (typeof u['line_id'] !== 'string' || typeof u['quantity'] !== 'number') {
        return err(new ValidationError('update_quantity requires line_id and quantity'));
      }
      return ok({ action: 'update_quantity', line_id: u['line_id'], quantity: u['quantity'] });
    }
    case 'add_modifier':
    case 'remove_modifier': {
      if (typeof u['line_id'] !== 'string' || typeof u['modifier_key'] !== 'string') {
        return err(new ValidationError(`${action} requires line_id and modifier_key`));
      }
      return ok({ action, line_id: u['line_id'], modifier_key: u['modifier_key'] });
    }
    default:
      return err(new ValidationError(`unknown action "${action}"`));
  }
}
