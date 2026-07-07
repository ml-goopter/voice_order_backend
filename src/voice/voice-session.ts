import type { CartId, PosConfigId, SessionId } from '../shared/types.js';
import type { SttStream } from '../stt/stt-types.js';

export type VoiceSessionStatus = 'idle' | 'listening' | 'interrupted' | 'ended' | 'failed';

/** In-memory state for one voice session (design §5). */
export class VoiceSession {
  status: VoiceSessionStatus = 'idle';
  stream: SttStream | null = null;

  constructor(
    readonly session_id: SessionId,
    readonly cart_id: CartId,
    readonly pos_config_id: PosConfigId,
  ) {}
}
