import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { JinaEmbeddingService } from './jina-embedding-service.js';

/**
 * Embeds text with the SAME model used for menu vectors (design §7). The concrete
 * provider is chosen by config so the model can be swapped via env alone
 * (`createEmbeddingService`), mirroring `createLlmProvider` / `createSttProvider`.
 *
 * `role` is an asymmetric-retrieval hint: menu names are 'passage', customer
 * transcripts are 'query'. Providers without task-typed embeddings ignore it.
 */
export type EmbedRole = 'query' | 'passage';

export interface EmbeddingService {
  readonly model: string;
  /** Vector width the provider emits; 0 for the stub. */
  readonly dimensions: number;
  embed(text: string, role?: EmbedRole): Promise<number[]>;
  embedBatch(texts: string[], role?: EmbedRole): Promise<number[][]>;
}

/** No-op embedder: empty vectors so the matcher runs without a cloud round-trip. */
export class StubEmbeddingService implements EmbeddingService {
  readonly model = config.embeddingModel;
  readonly dimensions = 0;

  async embed(_text: string, _role?: EmbedRole): Promise<number[]> {
    logger.debug('embedding.stub');
    return [];
  }

  async embedBatch(texts: string[], _role?: EmbedRole): Promise<number[][]> {
    return texts.map(() => []);
  }
}

/** Single swap point: add a `case` to change/extend the embedding provider. */
export function createEmbeddingService(): EmbeddingService {
  switch (config.embeddingProvider) {
    case 'jina':
      return new JinaEmbeddingService();
    default:
      return new StubEmbeddingService();
  }
}
