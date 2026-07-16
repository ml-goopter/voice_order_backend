import type { PosConfigId } from '../shared/types.js';
import type { Result } from '../shared/result.js';
import { ok } from '../shared/result.js';
import type { CartRejectedError } from '../shared/errors.js';
import type { MenuLookup } from '../menu/menu-service.js';
import type { Cart } from './cart-types.js';
import type { CartOperation } from '../contracts/cart-operation.schema.js';
import { applyOperation } from './cart-operation-applier.js';

/**
 * Cart Validator (design §9). Business-rule checks: item exists/available, modifier
 * valid for the item, quantity valid, edit target line_id exists. Implemented as a
 * dry-run of the applier so validation and application never drift.
 */
export async function validateOperation(
  cart: Cart,
  op: CartOperation,
  menu: MenuLookup,
  pos: PosConfigId,
): Promise<Result<void, CartRejectedError>> {
  const r = await applyOperation(cart, op, menu, pos);
  return r.ok ? ok(undefined) : r;
}
