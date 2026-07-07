/**
 * Metrics sink. No-op counters/timers so call sites exist from day one.
 * TODO: back with a real registry (prometheus, OTEL). Design §11/§13 call out
 * connection count, event-loop lag, STT concurrency, and stage latencies.
 */
export const metrics = {
  increment(name: string, value = 1): void {
    void name;
    void value;
  },
  timing(name: string, ms: number): void {
    void name;
    void ms;
  },
};
