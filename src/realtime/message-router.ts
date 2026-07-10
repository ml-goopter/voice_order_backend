import type { VoiceMessageHandler } from '../voice/voice-message-handler.js';
import type { ClientConnection } from './client-registry.js';
import type { InboundMessage } from './realtime-message-types.js';

/** Routes inbound voice.* messages to their owning module (design §4). */
export class MessageRouter {
  constructor(private readonly voice: VoiceMessageHandler) {}

  async route(conn: ClientConnection, msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case 'voice.start':
        await this.voice.handleStart(conn, msg);
        return;
      case 'voice.audio_chunk':
        this.voice.handleAudioChunk(conn, msg);
        return;
      case 'voice.stop':
        await this.voice.handleStop(conn, msg);
        return;
      case 'connection.resume':
        // Handled by the gateway (needs the cart cache); no-op here.
        return;
    }
  }
}
