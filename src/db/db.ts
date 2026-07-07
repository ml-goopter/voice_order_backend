import { config } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Postgres access. Stubbed so the scaffold runs without a database.
 * TODO: `npm i pg`, create a Pool from config.databaseUrl, expose query().
 * Schema DDL lives in src/db/schema/*.sql (run via scripts/migrate.ts).
 */
export interface Db {
  readonly connected: boolean;
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
}

export function createDb(): Db {
  logger.warn('db.stub_client', { url: config.databaseUrl, hint: 'wire pg' });
  return {
    connected: false,
    query: async () => [],
  };
}
