/**
 * API-only process entrypoint. Run with: `node src/boot/api.ts`
 * (or `npm run start:api`). Serves the REST API + dashboard SPA.
 * Product processing is triggered on-demand via POST /api/actions/run, or run a
 * separate worker process (src/boot/worker.ts) for continuous polling.
 */
import { buildContainer } from './container.ts';
import { createHttpServer } from '../interface/http/server.ts';
import { logger } from '../shared/logger.ts';

async function main(): Promise<void> {
  const container = buildContainer();
  await container.init();
  const server = createHttpServer(container);
  server.listen(container.config.http.port, container.config.http.host, () => {
    logger.info('API listening', {
      url: `http://${container.config.http.host}:${container.config.http.port}`,
      publicBaseUrl: container.config.http.publicBaseUrl,
    });
  });

  const shutdown = () => {
    logger.info('shutting down API');
    server.close();
    container.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  logger.error('api crashed', { error: (e as Error).message, stack: (e as Error).stack });
  process.exit(1);
});
