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
  /** Armed on speech activity; auto-fires voice.stop when no new partial arrives (customer stopped talking). */
  stopTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last partial text seen — gates stopTimer resets to real speech progress (ignores keepalive/repeat partials). */
  lastPartialText = '';
  /** Audio that arrived before the STT stream finished connecting; flushed in order once it opens. */
  pendingAudio: Buffer[] = [];

  constructor(
    readonly session_id: SessionId,
    readonly cart_id: CartId,
    readonly pos_config_id: PosConfigId,
  ) {}

  /** Terminal states accept no more audio or finals and never revive (§11). */
  get isTerminal(): boolean {
    return this.status === 'ended' || this.status === 'failed' || this.status === 'interrupted';
  }
}
