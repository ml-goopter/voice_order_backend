import type { EventBus } from '../events/event-bus.js';
import type { VoiceMessageHandler } from '../voice/voice-message-handler.js';
import type { ClientConnection } from './client-registry.js';
import type { InboundMessage } from './realtime-message-types.js';

/** Routes inbound voice.* / order.* messages to their owning module (design §4). */
export class MessageRouter {
  constructor(
    private readonly voice: VoiceMessageHandler,
    private readonly bus: EventBus,
  ) {}

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
      case 'order.clarification_answered':
        // Resume the LangGraph turn (design §6). Ordering module handles the event.
        this.bus.emit('order.clarification_answered', {
          cart_id: msg.cart_id,
          session_id: msg.session_id,
          request_id: msg.request_id,
          answer: msg.answer,
        });
        return;
      case 'connection.resume':
        // Handled by the gateway (needs the cart cache); no-op here.
        return;
    }
  }
}
