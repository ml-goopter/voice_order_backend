import pg from 'pg';
import { logger } from '../config/logger.js';
import { errorMeta } from '../shared/errors.js';
import { config } from '../config/env.js';

const { Pool } = pg;

let pool: pg.Pool | undefined;

/**
 * Shared pg connection pool to the Odoo Postgres DB (where our `item_vector`
 * table lives alongside Odoo's read-only menu tables). Created once and reused
 * across the process, mirroring `createRedisClient()`. Pool errors on idle
 * clients are logged, not thrown — `pg` recreates the client on next use.
 */
export function createPgPool(): pg.Pool {
  if (pool) return pool;
  const p = new Pool({ connectionString: config.odooDatabaseUrl });
  p.on('error', (err) => logger.error('postgres.error', errorMeta(err)));
  logger.info('postgres.pool_created', { url: config.odooDatabaseUrl });
  pool = p;
  return pool;
}

/** Drain the shared pool and clear the singleton (restart / test lifecycle). */
export async function closePgPool(): Promise<void> {
  const p = pool;
  pool = undefined;
  if (!p) return;
  try {
    await p.end();
  } catch (err) {
    logger.warn('postgres.close_failed', errorMeta(err));
  }
}
