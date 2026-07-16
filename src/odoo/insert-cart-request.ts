import type { LineId, PosConfigId, ProductTmplId, PtavId, RestaurantTableId } from '../shared/types.js';

/** One line of the insert request (SPEC § API contract). */
export interface RequestLine {
  line_id: LineId;
  product_tmpl_id: ProductTmplId;
  quantity: number;
  ptav_ids?: PtavId[];
}

/** Body of POST /goopter_cart_api/v1/cart (SPEC § API contract). */
export interface InsertCartRequest {
  cart_id: string;
  pos_config_id: PosConfigId;
  items: RequestLine[];
  table_id?: RestaurantTableId;
}
