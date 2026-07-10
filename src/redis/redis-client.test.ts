import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '../config/logger.js';

// Capture every constructed Redis so we can inspect singleton behavior + handlers.
const instances: FakeRedis[] = [];

class FakeRedis {
  handlers = new Map<string, (arg: unknown) => void>();
  quit = vi.fn(async () => {});
  disconnect = vi.fn(() => {});
  constructor(public url: string) {
    instances.push(this);
  }
  on(event: string, cb: (arg: unknown) => void): this {
    this.handlers.set(event, cb);
    return this;
  }
}

vi.mock('ioredis', () => ({ Redis: FakeRedis }));

const { createRedisClient, closeRedisClient } = await import('./redis-client.js');

describe('redis-client', () => {
  beforeEach(async () => {
    await closeRedisClient(); // reset the module singleton between tests
    instances.length = 0;
  });

  it('returns the same instance on repeated calls (singleton)', () => {
    const a = createRedisClient();
    const b = createRedisClient();
    expect(a).toBe(b);
    expect(instances).toHaveLength(1);
  });

  it('registers connect and error handlers on the client', () => {
    createRedisClient();
    const inst = instances[0]!;
    expect(inst.handlers.has('connect')).toBe(true);
    expect(inst.handlers.has('error')).toBe(true);
  });

  it('error handler logs redis.error and does not throw', () => {
    const errSpy = vi.spyOn(logger, 'error');
    createRedisClient();
    const inst = instances[0]!;
    expect(() => inst.handlers.get('error')!(new Error('down'))).not.toThrow();
    expect(errSpy).toHaveBeenCalledWith('redis.error', expect.objectContaining({ message: 'down' }));
    errSpy.mockRestore();
  });

  it('closeRedisClient quits and clears the singleton so the next call is fresh', async () => {
    const first = createRedisClient() as unknown as FakeRedis;
    await closeRedisClient();
    expect(first.quit).toHaveBeenCalledTimes(1);
    const second = createRedisClient();
    expect(second).not.toBe(first as unknown);
    expect(instances).toHaveLength(2);
  });

  it('falls back to disconnect when quit rejects', async () => {
    const c = createRedisClient() as unknown as FakeRedis;
    c.quit.mockRejectedValueOnce(new Error('cannot quit'));
    await closeRedisClient();
    expect(c.disconnect).toHaveBeenCalledTimes(1);
  });

  it('closeRedisClient is a no-op when no client exists', async () => {
    await expect(closeRedisClient()).resolves.toBeUndefined();
    expect(instances).toHaveLength(0);
  });
});
