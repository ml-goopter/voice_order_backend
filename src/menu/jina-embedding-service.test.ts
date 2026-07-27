import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RateLimiter } from '../ratelimit/rate-limiter.js';
import type { TokenBucket } from '../ratelimit/token-bucket.js';

// The service reads config at import time via env; set before importing config. Every module that
// transitively loads `config/env.js` — the rate limiter included — must therefore be imported
// dynamically, BELOW this block, not with a static (hoisted) import.
process.env.JINA_API_KEY = 'test-key';
process.env.EMBEDDING_MODEL = 'jina-embeddings-v3';
process.env.EMBEDDING_DIMENSIONS = '4';

const { JinaEmbeddingService } = await import('./jina-embedding-service.js');
const { RateLimiter: Limiter } = await import('../ratelimit/rate-limiter.js');
const { RATE_LIMIT } = await import('../config/constants.js');

/** Records the backoff the client asked for without actually sleeping through it. */
function backoffRecorder(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    sleep: async (ms: number) => {
      waits.push(ms);
    },
    waits,
  };
}

/** A service whose retry backoff is instant — every retry case would otherwise really sleep. */
function service(limiter?: RateLimiter, waitMs?: number, sleep?: (ms: number) => Promise<void>) {
  return new JinaEmbeddingService(limiter, waitMs, sleep ?? (async () => {}));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('JinaEmbeddingService', () => {
  const fetchMock = vi.fn();

  it('reserves with its own wait budget (a per-call latency budget, not a limiter property)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ index: 0, embedding: [1, 0, 0, 0] }] }));
    const run = vi.fn(async (_opts: unknown, fn: () => Promise<unknown>) => fn());

    await new JinaEmbeddingService({ run } as unknown as RateLimiter, 1_000).embed('hi');

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ deadlineMs: 1_000 }), expect.any(Function));
  });

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends model/task/dimensions and the full batch in one request', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [
          { index: 0, embedding: [1, 0, 0, 0] },
          { index: 1, embedding: [0, 1, 0, 0] },
        ],
      }),
    );

    const svc = new JinaEmbeddingService();
    const out = await svc.embedBatch(['a', 'b'], 'passage');

    expect(out).toEqual([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toContain('api.jina.ai');
    expect(opts.headers.authorization).toBe('Bearer test-key');
    const body = JSON.parse(opts.body as string);
    expect(body).toMatchObject({
      model: 'jina-embeddings-v3',
      task: 'retrieval.passage',
      dimensions: 4,
      input: ['a', 'b'],
    });
  });

  it('reorders vectors by index when the API returns them out of order', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [
          { index: 1, embedding: [0, 1, 0, 0] },
          { index: 0, embedding: [1, 0, 0, 0] },
        ],
      }),
    );

    const out = await new JinaEmbeddingService().embedBatch(['a', 'b']);
    expect(out).toEqual([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
    ]);
  });

  it('keeps vectors aligned to input positions when the API drops an input', async () => {
    // Sent 3 texts; API returns only indices 0 and 2 (index 1 dropped).
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [
          { index: 2, embedding: [0, 0, 1, 0] },
          { index: 0, embedding: [1, 0, 0, 0] },
        ],
      }),
    );

    const out = await new JinaEmbeddingService().embedBatch(['a', 'b', 'c']);
    // Index 1 must be a gap ([]), not index 2's vector shifted into its slot.
    expect(out).toEqual([[1, 0, 0, 0], [], [0, 0, 1, 0]]);
  });

  it('maps the query role to retrieval.query', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ index: 0, embedding: [1, 0, 0, 0] }] }));
    await new JinaEmbeddingService().embed('hi', 'query');
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.task).toBe('retrieval.query');
  });

  it('retries once on a 5xx then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 503))
      .mockResolvedValueOnce(jsonResponse({ data: [{ index: 0, embedding: [1, 0, 0, 0] }] }));

    const out = await service().embed('hi');
    expect(out).toEqual([1, 0, 0, 0]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe('retry backoff', () => {
    it('waits the base delay before re-issuing after a 5xx', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 503))
        .mockResolvedValueOnce(jsonResponse({ data: [{ index: 0, embedding: [1, 0, 0, 0] }] }));
      const { sleep, waits } = backoffRecorder();

      await service(undefined, undefined, sleep).embed('hi');

      expect(waits).toEqual([RATE_LIMIT.retryBackoffMs]);
    });

    it('honours a 429 Retry-After, capped to the in-request ceiling', async () => {
      // Re-issuing at the same instant against a key that just said stop is the burst `penalize`
      // exists to prevent — the retry has to wait too. The cap is because this wait sits inside a
      // live turn's latency budget; `penalize` carries the rest of the hold-off for later callers.
      fetchMock
        .mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }))
        .mockResolvedValueOnce(jsonResponse({ data: [{ index: 0, embedding: [1, 0, 0, 0] }] }));
      const { sleep, waits } = backoffRecorder();
      const limiter = {
        run: async (_o: unknown, fn: () => Promise<unknown>) => fn(),
        nowMs: () => 0,
        penalize: vi.fn(),
      } as unknown as RateLimiter;

      await service(limiter, 1_000, sleep).embed('hi');

      expect(waits).toEqual([RATE_LIMIT.maxRetryBackoffMs]);
    });

    it('does not sleep after the FINAL attempt', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: 'boom' }, 503));
      const { sleep, waits } = backoffRecorder();

      await expect(service(undefined, undefined, sleep).embed('hi')).rejects.toThrow(/jina embedding/);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(waits).toHaveLength(1); // one gap between two attempts, not one per attempt
    });
  });

  it('fails fast on a 4xx without retrying', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'bad request' }, 400));
    await expect(new JinaEmbeddingService().embed('hi')).rejects.toThrow(/jina_http_400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns [] for an empty batch without calling fetch', async () => {
    const out = await new JinaEmbeddingService().embedBatch([]);
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('rate limiting', () => {
    // The reservation is only observable through the private bucket; a frozen clock keeps refill
    // out of the arithmetic.
    const tpmOf = (l: RateLimiter): TokenBucket => (l as unknown as { tpm: TokenBucket }).tpm;
    const frozen = (tpm: number) => new Limiter('embedding', { tpm }, () => 0);
    // 12 + 20 chars at 4 chars/token → 3 + 5 tokens.
    const BATCH = ['a'.repeat(12), 'b'.repeat(20)];
    const BATCH_ESTIMATE = 8;
    const twoVectors = () =>
      jsonResponse({
        data: [
          { index: 0, embedding: [1, 0, 0, 0] },
          { index: 1, embedding: [0, 1, 0, 0] },
        ],
      });

    it('penalizes with the response Retry-After on a 429 and still retries once', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }))
        .mockResolvedValueOnce(jsonResponse({ data: [{ index: 0, embedding: [1, 0, 0, 0] }] }));
      const penalize = vi.fn();
      const limiter = {
        run: async (_o: unknown, fn: () => Promise<unknown>) => fn(),
        nowMs: () => 5_000,
        penalize,
      } as unknown as RateLimiter;

      const out = await service(limiter, 1_000).embed('hi');

      expect(out).toEqual([1, 0, 0, 0]);
      expect(fetchMock).toHaveBeenCalledTimes(2); // the client's own transport retry is preserved
      expect(penalize).toHaveBeenCalledWith(5_000 + 2_000, 'embedding_429');
    });

    it('does not penalize on a terminal 4xx (a bad key says nothing about capacity)', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: 'bad request' }, 400));
      const penalize = vi.fn();
      const limiter = {
        run: async (_o: unknown, fn: () => Promise<unknown>) => fn(),
        nowMs: () => 0,
        penalize,
      } as unknown as RateLimiter;

      await expect(service(limiter, 1_000).embedBatch(['a'])).rejects.toThrow(/jina_http_400/);
      expect(penalize).not.toHaveBeenCalled();
    });

    it('settles the lease on success, leaving the estimate charged (Jina reports no usage)', async () => {
      fetchMock.mockResolvedValue(twoVectors());
      const limiter = frozen(10_000);

      await service(limiter, 1_000).embedBatch(BATCH);

      expect(tpmOf(limiter).available).toBe(10_000 - BATCH_ESTIMATE);
    });

    it('does NOT refund a terminal 4xx — Jina read and counted that request', async () => {
      // A bad key or a malformed body is not a quota signal (nothing is penalized), but the
      // request still crossed the wire and was billed against the RPM/TPM pool. Only a call that
      // never arrived is refundable.
      fetchMock.mockResolvedValue(jsonResponse({ error: 'bad request' }, 400));
      const limiter = frozen(10_000);

      await expect(service(limiter, 1_000).embedBatch(BATCH)).rejects.toThrow(/jina_http_400/);
      expect(tpmOf(limiter).available).toBe(10_000 - BATCH_ESTIMATE);
    });

    it('does NOT refund a terminal 429 — Jina counted every one of those requests', async () => {
      // The failure carries its status out of `post`, which is the only way `run` can tell a
      // request the provider rejected from one that never arrived. Without it a rate-limited key
      // would get its whole reservation back and be free to hammer the pool that just said stop.
      // A fresh Response per attempt: a body can only be read once, and the retry reads it too.
      fetchMock.mockImplementation(async () => new Response('slow down', { status: 429 }));
      const limiter = frozen(10_000);

      await expect(service(limiter, 1_000).embedBatch(BATCH)).rejects.toThrow(/jina embedding/);
      expect(tpmOf(limiter).available).toBe(10_000 - BATCH_ESTIMATE);
    });

    it('keeps a 429 on the thrown error when a LATER attempt dies at the network layer', async () => {
      // The likeliest 429 shape in production: a rate-limited key whose retry then trips the
      // request timeout. If the network failure clears the status, the error reaches `run`
      // looking like a call that never happened and the WHOLE reservation is refunded — to a
      // caller now free to hammer the key that just said stop.
      fetchMock
        .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
        .mockRejectedValueOnce(new TypeError('fetch failed'));
      const limiter = frozen(10_000);

      const err = await service(limiter, 1_000)
        .embedBatch(BATCH)
        .catch((e: unknown) => e);

      expect((err as { status?: number }).status).toBe(429);
      expect(tpmOf(limiter).available).toBe(10_000 - BATCH_ESTIMATE);
    });

    it('still refunds a request that never reached Jina', async () => {
      // `fetch` reports every socket failure as a bare `TypeError: fetch failed`; the code that
      // proves nothing was sent survives only on `cause`, so `post` must carry it through.
      fetchMock.mockRejectedValue(
        Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        }),
      );
      const limiter = frozen(10_000);

      await expect(service(limiter, 1_000).embedBatch(BATCH)).rejects.toThrow(/jina embedding/);
      expect(tpmOf(limiter).available).toBe(10_000);
    });
  });
});
