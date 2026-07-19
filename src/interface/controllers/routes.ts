/**
 * REST API surface. All routes are registered here against the container's
 * services and repositories. JSON in / JSON out; errors bubble as AppError.
 *
 * Endpoints:
 *   GET  /api/health
 *   GET  /api/dashboard
 *   GET  /api/products            ?status=
 *   POST /api/products            (add product — manual or by source)
 *   GET  /api/products/:id
 *   POST /api/products/:id/retry
 *   GET  /api/content             ?limit=&offset=
 *   GET  /api/content/:productId
 *   GET  /api/assets              ?productId=
 *   GET  /api/videos
 *   GET  /api/queue
 *   GET  /api/publications        ?status=
 *   GET  /api/analytics
 *   GET  /api/logs                ?level=&productId=&limit=
 *   GET  /api/settings
 *   PUT  /api/settings/brand
 *   PUT  /api/settings/posting-times
 *   POST /api/settings/accounts
 *   DELETE /api/settings/accounts/:id
 *   POST /api/actions/run         (poll sheet + process NEW rows now)
 */
import type { Container } from '../../boot/container.ts';
import type { Router } from '../http/router.ts';
import { ProductStatus, type Platform } from '../../domain/enums.ts';
import { ManualEntrySource } from '../../infrastructure/sources/manual-source.ts';
import { Worker } from '../../worker/worker.ts';
import { ValidationError } from '../../shared/errors.ts';
import { slugify } from '../../shared/ids.ts';
import { logger } from '../../shared/logger.ts';

function num(query: URLSearchParams, key: string, def: number): number {
  const v = Number(query.get(key));
  return Number.isFinite(v) && v > 0 ? v : def;
}

