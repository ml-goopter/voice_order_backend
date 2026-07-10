import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../events/event-bus.js';
import { InMemoryCartCache } from '../redis/cart-cache.js';
import { emptyCart } from '../cart/cart-types.js';
import { RealtimeGateway } from './realtime-gateway.js';
import type { ClientConnection } from './client-registry.js';
import type { VoiceMessageHandler } from '../voice/voice-message-handler.js';

type FakeConn = ClientConnection & { send: ReturnType<typeof vi.fn> };

function conn(session_id: string, cart_id: string): FakeConn {
  return {
    session_id,
    cart_id,
    pos_config_id: 1,
    send: vi.fn(),
    close: vi.fn(),
    isAlive: () => true,
  } as FakeConn;
}

function makeGateway() {
  const bus = new EventBus();
  const carts = new InMemoryCartCache();
  const voice = {
    handleDisconnect: vi.fn(),
    handleStart: vi.fn(async () => {}),
  } as unknown as VoiceMessageHandler;
  const gw = new RealtimeGateway(bus, voice, carts);
  return { bus, carts, voice, gw };
}

describe('RealtimeGateway — cart.updated broadcast', () => {
  it('broadcasts to every socket on the cart', () => {
    const { bus, gw } = makeGateway();
    const a = conn('s1', 'cart_1');
    const b = conn('s2', 'cart_1');
    gw.onConnect(a);
    gw.onConnect(b);
    const cart = emptyCart('cart_1', 1);
    bus.emit('cart.updated', { cart_id: 'cart_1', pos_config_id: 1, version: 5, cart, request_id: 'req_1' });
    const expected = { type: 'cart.updated', cart_id: 'cart_1', version: 5, cart };
    expect(a.send).toHaveBeenCalledWith(expected);
    expect(b.send).toHaveBeenCalledWith(expected);
  });

  it('sends to nobody when no socket is registered for the cart', () => {
    const { bus } = makeGateway();
    expect(() =>
      bus.emit('cart.updated', {
        cart_id: 'ghost',
        pos_config_id: 1,
        version: 1,
        cart: emptyCart('ghost', 1),
        request_id: 'req_1',
      }),
    ).not.toThrow();
  });
});

describe('RealtimeGateway — order.clarification_needed', () => {
  it('sends to the session socket, including options when present', () => {
    const { bus, gw } = makeGateway();
    const a = conn('s1', 'cart_1');
    gw.onConnect(a);
    bus.emit('order.clarification_needed', {
      cart_id: 'cart_1',
      session_id: 's1',
      request_id: 'r1',
      question: 'Which size?',
      options: ['S', 'L'],
    });
    expect(a.send).toHaveBeenCalledWith({
      type: 'order.clarification_needed',
      cart_id: 'cart_1',
      request_id: 'r1',
      question: 'Which size?',
      options: ['S', 'L'],
    });
  });

  it('omits options when undefined', () => {
    const { bus, gw } = makeGateway();
    const a = conn('s1', 'cart_1');
    gw.onConnect(a);
    bus.emit('order.clarification_needed', {
      cart_id: 'cart_1',
      session_id: 's1',
      request_id: 'r1',
      question: 'Which one?',
    });
    expect(a.send).toHaveBeenCalledWith({
      type: 'order.clarification_needed',
      cart_id: 'cart_1',
      request_id: 'r1',
      question: 'Which one?',
    });
  });

  it('is a no-op when the session has no socket', () => {
    const { bus } = makeGateway();
    expect(() =>
      bus.emit('order.clarification_needed', {
        cart_id: 'c',
        session_id: 'missing',
        request_id: 'r',
        question: 'q',
      }),
    ).not.toThrow();
  });
});

