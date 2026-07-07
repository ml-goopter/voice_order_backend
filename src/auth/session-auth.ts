import type { Result } from '../shared/result.js';
import { err, ok } from '../shared/result.js';
import { AppError } from '../shared/errors.js';
import type { AuthContext } from './auth-types.js';

/**
 * Authenticate a connecting client and resolve its session/cart/POS (design §4).
 * Stub: trusts query params. TODO: verify a signed token; look up the table's POS.
 */
export function authenticate(params: {
  token?: string;
  session_id?: string;
  cart_id?: string;
  pos_config_id?: number;
}): Result<AuthContext> {
  if (!params.session_id || !params.cart_id || params.pos_config_id === undefined) {
    return err(new AppError('unauthenticated', 'missing session_id / cart_id / pos_config_id'));
  }
  return ok({
    session_id: params.session_id,
    cart_id: params.cart_id,
    pos_config_id: params.pos_config_id,
  });
}
