import type { CartId, PosConfigId, SessionId } from '../shared/types.js';
import type { OutboundMessage } from './realtime-message-types.js';

/** One live client socket. The transport (ws) implements `send`/`close`. */
export interface ClientConnection {
  readonly session_id: SessionId;
  readonly cart_id: CartId;
  readonly pos_config_id: PosConfigId; // resolved at auth time
  send(msg: OutboundMessage): void;
  close(): void;
  isAlive(): boolean;
}

/**
 * Tracks connected clients by session and cart. A cart may have several sockets
 * (multi-device / reconnect), so cart.updated broadcasts to all of them (§9 Tier 2).
 */
export class ClientRegistry {
  private readonly bySession = new Map<SessionId, ClientConnection>();
  private readonly byCart = new Map<CartId, Set<ClientConnection>>();

  add(conn: ClientConnection): void {
    this.bySession.set(conn.session_id, conn);
    let set = this.byCart.get(conn.cart_id);
    if (!set) {
      set = new Set();
      this.byCart.set(conn.cart_id, set);
    }
    set.add(conn);
  }

  remove(conn: ClientConnection): void {
    this.bySession.delete(conn.session_id);
    const set = this.byCart.get(conn.cart_id);
    if (set) {
      set.delete(conn);
      if (set.size === 0) this.byCart.delete(conn.cart_id);
    }
  }

  getBySession(session_id: SessionId): ClientConnection | undefined {
    return this.bySession.get(session_id);
  }

  getByCart(cart_id: CartId): ClientConnection[] {
    const set = this.byCart.get(cart_id);
    return set ? [...set] : [];
  }
}
