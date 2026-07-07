import { randomUUID } from 'node:crypto';
import type { CartId, LineId, RequestId, SessionId } from './types.js';

export const newCartId = (): CartId => `cart_${randomUUID()}`;
export const newSessionId = (): SessionId => `voice_session_${randomUUID()}`;
export const newRequestId = (): RequestId => `voice_final_${randomUUID()}`;
export const newLineId = (): LineId => `ln_${randomUUID().slice(0, 8)}`;
