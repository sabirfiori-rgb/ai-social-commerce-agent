/**
 * Seed script — provisions a demo brand + two manual products and adds NEW rows,
 * so the pipeline can be exercised with zero external credentials.
 * The first product includes a real photo; the second demonstrates the branded
 * placeholder used when no product image is available.
 *
 * Usage: node scripts/seed.ts   (optionally SEED_IMAGE=/path/to/photo.jpg)
 */
import { existsSync, readFileSync } from 'node:fs';
import { buildContainer } from '../src/boot/container.ts';
import { ManualEntrySource, type ManualProductPayload } from '../src/infrastructure/sources/manual-source.ts';
import { logger } from '../src/shared/logger.ts';

async function main(): Promise<void> {
  const c = buildContainer();
  await c.init();

  await c.sheet.upsertBrandSettings({
    name: 'Acme Audio',
    primaryColor: '#141E30',
    accentColor: '#E63946',
    textColor: '#FFFFFF',
    font: 'Poppins',
    watermarkText: 'ACME AUDIO',
    cta: 'Shop Now',
    language: 'en',
  });

  const imgPath = process.env.SEED_IMAGE || '/agent/stored_files/cmrrriokq0k4p07adgead4nca_a7549c63-9fd5-4324-9d12-fa80380ffbd4.png';
  const imageUrls: string[] = [];
  if (existsSync(imgPath)) {
    const b = readFileSync(imgPath);
    imageUrls.push(`data:image/jpeg;base64,${b.toString('base64')}`);
    logger.info('seed image embedded', { imgPath, kb: Math.round(b.length / 1024) });
  } else {
    logger.warn('seed image not found; first product will use a branded placeholder', { imgPath });
  }

  const products: { key: string; payload: ManualProductPayload }[] = [
    {
      key: 'aurora-headphones',
      payload: {
        title: 'Aurora Wireless Headphones',
        description:
          'Studio-grade sound engineered for everyday listening. Active noise cancelling, all-day comfort, and 40 hours of battery on a single charge.',
        features: ['Active Noise Cancelling', '40-Hour Battery Life', 'Bluetooth 5.3 Multipoint', 'Memory-foam ear cushions', 'USB-C fast charging'],
        price: 149.99,
        currency: 'USD',
        compareAt: 199.99,
        brand: 'Acme Audio',
        category: 'Premium Audio',
        imageUrls,
        rating: { value: 4.7, count: 1284 },
      },
    },
    {
      key: 'nova-smartwatch',
      payload: {
        title: 'Nova Fitness Smartwatch',
        description: 'Track workouts, sleep, and notifications with a bright AMOLED display and a battery that lasts a full week.',
        features: ['7-Day Battery', 'AMOLED Always-On Display', 'Built-in GPS', 'Heart-rate & SpO2', '5ATM Water Resistant'],
        price: 89.99,
        currency: 'USD',
        compareAt: 119.99,
        brand: 'Acme Audio',
        category: 'Wearables',
        imageUrls: [],
        rating: { value: 4.5, count: 642 },
      },
    },
  ];

  for (const p of products) {
    c.repos.settings.setJson(ManualEntrySource.settingsKey(p.key), p.payload);
    const row = await c.sheet.appendProduct({
      status: 'NEW',
      productSource: 'manual',
      productId: p.key,
      brand: 'Acme Audio',
      platform: 'instagram,facebook,linkedin,pinterest,threads,x',
      language: 'en',
      category: p.payload.category ?? '',
    });
    logger.info('seeded NEW product row', { rowId: row.id, productId: p.key, title: p.payload.title });
  }

  c.close();
}

main().catch((e) => {
  logger.error('seed failed', { error: (e as Error).message });
  process.exit(1);
});
