/**
 * Minimal structured logger. Console-backed so the scaffold has zero runtime deps.
 * TODO: swap for pino (`npm i pino`) — keep this interface.
 */
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function emit(level: string, bindings: Record<string, unknown>, msg: string, meta?: Record<string, unknown>): void {
  const line = { level, time: new Date().toISOString(), msg, ...bindings, ...(meta ?? {}) };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(line));
}

function make(bindings: Record<string, unknown>): Logger {
  return {
    info: (msg, meta) => emit('info', bindings, msg, meta),
    warn: (msg, meta) => emit('warn', bindings, msg, meta),
    error: (msg, meta) => emit('error', bindings, msg, meta),
    debug: (msg, meta) => emit('debug', bindings, msg, meta),
    child: (extra) => make({ ...bindings, ...extra }),
  };
}

export const logger: Logger = make({ service: 'voice-ordering' });
