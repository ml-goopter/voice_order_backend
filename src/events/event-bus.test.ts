import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventBus } from './event-bus.js';
import { logger } from '../config/logger.js';
import type { SttFinalTranscriptReceived, VoiceSessionEnded } from './event-types.js';

const FINAL: SttFinalTranscriptReceived = {
  request_id: 'req_1',
  session_id: 'sess_1',
  cart_id: 'cart_1',
  pos_config_id: 1,
  text: 'a coke',
};

describe('EventBus', () => {
  afterEach(() => vi.restoreAllMocks());

  it('delivers the exact payload to a subscribed handler exactly once', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('stt.final_transcript.received', handler);
    bus.emit('stt.final_transcript.received', FINAL);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(FINAL);
  });

  it('invokes multiple handlers in subscription order', () => {
    const bus = new EventBus();
    const calls: number[] = [];
    bus.on('stt.final_transcript.received', () => calls.push(1));
    bus.on('stt.final_transcript.received', () => calls.push(2));
    bus.emit('stt.final_transcript.received', FINAL);
    expect(calls).toEqual([1, 2]);
  });

  it('is a no-op when emitting an event with no subscribers', () => {
    const bus = new EventBus();
    expect(() => bus.emit('stt.final_transcript.received', FINAL)).not.toThrow();
  });

  it('does not call a handler after it is removed with off', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('stt.final_transcript.received', handler);
    bus.off('stt.final_transcript.received', handler);
    bus.emit('stt.final_transcript.received', FINAL);
    expect(handler).not.toHaveBeenCalled();
  });

  it('off with a handler that was never registered is a no-op', () => {
    const bus = new EventBus();
    expect(() => bus.off('stt.final_transcript.received', vi.fn())).not.toThrow();
  });

  it('isolates events by name — a handler for one event is not called on another', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('cart.updated', handler);
    bus.emit('stt.final_transcript.received', FINAL);
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs handlers synchronously before emit returns', () => {
    const bus = new EventBus();
    let ran = false;
    bus.on('stt.final_transcript.received', () => {
      ran = true;
    });
    bus.emit('stt.final_transcript.received', FINAL);
    expect(ran).toBe(true);
  });

  it('has NO error isolation: a throwing handler propagates and blocks later handlers', () => {
    // Pins current behavior — the bus is a raw synchronous EventEmitter with no
    // try/catch around listeners. Callers that need isolation must wrap their own
    // handlers. If isolation is ever added, this test should change deliberately.
    const bus = new EventBus();
    const later = vi.fn();
    bus.on('stt.final_transcript.received', () => {
      throw new Error('boom');
    });
    bus.on('stt.final_transcript.received', later);
    expect(() => bus.emit('stt.final_transcript.received', FINAL)).toThrow('boom');
    expect(later).not.toHaveBeenCalled();
  });

  it('logs the correlation ids present on the payload', () => {
    const bus = new EventBus();
    const debugSpy = vi.spyOn(logger, 'debug');
    bus.emit('stt.final_transcript.received', FINAL);
    expect(debugSpy).toHaveBeenCalledWith('event.emit', {
      event: 'stt.final_transcript.received',
      request_id: 'req_1',
      cart_id: 'cart_1',
      session_id: 'sess_1',
    });
  });

  it('omits correlation id keys that are absent from the payload', () => {
    const bus = new EventBus();
    const debugSpy = vi.spyOn(logger, 'debug');
    // voice.session_ended carries session_id + cart_id but no request_id.
    const ended: VoiceSessionEnded = { session_id: 'sess_2', cart_id: 'cart_2' };
    bus.emit('voice.session_ended', ended);
    expect(debugSpy).toHaveBeenCalledWith('event.emit', {
      event: 'voice.session_ended',
      cart_id: 'cart_2',
      session_id: 'sess_2',
    });
  });
});
