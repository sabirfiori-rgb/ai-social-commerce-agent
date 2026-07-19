/**
 * Combined entrypoint — runs the API server AND the polling worker in one
 * process. Run with: `node src/main.ts` (or `npm start`). Ideal for single-node
 * deployments; split into src/boot/api.ts + src/boot/worker.ts to scale out.
 */
import { buildContainer } from './boot/container.ts';
import { createHttpServer } from './interface/http/server.ts';
import { WorkerRunner } from './worker/runner.ts';
import { logger } from './shared/logger.ts';

async function main(): Promise<void> {
  const container = buildContainer();
  await container.init();

  const server = createHttpServer(container);
  server.listen(container.config.http.port, container.config.http.host, () => {
    logger.info('API listening', { url: `http://${container.config.http.host}:${container.config.http.port}` });
  });

  const runner = new WorkerRunner(container);
  await runner.start();

  const shutdown = () => {
    logger.info('shutting down');
    runner.stop();
    server.close();
    container.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  logger.error('app crashed', { error: (e as Error).message, stack: (e as Error).stack });
  process.exit(1);
});
