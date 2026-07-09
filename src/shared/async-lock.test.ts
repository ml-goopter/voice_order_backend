import { describe, it, expect } from 'vitest';
import { KeyedAsyncLock } from './async-lock.js';

/** Drain the macrotask queue so the lock's deferred map cleanup (a chained .then) runs. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('KeyedAsyncLock', () => {
  it('serializes calls on the same key in arrival order', async () => {
    const lock = new KeyedAsyncLock();
    const order: string[] = [];
    const run = (label: string, delay: number): Promise<void> =>
      lock.run('k', async () => {
        await new Promise((r) => setTimeout(r, delay));
        order.push(label);
      });
    // 'first' is slow and 'second' is instant; serialization must still yield first→second.
    await Promise.all([run('first', 20), run('second', 0)]);
    expect(order).toEqual(['first', 'second']);
  });

  it('runs different keys concurrently', async () => {
    const lock = new KeyedAsyncLock();
    const order: string[] = [];
    await Promise.all([
      lock.run('a', async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push('a');
      }),
      lock.run('b', async () => {
        order.push('b');
      }),
    ]);
    // 'b' did not wait for 'a' — it finished first despite starting second.
    expect(order).toEqual(['b', 'a']);
  });

  it('propagates a callback rejection to its own caller', async () => {
    const lock = new KeyedAsyncLock();
    await expect(lock.run('k', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });

  it('a throwing callback does not wedge the queue for later callers on that key', async () => {
    const lock = new KeyedAsyncLock();
    const ran: string[] = [];
    const failing = lock.run('k', async () => {
      throw new Error('boom');
    });
    const following = lock.run('k', async () => {
      ran.push('after');
      return 'ok';
    });
    await expect(failing).rejects.toThrow('boom');
    await expect(following).resolves.toBe('ok');
    expect(ran).toEqual(['after']);
  });

  it('deletes the map entry once a key drains, so idle keys do not leak', async () => {
    const lock = new KeyedAsyncLock();
    const tails = (lock as unknown as { tails: Map<string, unknown> }).tails;
    await lock.run('k', async () => undefined);
    await flush();
    expect(tails.has('k')).toBe(false);
  });

  it('keeps serializing a key that was used, drained, then used again', async () => {
    const lock = new KeyedAsyncLock();
    const order: number[] = [];
    await lock.run('k', async () => {
      order.push(1);
    });
    await flush(); // the 'k' entry is now cleaned up
    await Promise.all([
      lock.run('k', async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(2);
      }),
      lock.run('k', async () => {
        order.push(3);
      }),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });
});
