import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Logger } from './logger.js';

// logger.ts binds its level threshold from config.logLevel at import time, so each case
// sets LOG_LEVEL then re-imports a fresh module.
let saved: string | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  saved = process.env.LOG_LEVEL;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  if (saved === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = saved;
  logSpy.mockRestore();
  vi.resetModules();
});

async function freshLogger(logLevel?: string): Promise<Logger> {
  if (logLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = logLevel;
  vi.resetModules();
  return (await import('./logger.js')).logger;
}

/** Parse the single JSON line emitted for the most recent console.log call. */
function lastLine(): Record<string, unknown> {
  const call = logSpy.mock.calls.at(-1);
  return JSON.parse(call?.[0] as string) as Record<string, unknown>;
}

describe('logger', () => {
  it('emits at/above the threshold as one JSON line with level, msg, time and base bindings', async () => {
    const log = await freshLogger('info');
    log.info('hello', { a: 1 });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(lastLine()).toMatchObject({ level: 'info', msg: 'hello', a: 1, service: 'voice-ordering' });
    expect(typeof lastLine().time).toBe('string');
  });

  it('drops messages below the threshold', async () => {
    const log = await freshLogger('info');
    log.debug('noise'); // debug(10) < info(20)
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('honours a raised threshold (LOG_LEVEL=error drops info/warn/debug)', async () => {
    const log = await freshLogger('error');
    log.info('i');
    log.warn('w');
    log.debug('d');
    expect(logSpy).not.toHaveBeenCalled();
    log.error('boom');
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(lastLine()).toMatchObject({ level: 'error', msg: 'boom' });
  });

  it('falls back to the info threshold for an unknown LOG_LEVEL', async () => {
    const log = await freshLogger('verbose'); // unknown → RANK.info
    log.debug('d');
    expect(logSpy).not.toHaveBeenCalled(); // debug still below info
    log.info('i');
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('child() merges bindings over the base, and nests', async () => {
    const log = await freshLogger('info');
    log.child({ request_id: 'r1' }).info('turn');
    expect(lastLine()).toMatchObject({ service: 'voice-ordering', request_id: 'r1', msg: 'turn' });

    log.child({ request_id: 'r1' }).child({ cart_id: 'c1' }).warn('nested');
    expect(lastLine()).toMatchObject({ service: 'voice-ordering', request_id: 'r1', cart_id: 'c1', level: 'warn' });
  });

  it('lets per-call meta override bindings', async () => {
    const log = await freshLogger('info');
    log.child({ scope: 'base' }).info('m', { scope: 'call' });
    expect(lastLine().scope).toBe('call'); // meta spread last wins
  });
});
