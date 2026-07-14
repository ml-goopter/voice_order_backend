import type { EventBus } from '../events/event-bus.js';
import type { CartCache } from '../redis/cart-cache.js';
import type { VoiceMessageHandler } from '../voice/voice-message-handler.js';
import type { TtsService } from '../tts/tts-service.js';
import { ClientRegistry, type ClientConnection } from './client-registry.js';
import { MessageRouter } from './message-router.js';
import { parseInbound, type ConnectionResumeMsg } from './realtime-message-types.js';
import { emptyCart } from '../cart/cart-types.js';
import { logger } from '../config/logger.js';

/**
 * Owns the WebSocket-facing side (design §4). Routes inbound messages, pushes
 * backend events (partials handled in Voice; cart/clarification/errors here) to the
 * right sockets, and handles reconnect. It does NOT own cart logic.
 */
export class RealtimeGateway {
  readonly registry = new ClientRegistry();
  private readonly router: MessageRouter;

  constructor(
    private readonly bus: EventBus,
    private readonly voice: VoiceMessageHandler,
    private readonly carts: CartCache,
    private readonly tts: TtsService,
  ) {
    this.router = new MessageRouter(voice);
    this.subscribe();
  }

  /** Push backend events out to connected clients. */
  private subscribe(): void {
    this.bus.on('cart.updated', (e) => {
      // Broadcast to every socket on the cart (multi-device / reconnect, §9 Tier 2).
      for (const c of this.registry.getByCart(e.cart_id)) {
        c.send({ type: 'cart.updated', cart_id: e.cart_id, version: e.version, cart: e.cart });
      }
    });

    this.bus.on('order.reply', (e) => {
      const c = this.registry.getBySession(e.session_id);
      if (!c) return;
      c.send({
        type: 'order.reply',
        cart_id: e.cart_id,
        request_id: e.request_id,
        reply: e.reply,
      });
      // Speak the reply: synthesize with TTS and stream the audio back over the same socket. The
      // detected language lets a multilingual voice speak it in the customer's language.
      this.tts.speak(c, { session_id: e.session_id, request_id: e.request_id }, e.reply, e.language);
    });

    this.bus.on('cart.operation_rejected', (e) => {
      const targets = e.session_id
        ? [this.registry.getBySession(e.session_id)].filter((c): c is ClientConnection => c !== undefined)
        : this.registry.getByCart(e.cart_id);
      for (const c of targets) {
        c.send({
          type: 'cart.operation_rejected',
          cart_id: e.cart_id,
          request_id: e.request_id,
          reason: e.reason,
          message: e.message,
        });
      }
    });
  }

  onConnect(conn: ClientConnection): void {
    this.registry.add(conn);
    logger.info('ws.connect', { session_id: conn.session_id, cart_id: conn.cart_id });
  }

  onDisconnect(conn: ClientConnection): void {
    this.registry.remove(conn);
    this.voice.handleDisconnect(conn.session_id);
    this.tts.cancel(conn.session_id);
    logger.info('ws.disconnect', { session_id: conn.session_id });
  }

  async onRawMessage(conn: ClientConnection, raw: string): Promise<void> {
    const msg = parseInbound(raw);
    if (!msg) {
      conn.send({ type: 'voice.error', session_id: conn.session_id, reason: 'bad_message', message: 'Unrecognized message.' });
      return;
    }
    if (msg.type === 'connection.resume') {
      await this.handleResume(conn, msg);
      return;
    }
    await this.router.route(conn, msg);
  }

  /** Reconnect: return a fresh cart snapshot (design §3 resume response). */
  private async handleResume(conn: ClientConnection, msg: ConnectionResumeMsg): Promise<void> {
    const cart = (await this.carts.get(msg.cart_id)) ?? emptyCart(msg.cart_id, conn.pos_config_id);
    conn.send({
      type: 'connection.resumed',
      session_id: msg.session_id,
      cart_id: msg.cart_id,
      cart_version: cart.version,
      cart,
      voice_session_status: 'idle',
    });
  }
}
