import { describe, it, expect } from 'vitest';
import { CartTurnQueue } from './cart-turn-queue.js';

describe('CartTurnQueue', () => {
  it('processes turns for one cart_id one at a time, in arrival order', async () => {
    const q = new CartTurnQueue();
    const order: string[] = [];
    const turn = (label: string, delay: number): Promise<void> =>
      q.enqueue('cart_1', async () => {
        await new Promise((r) => setTimeout(r, delay));
        order.push(label);
      });
    // Turn 1 is slow; the FIFO must still run it before the instant turn 2.
    await Promise.all([turn('t1', 20), turn('t2', 0)]);
    expect(order).toEqual(['t1', 't2']);
  });

  it('runs turns for different carts concurrently', async () => {
    const q = new CartTurnQueue();
    const order: string[] = [];
    await Promise.all([
      q.enqueue('cart_a', async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push('a');
      }),
      q.enqueue('cart_b', async () => {
        order.push('b');
      }),
    ]);
    expect(order).toEqual(['b', 'a']);
  });

  it('a throwing turn rejects its caller but does not wedge the cart queue', async () => {
    const q = new CartTurnQueue();
    const failing = q.enqueue('cart_1', async () => {
      throw new Error('turn blew up');
    });
    const next = q.enqueue('cart_1', async () => 'recovered');
    await expect(failing).rejects.toThrow('turn blew up');
    await expect(next).resolves.toBe('recovered');
  });

  it('returns the turn result to the caller', async () => {
    const q = new CartTurnQueue();
    await expect(q.enqueue('cart_1', async () => 42)).resolves.toBe(42);
  });
});
