import type { SessionId } from '../shared/types.js';
import { VoiceSession } from './voice-session.js';

/** Tracks live voice sessions (design §5). */
export class VoiceSessionManager {
  private readonly sessions = new Map<SessionId, VoiceSession>();

  get(session_id: SessionId): VoiceSession | undefined {
    return this.sessions.get(session_id);
  }

  create(session: VoiceSession): VoiceSession {
    this.sessions.set(session.session_id, session);
    return session;
  }

  remove(session_id: SessionId): void {
    const s = this.sessions.get(session_id);
    if (s?.stream) s.stream.close();
    this.sessions.delete(session_id);
  }
}