describe('RealtimeGateway — cart.operation_rejected targeting', () => {
  it('with a session_id targets only that session', () => {
    const { bus, gw } = makeGateway();
    const a = conn('s1', 'cart_1');
    const b = conn('s2', 'cart_1');
    gw.onConnect(a);
    gw.onConnect(b);
    bus.emit('cart.operation_rejected', {
      cart_id: 'cart_1',
      session_id: 's1',
      request_id: 'r',
      reason: 'stale_edit',
      message: 'stale',
    });
    expect(a.send).toHaveBeenCalledWith({
      type: 'cart.operation_rejected',
      cart_id: 'cart_1',
      request_id: 'r',
      reason: 'stale_edit',
      message: 'stale',
    });
    expect(b.send).not.toHaveBeenCalled();
  });

  it('without a session_id broadcasts to the whole cart', () => {
    const { bus, gw } = makeGateway();
    const a = conn('s1', 'cart_1');
    const b = conn('s2', 'cart_1');
    gw.onConnect(a);
    gw.onConnect(b);
    bus.emit('cart.operation_rejected', {
      cart_id: 'cart_1',
      request_id: 'r',
      reason: 'line_gone',
      message: 'gone',
    });
    expect(a.send).toHaveBeenCalled();
    expect(b.send).toHaveBeenCalled();
  });

  it('with a session_id whose socket is absent sends to nobody', () => {
    const { bus, gw } = makeGateway();
    const a = conn('s1', 'cart_1');
    gw.onConnect(a);
    bus.emit('cart.operation_rejected', {
      cart_id: 'cart_1',
      session_id: 'other',
      request_id: 'r',
      reason: 'x',
      message: 'y',
    });
    expect(a.send).not.toHaveBeenCalled();
  });
});

describe('RealtimeGateway — connection lifecycle', () => {
  it('onConnect registers and onDisconnect removes + notifies voice', () => {
    const { gw, voice } = makeGateway();
    const a = conn('s1', 'cart_1');
    gw.onConnect(a);
    expect(gw.registry.getBySession('s1')).toBe(a);
    gw.onDisconnect(a);
    expect(gw.registry.getBySession('s1')).toBeUndefined();
    expect(voice.handleDisconnect).toHaveBeenCalledWith('s1');
  });
});

describe('RealtimeGateway — onRawMessage', () => {
  it('replies bad_message for an unparseable frame', async () => {
    const { gw } = makeGateway();
    const a = conn('s1', 'cart_1');
    gw.onConnect(a);
    await gw.onRawMessage(a, 'not json');
    expect(a.send).toHaveBeenCalledWith({
      type: 'voice.error',
      session_id: 's1',
      reason: 'bad_message',
      message: 'Unrecognized message.',
    });
  });

  it('routes a non-resume message through to the voice handler', async () => {
    const { gw, voice } = makeGateway();
    const a = conn('s1', 'cart_1');
    gw.onConnect(a);
    await gw.onRawMessage(a, JSON.stringify({ type: 'voice.start', session_id: 's1', cart_id: 'cart_1' }));
    expect(voice.handleStart).toHaveBeenCalled();
  });

  it('resume returns the existing cart with its version', async () => {
    const { gw, carts } = makeGateway();
    const a = conn('s1', 'cart_1');
    gw.onConnect(a);
    const cart = emptyCart('cart_1', 1);
    cart.version = 9;
    await carts.set(cart);
    await gw.onRawMessage(
      a,
      JSON.stringify({ type: 'connection.resume', session_id: 's1', cart_id: 'cart_1', last_seen_cart_version: 0 }),
    );
    expect(a.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'connection.resumed', cart_id: 'cart_1', cart_version: 9, cart }),
    );
  });

  it('resume falls back to an empty cart (version 0, pos_config_id from the conn)', async () => {
    const { gw } = makeGateway();
    const a = conn('s1', 'cart_new');
    gw.onConnect(a);
    await gw.onRawMessage(
      a,
      JSON.stringify({ type: 'connection.resume', session_id: 's1', cart_id: 'cart_new', last_seen_cart_version: 0 }),
    );
    const sent = a.send.mock.calls[0]![0];
    expect(sent.type).toBe('connection.resumed');
    expect(sent.cart_version).toBe(0);
    expect(sent.cart.cart_id).toBe('cart_new');
    expect(sent.cart.pos_config_id).toBe(1); // sourced from the conn, not the message
  });
});
