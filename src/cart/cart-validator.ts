import type { PosConfigId } from '../shared/types.js';
import type { Result } from '../shared/result.js';
import { ok } from '../shared/result.js';
import type { MenuService } from '../menu/menu-service.js';
import type { Cart } from './cart-types.js';
import type { CartOperation } from '../ordering/schemas/cart-operation.schema.js';
import { applyOperation } from './cart-operation-applier.js';

/**
 * Cart Validator (design §9). Business-rule checks: item exists/available, modifier
 * valid for the item, quantity valid, edit target line_id exists. Implemented as a
 * dry-run of the applier so validation and application never drift.
 */
export function validateOperation(
  cart: Cart,
  op: CartOperation,
  menu: MenuService,
  pos: PosConfigId,
): Result<void> {
  const r = applyOperation(cart, op, menu, pos);
  return r.ok ? ok(undefined) : r;
}
