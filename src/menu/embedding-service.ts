import { config } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Embeds text with the SAME model used for menu vectors (design §7). Stubbed to
 * return a zero vector so the matcher can run without a cloud round-trip.
 * TODO: wire the real embedding provider; re-embed menu on change.
 */
export interface EmbeddingService {
  readonly model: string;
  embed(text: string): Promise<number[]>;
}

export class StubEmbeddingService implements EmbeddingService {
  readonly model = config.embeddingModel;

  async embed(_text: string): Promise<number[]> {
    logger.debug('embedding.stub');
    return [];
  }
}
