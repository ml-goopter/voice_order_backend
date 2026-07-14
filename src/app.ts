import { config } from './config/env.js';
import { logger } from './config/logger.js';
import { messageOf } from './shared/errors.js';
import { eventBus } from './events/event-bus.js';

import { createRedisClient, closeRedisClient } from './redis/redis-client.js';
import { createPgPool, closePgPool } from './db/postgres-client.js';
import { RedisCartCache } from './redis/cart-cache.js';
import { MenuService } from './menu/menu-service.js';
import { PostgresMenuStore } from './menu/postgres-menu-store.js';
import { createSttProvider } from './stt/stt-client.js';
import { createTtsProvider } from './tts/tts-client.js';
import { TtsService } from './tts/tts-service.js';
import { createLlmProvider, createIntentLlmProvider } from './llm/llm-client.js';

import { VoiceSessionManager } from './voice/voice-session-manager.js';
import { VoiceMessageHandler } from './voice/voice-message-handler.js';
import { RealtimeGateway } from './realtime/realtime-gateway.js';
import { startWebSocketServer, type WebSocketServerHandle } from './realtime/websocket-server.js';

import { OrderGraph } from './ordering/order-graph.js';
import { OrderUnderstandingService } from './ordering/order-understanding-service.js';
import { registerOrderingHandlers } from './ordering/register-handlers.js';

import { RedisCartRepository } from './cart/cart-repository.js';
import { CartController } from './cart/cart-controller.js';
import { registerCartHandlers } from './cart/register-handlers.js';

export interface App {
  readonly gateway: RealtimeGateway;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Composition root. Constructs every module, wires them to the event bus, and
 * exposes start/stop. Modules only ever talk through `eventBus` (design §2).
 */
export function createApp(): App {
  const bus = eventBus;

  // Infrastructure.
  const redis = createRedisClient();
  const pgPool = createPgPool();
  const carts = new RedisCartCache(redis);
  // Menu is Postgres/pgvector-backed; cart state stays on Redis.
  const menu = new MenuService(new PostgresMenuStore(pgPool));
  const stt = createSttProvider();
  const tts = new TtsService(createTtsProvider());
  const llm = createLlmProvider();
  const intentLlm = createIntentLlmProvider();

  // Voice + Realtime.
  const voiceManager = new VoiceSessionManager();
  const voice = new VoiceMessageHandler(voiceManager, stt, bus);
  const gateway = new RealtimeGateway(bus, voice, carts, tts);

  // Order Understanding (pure proposer).
  const graph = new OrderGraph(menu, llm, carts, intentLlm);
  const ordering = new OrderUnderstandingService(graph, bus);
  registerOrderingHandlers(bus, ordering);

  // Cart (sole writer).
  const repo = new RedisCartRepository(redis, config.cartIdempotencyTtlSeconds);
  const cartController = new CartController(carts, menu, repo, bus);
  registerCartHandlers(bus, cartController);

  let ws: WebSocketServerHandle | null = null;

  return {
    gateway,
    async start() {
      // Ensure the pgvector table + index exist; matching queries them per request
      // (no menu is loaded into memory). Requires the pgvector extension; without
      // it this warns and the matcher falls back to a fuzzy scan.
      try {
        await menu.ensureIndex();
        logger.info('menu.index_ready');
      } catch (err) {
        logger.warn('menu.index_unavailable', { message: messageOf(err) });
      }

      ws = startWebSocketServer(gateway, config.port);
      logger.info('app.started', { port: config.port, env: config.nodeEnv });
    },
    async stop() {
      ws?.close();
      await closeRedisClient();
      await closePgPool();
      logger.info('app.stopped');
    },
  };
}
