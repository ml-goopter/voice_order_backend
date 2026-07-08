import { createServer, type IncomingMessage, type Server } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { RealtimeGateway } from './realtime-gateway.js';
import type { ClientConnection } from './client-registry.js';
import type { OutboundMessage } from './realtime-message-types.js';
import { authenticate } from '../auth/session-auth.js';
import { healthCheck } from '../api/health.routes.js';
import { TIMEOUTS } from '../config/constants.js';
import { logger } from '../config/logger.js';

export interface WebSocketServerHandle {
  /** The underlying HTTP server (also serves `/health`); exposed for tests/shutdown. */
  readonly server: Server;
  close(): void;
}

/** Close codes (4000-4999 = application-defined per the WS spec). */
const CLOSE_UNAUTHENTICATED = 4001;

/**
 * Real `ws` transport (design §4). Attaches a WebSocket server (path `/ws`) to an
 * HTTP server that also answers `GET /health`. For each socket it authenticates,
 * adapts it to a `ClientConnection`, forwards messages/close to the gateway, and
 * runs heartbeat ping/pong (§3/§11.1). It owns transport only — no cart logic.
 */
export function startWebSocketServer(gateway: RealtimeGateway, port: number): WebSocketServerHandle {
  const http = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(healthCheck()));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server: http, path: '/ws' });

  // Track liveness per socket so the heartbeat can terminate dead connections.
  const alive = new WeakMap<WebSocket, boolean>();

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    // Attach before auth so even rejected sockets are covered: an unhandled
    // 'error' on a ws socket (e.g. a TCP reset mid-close) is an uncaught throw.
    let session_id: string | undefined;
    socket.on('error', (err) => logger.warn('ws.socket_error', { session_id, error: err.message }));

    const auth = authenticate(paramsFromUrl(req.url));
    if (!auth.ok) {
      logger.warn('ws.auth_failed', { message: auth.error.message });
      socket.close(CLOSE_UNAUTHENTICATED, 'unauthenticated');
      return;
    }

    const { cart_id, pos_config_id } = auth.value;
    session_id = auth.value.session_id;
    const conn: ClientConnection = {
      session_id,
      cart_id,
      pos_config_id,
      send(msg: OutboundMessage) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
      },
      close() {
        socket.close();
      },
      isAlive() {
        return alive.get(socket) ?? false;
      },
    };

    alive.set(socket, true);
    gateway.onConnect(conn);

    socket.on('message', (data: RawData) => {
      // A downstream rejection (STT open failure, cart-cache error) must not
      // float unhandled — that would crash the process and kill every session.
      gateway.onRawMessage(conn, data.toString()).catch((err: unknown) => {
        logger.warn('ws.message_error', {
          session_id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
    socket.on('pong', () => alive.set(socket, true));
    socket.on('close', () => gateway.onDisconnect(conn));
  });

  // Heartbeat: miss one ping → terminate. Interval + client turnaround covers
  // heartbeatTimeoutMs (§11.1); a live client answers well within the window.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (alive.get(socket) === false) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      socket.ping();
    }
  }, TIMEOUTS.heartbeatIntervalMs);
  heartbeat.unref?.();

  http.listen(port, () => logger.info('ws.listening', { port, path: '/ws' }));

  return {
    server: http,
    close() {
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      http.close();
    },
  };
}

/** Auth params ride on the upgrade URL query string (matches the auth stub). */
function paramsFromUrl(url: string | undefined): {
  token?: string;
  session_id?: string;
  cart_id?: string;
  pos_config_id?: number;
} {
  const q = new URL(url ?? '/', 'http://localhost').searchParams;
  const pos = q.get('pos_config_id');
  const posNum = pos === null ? undefined : Number.parseInt(pos, 10);
  return {
    ...(q.get('token') !== null ? { token: q.get('token') as string } : {}),
    ...(q.get('session_id') !== null ? { session_id: q.get('session_id') as string } : {}),
    ...(q.get('cart_id') !== null ? { cart_id: q.get('cart_id') as string } : {}),
    ...(posNum !== undefined && !Number.isNaN(posNum) ? { pos_config_id: posNum } : {}),
  };
}
