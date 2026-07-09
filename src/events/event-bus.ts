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
    // The bus sees every event, so it's the one place to correlate a flow — pull the
    // turn ids off the payload when present so the debug trace is traceable per turn.
    const p = payload as { request_id?: string; cart_id?: string; session_id?: string };
    logger.debug('event.emit', {
      event: name,
      ...(p.request_id !== undefined ? { request_id: p.request_id } : {}),
      ...(p.cart_id !== undefined ? { cart_id: p.cart_id } : {}),
      ...(p.session_id !== undefined ? { session_id: p.session_id } : {}),
    });
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
