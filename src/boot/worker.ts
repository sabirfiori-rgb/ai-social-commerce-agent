/**
 * Worker process entrypoint. Run with: `node src/boot/worker.ts`
 * (or `npm run start:worker`). Polls the sheet every N minutes and processes
 * products through the full pipeline.
 */
import { buildContainer } from './container.ts';
import { WorkerRunner } from '../worker/runner.ts';
import { logger } from '../shared/logger.ts';

async function main(): Promise<void> {
  const container = buildContainer();
  await container.init();
  const runner = new WorkerRunner(container);
  await runner.start();

  const shutdown = () => {
    logger.info('shutting down worker');
    runner.stop();
    container.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  logger.error('worker crashed', { error: (e as Error).message, stack: (e as Error).stack });
  process.exit(1);
});
