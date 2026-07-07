import { EventEmitter } from 'node:events';
import type { AppEventMap, AppEventName } from './event-types.js';
import { logger } from '../config/logger.js';

/** Typed in-process event bus (design §2). Swap the transport later without touching callers. */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit<K extends AppEventName>(name: K, payload: AppEventMap[K]): void {
    logger.debug('event.emit', { event: name });
    this.emitter.emit(name, payload);
  }

  on<K extends AppEventName>(name: K, handler: (payload: AppEventMap[K]) => void): void {
    this.emitter.on(name, handler as (payload: unknown) => void);
  }

  off<K extends AppEventName>(name: K, handler: (payload: AppEventMap[K]) => void): void {
    this.emitter.off(name, handler as (payload: unknown) => void);
  }
}

export const eventBus = new EventBus();
