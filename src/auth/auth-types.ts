import type { CartId, PosConfigId, SessionId } from '../shared/types.js';

/** Identity resolved when a WebSocket connects (design §4). */
export interface AuthContext {
  session_id: SessionId;
  cart_id: CartId;
  pos_config_id: PosConfigId;
}
