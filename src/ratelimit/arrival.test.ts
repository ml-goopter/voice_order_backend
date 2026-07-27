import { describe, it, expect } from 'vitest';
import { reachedProvider } from './arrival.js';
import { RateLimitTimeoutError } from './errors.js';

describe('reachedProvider', () => {
  it('is true for any HTTP status, not just a 429', () => {
    // The whole defect this encodes: a 500 and a terminal 400 were transmitted, parsed and
    // counted by the provider exactly like a 429 was. Refunding them shapes against calls that
    // definitely happened.
    expect(reachedProvider({ status: 429 })).toBe(true);
    expect(reachedProvider({ status: 500 })).toBe(true);
    expect(reachedProvider({ status: 400 })).toBe(true);
    expect(reachedProvider({ statusCode: 503 })).toBe(true);
  });

  it('is false for a connection that was never established', () => {
    expect(reachedProvider(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }))).toBe(false);
    expect(reachedProvider(Object.assign(new Error('dns'), { code: 'ENOTFOUND' }))).toBe(false);
    expect(reachedProvider(Object.assign(new Error('route'), { code: 'EHOSTUNREACH' }))).toBe(false);
  });

  it('reads the code through the cause chain fetch wraps it in', () => {
    // `fetch` reports every socket failure as a bare `TypeError: fetch failed`; the only place the
    // real code survives is `cause`.
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    expect(reachedProvider(err)).toBe(false);
  });

  it('prefers an outer status over a deeper connection code', () => {
    const err = Object.assign(new Error('jina embedding request failed'), {
      status: 429,
      cause: Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }),
    });
    expect(reachedProvider(err)).toBe(true);
  });

  it('is false for our own limiter refusing to dispatch', () => {
    expect(reachedProvider(new RateLimitTimeoutError('deadline', 'llm: timed out'))).toBe(false);
  });

  it('fails CLOSED on anything it cannot classify', () => {
    // Over-charging a call that never arrived costs a little throughput and refills; refunding one
    // that DID arrive makes the limiter laxer than the quota it protects, precisely under strain.
    expect(reachedProvider(new Error('boom'))).toBe(true);
    expect(reachedProvider(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }))).toBe(true);
    expect(reachedProvider(new DOMException('signal timed out', 'TimeoutError'))).toBe(true);
    expect(reachedProvider(undefined)).toBe(true);
  });

  it('does not treat a non-HTTP numeric status as arrival', () => {
    expect(reachedProvider({ status: 0, code: 'ECONNREFUSED' })).toBe(false);
  });

  it('terminates on a self-referential cause chain', () => {
    const err = new Error('loop') as Error & { cause?: unknown };
    err.cause = err;
    expect(reachedProvider(err)).toBe(true);
  });
});
