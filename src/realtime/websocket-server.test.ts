import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { startWebSocketServer, type WebSocketServerHandle } from './websocket-server.js';
import { RealtimeGateway } from './realtime-gateway.js';
import { createHttpRouter } from '../api/http-router.js';
import type { CartController } from '../cart/cart-controller.js';
import { EventBus } from '../events/event-bus.js';
import { InMemoryCartCache } from '../redis/cart-cache.js';
import { VoiceSessionManager } from '../voice/voice-session-manager.js';
import { VoiceMessageHandler } from '../voice/voice-message-handler.js';
import { TtsService } from '../tts/tts-service.js';
import { createTtsProvider } from '../tts/tts-client.js';
import type { SttProvider } from '../stt/stt-provider.js';
import type { SttStream, SttStreamHandlers } from '../stt/stt-types.js';
import type { OdooImageClient } from '../odoo/odoo-image-client.js';

/** No-op STT so the Voice handler can be constructed; these tests only exercise transport. */
class NoopSttProvider implements SttProvider {
  readonly name = 'noop';
  async openStream(_handlers: SttStreamHandlers): Promise<SttStream> {
    return { sendAudio: () => undefined, stop: async () => undefined, close: () => undefined };
  }
}

function buildGateway(): RealtimeGateway {
  const bus = new EventBus();
  const voice = new VoiceMessageHandler(new VoiceSessionManager(), new NoopSttProvider(), bus);
  return new RealtimeGateway(bus, voice, new InMemoryCartCache(), new TtsService(createTtsProvider()));
}

/** Gateway whose message handling always rejects, to exercise the transport's `.catch`. */
class RejectingGateway extends RealtimeGateway {
  override async onRawMessage(): Promise<void> {
    throw new Error('boom');
  }
}

function buildRejectingGateway(): RejectingGateway {
  const bus = new EventBus();
  const voice = new VoiceMessageHandler(new VoiceSessionManager(), new NoopSttProvider(), bus);
  return new RejectingGateway(bus, voice, new InMemoryCartCache(), new TtsService(createTtsProvider()));
}

/**
 * These tests exercise transport only, so neither the controller nor the image client is ever
 * reached: /health short-circuits before them and their routes are covered in
 * api/http-router.test.ts. It exists here so the server keeps serving /health on the same port.
 */
function buildRouter() {
  return createHttpRouter({} as CartController, {} as OdooImageClient);
}

/** Resolve once the server is listening, returning its assigned ephemeral port. */
function listeningPort(handle: WebSocketServerHandle): Promise<number> {
  return new Promise((resolve) => {
    const addr = handle.server.address();
    if (addr && typeof addr === 'object') return resolve((addr as AddressInfo).port);
    handle.server.once('listening', () => resolve((handle.server.address() as AddressInfo).port));
  });
}

function open(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    ws.once('error', reject);
  });
}

describe('startWebSocketServer', () => {
  let handle: WebSocketServerHandle;
  let port: number;

  beforeEach(async () => {
    handle = startWebSocketServer(buildGateway(), 0, buildRouter()); // port 0 → OS-assigned ephemeral port
    port = await listeningPort(handle);
  });

  afterEach(() => handle.close());

  it('authenticates via query params and round-trips a connection.resume', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?session_id=s1&cart_id=c1&pos_config_id=7&device_id=d1`);
    await open(ws);
    ws.send(JSON.stringify({ type: 'connection.resume', session_id: 's1', cart_id: 'c1', last_seen_cart_version: 0 }));
    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({ type: 'connection.resumed', session_id: 's1', cart_id: 'c1', voice_session_status: 'idle' });
    ws.close();
  });

  it('rejects a connection missing auth params with close code 4001', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?session_id=s1`); // no cart_id / pos_config_id
    const code = await new Promise<number>((resolve) => ws.once('close', (c) => resolve(c)));
    expect(code).toBe(4001);
  });

  it('replies with voice.error bad_message on a malformed frame', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?session_id=s2&cart_id=c2&pos_config_id=7&device_id=d2`);
    await open(ws);
    ws.send('not json');
    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({ type: 'voice.error', reason: 'bad_message' });
    ws.close();
  });

  it('serves GET /health on the same port', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('survives a rejecting message handler without crashing', async () => {
    const rejecting = startWebSocketServer(buildRejectingGateway(), 0, buildRouter());
    try {
      const rejPort = await listeningPort(rejecting);
      const ws = new WebSocket(`ws://127.0.0.1:${rejPort}/ws?session_id=s3&cart_id=c3&pos_config_id=7&device_id=d3`);
      await open(ws);
      ws.send(JSON.stringify({ type: 'connection.resume', session_id: 's3', cart_id: 'c3', last_seen_cart_version: 0 }));
      // Give the rejected promise a tick to (fail to) surface; the .catch must swallow it.
      await new Promise((r) => setTimeout(r, 50));
      expect(ws.readyState).toBe(WebSocket.OPEN);
      const res = await fetch(`http://127.0.0.1:${rejPort}/health`);
      expect(res.status).toBe(200);
      ws.close();
    } finally {
      rejecting.close();
    }
  });
});
