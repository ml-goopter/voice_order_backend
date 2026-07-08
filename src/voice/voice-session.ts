import type { CartId, PosConfigId, SessionId } from '../shared/types.js';
import type { SttStream } from '../stt/stt-types.js';

export type VoiceSessionStatus = 'idle' | 'listening' | 'interrupted' | 'ended' | 'failed';

/** In-memory state for one voice session (design §5). */
export class VoiceSession {
  status: VoiceSessionStatus = 'idle';
  stream: SttStream | null = null;
  /** True once any final transcript arrived — gates the §11.2 C stop timeout. */
  finalReceived = false;
  /** Set the moment voice.stop is committed; stops forwarding audio into a flushing stream. */
  stopping = false;
  /** Armed after voice.stop while awaiting a final (§11.2 C); cleared on final/disconnect. */
  finalTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly session_id: SessionId,
    readonly cart_id: CartId,
    readonly pos_config_id: PosConfigId,
  ) {}
}
