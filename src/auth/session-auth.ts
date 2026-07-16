import type { Result } from '../shared/result.js';
import { err, ok } from '../shared/result.js';
import { AppError } from '../shared/errors.js';
import type { AuthContext } from './auth-types.js';

/**
 * Authenticate a connecting client and resolve its session/cart/POS (design §4).
 * Stub: trusts query params. TODO: verify a signed token; look up the table's POS.
 * `device_id` and `table_id` are as unauthenticated as `cart_id` — they identify a
 * cart, they do not authorize access to it.
 */
export function authenticate(params: {
  token?: string;
  session_id?: string;
  cart_id?: string;
  pos_config_id?: number;
  device_id?: string;
  table_id?: number;
}): Result<AuthContext> {
  if (!params.session_id || !params.cart_id || params.pos_config_id === undefined || !params.device_id) {
    return err(
      new AppError('unauthenticated', 'missing session_id / cart_id / pos_config_id / device_id'),
    );
  }
  // table_id stays optional: absent means takeout/untabled, which is a valid order.
  return ok({
    session_id: params.session_id,
    cart_id: params.cart_id,
    pos_config_id: params.pos_config_id,
    device_id: params.device_id,
    ...(params.table_id !== undefined ? { table_id: params.table_id } : {}),
  });
}
