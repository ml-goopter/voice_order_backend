/**
 * Per-key in-process async lock — the "single writer per cart" critical section
 * (design §9, Tier 2) and the building block for the per-cart understanding FIFO
 * (Tier 1). Only valid within one process; shard by cart_id to scale out.
 */
export class KeyedAsyncLock {
  private readonly tails = new Map<string, Promise<void>>();

  /** Runs `fn` exclusively for `key`; calls on the same key serialize in arrival order. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    // A non-throwing tail so a rejection never breaks the chain for later callers.
    const settled: Promise<void> = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, settled);
    void settled.then(() => {
      if (this.tails.get(key) === settled) this.tails.delete(key);
    });
    return result;
  }
}
