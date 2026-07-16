import type { CartId, DeviceId, PosConfigId, RestaurantTableId, SessionId } from '../shared/types.js';

/** Identity resolved when a WebSocket connects (design §4). */
export interface AuthContext {
  session_id: SessionId;
  cart_id: CartId;
  pos_config_id: PosConfigId;
  device_id: DeviceId;
  /** restaurant_table.id — dine-in only. Absent = takeout/untabled. */
  table_id?: RestaurantTableId;
}
