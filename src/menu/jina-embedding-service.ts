import { RATE_LIMIT } from '../config/constants.js';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { estimateTokens } from '../ratelimit/estimate-tokens.js';
import { NO_LIMIT, type RateLimiter } from '../ratelimit/rate-limiter.js';
import { retryAfterMs } from '../ratelimit/retry-after.js';
import type { EmbeddingService, EmbedRole } from './embedding-service.js';

/** Jina task adapter per role (design §7 asymmetric retrieval). */
const TASK_BY_ROLE: Record<EmbedRole, string> = {
  query: 'retrieval.query',
  passage: 'retrieval.passage',
};

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 1; // one retry on 429/5xx

interface JinaResponse {
  data: Array<{ index: number; embedding: number[] }>;
}

/**
 * Real embedder backed by Jina AI (https://api.jina.ai/v1/embeddings). Batches all
 * inputs into one request and returns vectors ordered to match `texts` (the API's
 * `data` array is not guaranteed to preserve input order, so we sort by `index`).
 *
 * Jina meters RPM and TPM together, whichever trips first, across ALL products on one key, so the
 * injected {@link RateLimiter} reserves both around the whole request (retry included — the retry
 * is this client's transport handler, not a second logical call).
 */
export class JinaEmbeddingService implements EmbeddingService {
  readonly model = config.embeddingModel;
  readonly dimensions = config.embeddingDimensions;
  /** False for the shared passthrough: skip estimating entirely, so an unconfigured deployment
   *  pays nothing for a feature it did not turn on. */
  private readonly shaped: boolean;

  constructor(
    private readonly limiter: RateLimiter = NO_LIMIT,
    /** Wait budget per request (`EMBEDDING_RATE_LIMIT_WAIT_MS`). */
    private readonly waitMs: number = RATE_LIMIT.defaultWaitMs,
    /** Delay before this client's own retry; injectable so tests need not sleep. */
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {
    this.shaped = limiter !== NO_LIMIT;
    if (!config.jinaApiKey) {
      throw new Error('JINA_API_KEY is required when EMBEDDING_PROVIDER=jina');
    }
  }

  async embed(text: string, role: EmbedRole = 'query'): Promise<number[]> {
    const [vector] = await this.embedBatch([text], role);
    return vector ?? [];
  }

  async embedBatch(texts: string[], role: EmbedRole = 'query'): Promise<number[][]> {
    if (texts.length === 0) return [];

    const body = JSON.stringify({
      model: this.model,
      task: TASK_BY_ROLE[role],
      dimensions: this.dimensions,
      embedding_type: 'float',
      normalized: true,
      input: texts,
    });

    // One reservation per LOGICAL request: the retry inside `post` is this client's transport
    // handler, not a second call. Jina reports no usage, so the estimate stands as the charge.
    const json = await this.limiter.run({ cost: this.reserve(texts), deadlineMs: this.waitMs }, () =>
      this.post(body),
    );
    // Place each vector at its own `index` so a dropped input leaves a gap
    // (empty vector) rather than shifting every later vector onto the wrong text.
    const out: number[][] = texts.map(() => []);
    for (const d of json.data) {
      if (d.index >= 0 && d.index < out.length) out[d.index] = d.embedding;
    }
    if (json.data.length !== texts.length) {
      logger.warn('embedding.jina.count_mismatch', { sent: texts.length, got: json.data.length });
    }
    return out;
  }

  /** TPM tokens to reserve for one batch — Jina bills the inputs it embeds, so the estimate is the
   *  batch's own text. Returns 0 for an unshaped provider. */
  private reserve(texts: string[]): number {
    if (!this.shaped) return 0;
    let total = 0;
    for (const t of texts) total += estimateTokens(t);
    return total;
  }

  private async post(body: string): Promise<JinaResponse> {
    let lastErr: unknown;
    /** HTTP status seen across ALL attempts, carried onto the thrown error so the limiter can tell
     *  a request the provider REJECTED (already counted against the quota, so its reservation must
     *  stand) from one that never arrived.
     *
     *  STICKY on purpose, and 429 outranks everything: the commonest production shape is a
     *  rate-limited key whose retry then trips the request timeout. Letting the network failure
     *  clear the status would throw a statusless error, and the whole reservation — the request
     *  the provider counted included — would be refunded to a caller free to hammer it again. */
    let status = 0;
    /** Milliseconds to wait before the next attempt (policy §5.4 self-owned backoff). */
    let backoffMs: number = RATE_LIMIT.retryBackoffMs;
    // Retry only transient failures (429/5xx, network/timeout); fail fast on 4xx.
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(config.jinaBaseUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.jinaApiKey}`,
          },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (res.ok) return (await res.json()) as JinaResponse;

        // Only a 429 is a quota signal: floor the next grant so the following caller waits instead
        // of piling more requests on a key that is already saying stop. A terminal 4xx (bad key,
        // malformed request) says nothing about capacity and must NOT penalize. Jina publishes no
        // Retry-After, so this normally falls back to RATE_LIMIT.penalty429Ms — read the header
        // opportunistically, never depend on it being there.
        if (res.status === 429) {
          const wait = retryAfterMs(res.headers);
          this.limiter.penalize(this.limiter.nowMs() + wait, 'embedding_429');
          backoffMs = Math.min(wait, RATE_LIMIT.maxRetryBackoffMs);
        }

        const detail = `jina_http_${res.status}: ${await res.text()}`;
        // Terminal 4xx: no retry, but it DID reach Jina and was counted, so it carries its status.
        if (res.status !== 429 && res.status < 500) {
          throw Object.assign(new Error(detail), { status: res.status });
        }
        if (status !== 429) status = res.status;
        lastErr = new Error(detail); // transient → retry
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('jina_http_4')) throw err;
        lastErr = err; // network/timeout → retry; `status` is left alone (see above)
      }
      logger.warn('embedding.jina.request_failed', { attempt, error: String(lastErr) });
      // Back off before re-issuing. Without this the "retry" is an immediate second request at the
      // same instant — on a 429 that is precisely the burst the penalty is trying to stop.
      if (attempt < MAX_RETRIES) await this.sleep(backoffMs);
    }
    // Keep the underlying error as `cause`: it carries the socket-level `code` that tells the
    // limiter a connection was never established (ECONNREFUSED/ENOTFOUND) from an ambiguous one.
    const failed = Object.assign(new Error(`jina embedding request failed: ${String(lastErr)}`), {
      cause: lastErr,
    });
    throw status > 0 ? Object.assign(failed, { status }) : failed;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
