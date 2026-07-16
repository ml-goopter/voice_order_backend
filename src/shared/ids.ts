import { randomUUID } from 'node:crypto';
import type { LineId, RequestId } from './types.js';

export const newRequestId = (): RequestId => `voice_final_${randomUUID()}`;
export const newLineId = (): LineId => `ln_${randomUUID().slice(0, 8)}`;
