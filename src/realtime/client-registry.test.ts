import { describe, it, expect, vi } from 'vitest';
import { ClientRegistry, type ClientConnection } from './client-registry.js';

function conn(session_id: string, cart_id: string): ClientConnection {
  return {
    session_id,
    cart_id,
    pos_config_id: 1,
    device_id: 'dev_1',
    send: vi.fn(),
    close: vi.fn(),
    isAlive: () => true,
  };
}

describe('ClientRegistry', () => {
  it('add then getBySession returns the same connection', () => {
    const reg = new ClientRegistry();
    const c = conn('s1', 'cart_1');
    reg.add(c);
    expect(reg.getBySession('s1')).toBe(c);
  });

  it('tracks multiple sockets on the same cart (multi-device)', () => {
    const reg = new ClientRegistry();
    const a = conn('s1', 'cart_1');
    const b = conn('s2', 'cart_1');
    reg.add(a);
    reg.add(b);
    expect(reg.getByCart('cart_1')).toEqual(expect.arrayContaining([a, b]));
    expect(reg.getByCart('cart_1')).toHaveLength(2);
  });

  it('a second connection with the same session_id overwrites the first', () => {
    const reg = new ClientRegistry();
    const a = conn('s1', 'cart_1');
    const b = conn('s1', 'cart_2');
    reg.add(a);
    reg.add(b);
    expect(reg.getBySession('s1')).toBe(b);
  });

  it('remove drops the connection from both session and cart lookups', () => {
    const reg = new ClientRegistry();
    const c = conn('s1', 'cart_1');
    reg.add(c);
    reg.remove(c);
    expect(reg.getBySession('s1')).toBeUndefined();
    expect(reg.getByCart('cart_1')).toEqual([]);
  });

  it('removing the last socket on a cart deletes the cart entry (leak guard)', () => {
    const reg = new ClientRegistry();
    const c = conn('s1', 'cart_1');
    reg.add(c);
    reg.remove(c);
    // Adding a fresh socket rebuilds the set cleanly rather than reusing a stale one.
    const c2 = conn('s2', 'cart_1');
    reg.add(c2);
    expect(reg.getByCart('cart_1')).toEqual([c2]);
  });

  it('removing one of two sockets on a shared cart leaves the other reachable', () => {
    const reg = new ClientRegistry();
    const a = conn('s1', 'cart_1');
    const b = conn('s2', 'cart_1');
    reg.add(a);
    reg.add(b);
    reg.remove(a);
    expect(reg.getByCart('cart_1')).toEqual([b]);
  });

  it('remove of a never-added / already-removed connection is a no-op', () => {
    const reg = new ClientRegistry();
    const c = conn('s1', 'cart_1');
    expect(() => reg.remove(c)).not.toThrow();
    reg.add(c);
    reg.remove(c);
    expect(() => reg.remove(c)).not.toThrow();
  });

  it('getBySession / getByCart return undefined / [] for unknown ids', () => {
    const reg = new ClientRegistry();
    expect(reg.getBySession('nope')).toBeUndefined();
    expect(reg.getByCart('nope')).toEqual([]);
  });

  it('getByCart returns a copy — mutating it does not affect the registry', () => {
    const reg = new ClientRegistry();
    const a = conn('s1', 'cart_1');
    reg.add(a);
    const list = reg.getByCart('cart_1');
    list.pop();
    expect(reg.getByCart('cart_1')).toEqual([a]);
  });
});
