import type { RealtimeGateway } from './realtime-gateway.js';
import { logger } from '../config/logger.js';

export interface WebSocketServerHandle {
  close(): void;
}

/**
 * Transport bootstrap. Stubbed so the app starts without the `ws` dependency.
 *
 * TODO: `npm i ws`. For each accepted socket:
 *   1. authenticate → resolve { session_id, cart_id, pos_config_id } (see auth/)
 *   2. build a ClientConnection wrapping socket.send / socket.close
 *   3. gateway.onConnect(conn)
 *   4. socket.on('message', (data) => gateway.onRawMessage(conn, data.toString()))
 *   5. socket.on('close',  () => gateway.onDisconnect(conn))
 *   6. heartbeat ping/pong per TIMEOUTS.heartbeat* (design §3/§11.1)
 */
export function startWebSocketServer(gateway: RealtimeGateway, port: number): WebSocketServerHandle {
  void gateway;
  logger.warn('ws.stub_server', { port, hint: 'wire the ws server (see TODO in websocket-server.ts)' });
  return { close: () => undefined };
}
