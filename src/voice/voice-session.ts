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
  /** Set once the session has been retired (removed from the registry or superseded by a newer
   *  voice.start). A retired session is unreachable, so it must never hold a live STT stream. */
  private retired = false;

  constructor(
    readonly session_id: SessionId,
    readonly cart_id: CartId,
    readonly pos_config_id: PosConfigId,
  ) {}

  /** Terminal states accept no more audio or finals and never revive (§11). A retired session is
   *  terminal too: its stream is closed and nothing may reach the cart through it. */
  get isTerminal(): boolean {
    return this.retired || this.status === 'ended' || this.status === 'failed' || this.status === 'interrupted';
  }

  /**
   * Hand the session the stream whose connect just resolved. Returns false when the session was
   * retired mid-handshake (a concurrent voice.start or a disconnect), in which case the stream is
   * closed here rather than stored: nothing can reach a retired session to close it later, and an
   * unclosed STT stream holds a rate-limiter permit that never comes back.
   */
  attachStream(stream: SttStream): boolean {
    if (this.retired) {
      stream.close();
      return false;
    }
    this.stream = stream;
    return true;
  }

  /** Close the STT stream and bar any still-connecting one from being attached. Idempotent. */
  retire(): void {
    if (this.retired) return;
    this.retired = true;
    this.stream?.close();
  }
}
