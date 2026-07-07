import { Redis } from 'ioredis';
import { logger } from '../config/logger.js';
import { config } from '../config/env.js';

let client: Redis | undefined;

/**
 * Shared ioredis connection. Created once and reused across the process so every
 * store (cart cache, menu repository) talks to a single connection. Connection
 * errors are logged, not thrown — ioredis reconnects on its own.
 */
export function createRedisClient(): Redis {
  if (client) return client;
  const redis = new Redis(config.redisUrl);
  redis.on('connect', () => logger.info('redis.connected', { url: config.redisUrl }));
  redis.on('error', (err) => logger.error('redis.error', { message: err.message }));
  client = redis;
  return client;
}

/**
 * Gracefully close the shared connection and clear the singleton. `quit()` drains
 * in-flight commands (unlike `disconnect()`), and resetting `client` lets a later
 * `createRedisClient()` (restart, test lifecycle) get a fresh, live connection.
 */
export async function closeRedisClient(): Promise<void> {
  const c = client;
  client = undefined;
  if (!c) return;
  try {
    await c.quit();
  } catch {
    c.disconnect();
  }
}
