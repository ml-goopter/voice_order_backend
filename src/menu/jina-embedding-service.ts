import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
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
 */
export class JinaEmbeddingService implements EmbeddingService {
  readonly model = config.embeddingModel;
  readonly dimensions = config.embeddingDimensions;

  constructor() {
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

    const json = await this.post(body);
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

  private async post(body: string): Promise<JinaResponse> {
    let lastErr: unknown;
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

        const detail = `jina_http_${res.status}: ${await res.text()}`;
        if (res.status !== 429 && res.status < 500) throw new Error(detail); // terminal 4xx
        lastErr = new Error(detail); // transient → retry
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('jina_http_4')) throw err;
        lastErr = err; // network/timeout → retry
      }
      logger.warn('embedding.jina.request_failed', { attempt, error: String(lastErr) });
    }
    throw new Error(`jina embedding request failed: ${String(lastErr)}`);
  }
}
