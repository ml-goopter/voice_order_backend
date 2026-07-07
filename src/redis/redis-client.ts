import { logger } from '../config/logger.js';
import { config } from '../config/env.js';

/**
 * Redis connection holder. Stubbed so the scaffold boots without a server.
 * TODO: `npm i ioredis` and return a real client here; back RedisCartCache with it.
 */
export function createRedisClient(): { connected: boolean } {
  logger.warn('redis.stub_client', { url: config.redisUrl, hint: 'wire ioredis' });
  return { connected: false };
}
