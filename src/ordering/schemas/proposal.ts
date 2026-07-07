import type { CartId, PosConfigId, RequestId } from '../../shared/types.js';
import type { CartOperation } from './cart-operation.schema.js';

/**
 * What Order Understanding hands the Cart Module: a batch of operations plus the
 * `base_version` they were computed against, so the Cart Module can detect a moved
 * cart and rebase (design §9, Tier 2).
 */
export interface OrderProposal {
  request_id: RequestId;
  cart_id: CartId;
  pos_config_id: PosConfigId;
  base_version: number;
  operations: CartOperation[];
}
