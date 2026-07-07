import { config } from './config/env.js';
import { logger } from './config/logger.js';
import { eventBus } from './events/event-bus.js';

import { createRedisClient } from './redis/redis-client.js';
import { RedisCartCache } from './redis/cart-cache.js';
import { MenuService } from './menu/menu-service.js';
import { RedisMenuRepository } from './menu/menu-repository.js';
import { createSttProvider } from './stt/stt-client.js';
import { createLlmProvider } from './llm/llm-client.js';

import { VoiceSessionManager } from './voice/voice-session-manager.js';
import { VoiceMessageHandler } from './voice/voice-message-handler.js';
import { RealtimeGateway } from './realtime/realtime-gateway.js';
import { startWebSocketServer, type WebSocketServerHandle } from './realtime/websocket-server.js';

import { OrderGraph } from './ordering/order-graph.js';
import { OrderUnderstandingService } from './ordering/order-understanding-service.js';
import { registerOrderingHandlers } from './ordering/register-handlers.js';

import { CartRepository } from './cart/cart-repository.js';
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
  const carts = new RedisCartCache(redis);
  const menu = new MenuService();
  const menuRepo = new RedisMenuRepository(redis);
  const stt = createSttProvider();
  const llm = createLlmProvider();

  // Voice + Realtime.
  const voiceManager = new VoiceSessionManager();
  const voice = new VoiceMessageHandler(voiceManager, stt, bus);
  const gateway = new RealtimeGateway(bus, voice, carts);

  // Order Understanding (pure proposer).
  const graph = new OrderGraph(menu, llm, carts);
  const ordering = new OrderUnderstandingService(graph, bus);
  registerOrderingHandlers(bus, ordering);

  // Cart (sole writer).
  const repo = new CartRepository();
  const cartController = new CartController(carts, menu, repo, bus);
  registerCartHandlers(bus, cartController);

  let ws: WebSocketServerHandle | null = null;

  return {
    gateway,
    async start() {
      // Load every seeded restaurant's menu (+ precomputed vectors) from Redis.
      const posConfigIds = await menuRepo.listPosConfigIds();
      for (const pos of posConfigIds) {
        menu.loadIndexedMenu(pos, await menuRepo.load(pos));
      }
      logger.info('menu.boot_loaded', { pos_config_ids: posConfigIds });

      ws = startWebSocketServer(gateway, config.port);
      logger.info('app.started', { port: config.port, env: config.nodeEnv });
    },
    async stop() {
      ws?.close();
      redis.disconnect();
      logger.info('app.stopped');
    },
  };
}
