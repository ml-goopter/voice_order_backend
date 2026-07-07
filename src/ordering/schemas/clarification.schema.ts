import type { CartId, RequestId, SessionId } from '../../shared/types.js';

/** A clarification turn raised by Order Understanding (design §6). */
export interface Clarification {
  cart_id: CartId;
  session_id: SessionId;
  request_id: RequestId;
  question: string;
  options?: string[];
}
