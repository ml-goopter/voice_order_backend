import { describe, it, expect, vi } from 'vitest';
import { MessageRouter } from './message-router.js';
import type { EventBus } from '../events/event-bus.js';
import type { VoiceMessageHandler } from '../voice/voice-message-handler.js';
import type { ClientConnection } from './client-registry.js';

function makeRouter() {
  const voice = {
    handleStart: vi.fn(async () => {}),
    handleAudioChunk: vi.fn(),
    handleStop: vi.fn(async () => {}),
  } as unknown as VoiceMessageHandler;
  const bus = { emit: vi.fn() } as unknown as EventBus;
  const router = new MessageRouter(voice, bus);
  return { voice, bus, router };
}

const conn = {
  session_id: 's1',
  cart_id: 'cart_1',
  pos_config_id: 1,
  send: vi.fn(),
  close: vi.fn(),
  isAlive: () => true,
} as ClientConnection;

describe('MessageRouter', () => {
  it('routes voice.start to handleStart with conn + msg', async () => {
    const { router, voice } = makeRouter();
    const msg = { type: 'voice.start', session_id: 's1', cart_id: 'cart_1' } as const;
    await router.route(conn, msg);
    expect(voice.handleStart).toHaveBeenCalledWith(conn, msg);
  });

  it('routes voice.audio_chunk to handleAudioChunk', async () => {
    const { router, voice } = makeRouter();
    const msg = { type: 'voice.audio_chunk', session_id: 's1', seq: 1, audio: 'AA==' } as const;
    await router.route(conn, msg);
    expect(voice.handleAudioChunk).toHaveBeenCalledWith(conn, msg);
  });

  it('routes voice.stop to handleStop', async () => {
    const { router, voice } = makeRouter();
    const msg = { type: 'voice.stop', session_id: 's1' } as const;
    await router.route(conn, msg);
    expect(voice.handleStop).toHaveBeenCalledWith(conn, msg);
  });

  it('maps order.clarification_answered onto a bus event', async () => {
    const { router, bus } = makeRouter();
    const msg = {
      type: 'order.clarification_answered',
      session_id: 's1',
      cart_id: 'cart_1',
      request_id: 'r1',
      answer: 'Large',
    } as const;
    await router.route(conn, msg);
    expect(bus.emit).toHaveBeenCalledWith('order.clarification_answered', {
      cart_id: 'cart_1',
      session_id: 's1',
      request_id: 'r1',
      answer: 'Large',
    });
  });

  it('connection.resume is a no-op (owned by the gateway)', async () => {
    const { router, voice, bus } = makeRouter();
    const msg = {
      type: 'connection.resume',
      session_id: 's1',
      cart_id: 'cart_1',
      last_seen_cart_version: 0,
    } as const;
    await router.route(conn, msg);
    expect(voice.handleStart).not.toHaveBeenCalled();
    expect(bus.emit).not.toHaveBeenCalled();
  });

  it('propagates a rejected handleStart to the caller', async () => {
    const { router, voice } = makeRouter();
    (voice.handleStart as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('start failed'));
    const msg = { type: 'voice.start', session_id: 's1', cart_id: 'cart_1' } as const;
    await expect(router.route(conn, msg)).rejects.toThrow('start failed');
  });
});
