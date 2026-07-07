import { createApp } from './app.js';
import { logger } from './config/logger.js';

const app = createApp();

app.start().catch((error: unknown) => {
  logger.error('app.start_failed', { error: String(error) });
  process.exit(1);
});

process.on('SIGINT', () => {
  void app.stop().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void app.stop().finally(() => process.exit(0));
});