export function registerRoutes(router: Router, container: Container): void {
  const { sheet, repos, services, sources, publishers, config } = container;

  // Note: /api/health, /api/system, /api/metrics, /api/setup/*, and /api/admin/*
  // are registered by registerAdminRoutes (see admin-routes.ts).

  router.get('/api/dashboard', async () => {
    const products = await sheet.listProducts({ limit: 500 });
    const byStatus: Record<string, number> = {};
    for (const s of Object.values(ProductStatus)) byStatus[s] = 0;
    for (const p of products) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
    return {
      stats: services.analytics.dashboard(),
      products: {
        total: products.length,
        waiting: byStatus[ProductStatus.NEW] ?? 0,
        processing:
          (byStatus[ProductStatus.PROCESSING] ?? 0) +
          (byStatus[ProductStatus.PRODUCT_IMPORTED] ?? 0) +
          (byStatus[ProductStatus.CONTENT_CREATED] ?? 0) +
          (byStatus[ProductStatus.VIDEO_CREATED] ?? 0),
        posted: byStatus[ProductStatus.POSTED] ?? 0,
        failed: byStatus[ProductStatus.FAILED] ?? 0,
        byStatus,
      },
      health: { sheet: sheet.kind, storage: container.storage.kind, dryRun: config.publishing.dryRun, ai: container.copyGenerator.name },
    };
  });

  router.get('/api/products', async ({ query }) => {
    const status = query.get('status') as ProductStatus | null;
    const rows = await sheet.listProducts({ status: status ?? undefined, limit: num(query, 'limit', 500) });
    return { products: rows };
  });

  router.get('/api/products/:id', async ({ params }) => {
    const row = await sheet.getProduct(params.id!);
    if (!row) throw new ValidationError('product not found', { id: params.id });
    return {
      product: row,
      content: repos.content.byProduct(params.id!),
      assets: repos.assets.byProduct(params.id!),
      video: repos.videos.byProduct(params.id!),
      publications: repos.publications.byProduct(params.id!),
    };
  });

  router.post('/api/products', async ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const source = String(b.source ?? 'manual').toLowerCase();
    if (!sources.has(source)) throw new ValidationError(`unknown product source "${source}"`, { available: sources.list().map((s) => s.type) });

    const platforms = Array.isArray(b.platforms) ? (b.platforms as string[]).join(',') : String(b.platform ?? '');
    let productId = String(b.productId ?? '').trim();

    if (source === 'manual') {
      if (!b.title) throw new ValidationError('manual products require a title');
      productId = productId || slugify(String(b.title));
      repos.settings.setJson(ManualEntrySource.settingsKey(productId), {
        title: b.title,
        description: b.description,
        features: b.features,
        price: b.price,
        currency: b.currency,
        compareAt: b.compareAt,
        brand: b.brand,
        category: b.category,
        imageUrls: b.imageUrls,
        language: b.language,
        rating: b.rating,
      });
    }

    const row = await sheet.appendProduct({
      status: ProductStatus.NEW,
      productSource: source,
      productUrl: String(b.url ?? ''),
      productId,
      brand: String(b.brand ?? ''),
      platform: platforms,
      language: String(b.language ?? ''),
      category: String(b.category ?? ''),
      scheduleDate: String(b.scheduleDate ?? ''),
      scheduleTime: String(b.scheduleTime ?? ''),
    });
    logger.info('product added via API', { rowId: row.id, source });
    return { row };
  });

  router.post('/api/products/:id/retry', async ({ params }) => {
    await sheet.setStatus(params.id!, ProductStatus.NEW, { error: '' });
    return { ok: true, id: params.id };
  });

  router.get('/api/content', ({ query }) => ({
    content: repos.content.list({ limit: num(query, 'limit', 100), offset: num(query, 'offset', 0) - 0 }),
    total: repos.content.count(),
  }));
  router.get('/api/content/:productId', ({ params }) => ({ content: repos.content.byProduct(params.productId!) }));

  router.get('/api/assets', ({ query }) => {
    const productId = query.get('productId');
    return { assets: productId ? repos.assets.byProduct(productId) : repos.assets.list({ limit: num(query, 'limit', 200) }) };
  });

  router.get('/api/videos', ({ query }) => ({ videos: repos.videos.list({ limit: num(query, 'limit', 100) }), total: repos.videos.count() }));

  router.get('/api/queue', () => ({ counts: repos.jobs.countByStatus(), jobs: repos.jobs.list({ limit: 100 }) }));

  router.get('/api/publications', ({ query }) => ({
    publications: repos.publications.list({ status: query.get('status') ?? undefined, limit: num(query, 'limit', 200) }),
    counts: repos.publications.countByStatus(),
  }));

  router.get('/api/analytics', () => services.analytics.dashboard());

  router.get('/api/logs', ({ query }) => ({
    logs: repos.logs.list({
      level: query.get('level') ?? undefined,
      productId: query.get('productId') ?? undefined,
      limit: num(query, 'limit', 200),
    }),
  }));

  // ---- Settings ----
  router.get('/api/settings', async () => ({
    brand: (await sheet.getBrandSettings()) ?? {
      name: config.brand.name,
      primaryColor: config.brand.primaryColor,
      accentColor: config.brand.accentColor,
      textColor: config.brand.textColor,
      font: config.brand.font,
      watermarkText: config.brand.watermarkText,
      cta: config.brand.defaultCta,
      language: config.brand.defaultLanguage,
    },
    postingTimes: services.settings.getPostingTimes().length ? services.settings.getPostingTimes() : config.automation.postingTimes,
    timezone: config.automation.timezone,
    accounts: services.settings.publicAccounts(),
    secretNames: services.settings.listSecretNames(),
    dryRun: config.publishing.dryRun,
    aiProvider: config.ai.provider,
    sources: sources.list().map((s) => ({ type: s.type, configured: s.isConfigured() })),
    publishers: publishers.list().map((p) => ({ platform: p.platform, configured: p.isConfigured() })),
  }));

  router.put('/api/settings/brand', async ({ body }) => {
    const b = (body ?? {}) as Record<string, string>;
    if (!b.name) throw new ValidationError('brand name is required');
    await services.settings.setBrand({
      name: b.name,
      primaryColor: b.primaryColor || config.brand.primaryColor,
      accentColor: b.accentColor || config.brand.accentColor,
      textColor: b.textColor || config.brand.textColor,
      font: b.font || config.brand.font,
      logoUrl: b.logoUrl,
      watermarkText: b.watermarkText,
      cta: b.cta || config.brand.defaultCta,
      language: b.language || config.brand.defaultLanguage,
    });
    return { ok: true };
  });

  router.put('/api/settings/posting-times', ({ body }) => {
    const b = (body ?? {}) as { times?: string[] };
    if (!Array.isArray(b.times)) throw new ValidationError('times must be an array of HH:mm strings');
    services.settings.setPostingTimes(b.times);
    return { ok: true, times: b.times };
  });

  router.post('/api/settings/accounts', ({ body }) => {
    const b = (body ?? {}) as { platform?: string; label?: string; credentials?: Record<string, unknown>; isDefault?: boolean };
    if (!b.platform || !b.credentials) throw new ValidationError('platform and credentials are required');
    const acct = services.settings.saveAccount(b.platform as Platform, b.label ?? b.platform, b.credentials, !!b.isDefault);
    return { id: acct.id, platform: acct.platform, label: acct.label, isDefault: acct.isDefault };
  });

  router.delete('/api/settings/accounts/:id', ({ params }) => {
    services.settings.removeAccount(params.id!);
    return { ok: true };
  });

  // ---- Actions ----
  router.post('/api/actions/run', async () => {
    const worker = new Worker(container);
    const enqueued = await worker.pollSheet();
    // Process in the background so the HTTP call returns immediately.
    worker.drainToEmpty(config.automation.concurrency).catch((e) => logger.error('background drain failed', { error: (e as Error).message }));
    return {
      enqueued,
      message: enqueued > 0 ? `Enqueued ${enqueued} product(s); processing in the background.` : 'No NEW products to process.',
    };
  });
}
