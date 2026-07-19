/**
 * Import service — resolves the right source adapter for a row, validates,
 * connects, imports, downloads images, and normalizes. The product id is bound
 * to the sheet row id so all downstream artifacts link back to the row.
 */
import type { NormalizedProduct } from '../domain/entities.ts';
import type { ISourceRegistry, ProductSourceInput } from '../domain/ports.ts';
import type { ProductRow } from '../domain/sheet-schema.ts';
import { productDedupeKey } from '../shared/ids.ts';

export class ImportService {
  private sources: ISourceRegistry;

  constructor(sources: ISourceRegistry) {
    this.sources = sources;
  }

  async import(row: ProductRow): Promise<NormalizedProduct> {
    const source = this.sources.get(row.productSource || 'manual');
    const input: ProductSourceInput = {
      url: row.productUrl || undefined,
      productId: row.productId || undefined,
      brand: row.brand || undefined,
      language: row.language || undefined,
    };
    source.validate(input);
    await source.connect();
    const raw = await source.importProduct(input);

    const productId = row.id;
    const images = await source.downloadImages(raw, productId);
    const product = source.normalize(raw, images);

    // Bind identity to the sheet row for end-to-end traceability.
    product.id = productId;
    product.dedupeKey = productDedupeKey({
      source: raw.source,
      productId: raw.sourceProductId,
      url: raw.sourceUrl,
      title: raw.title,
    });
    return product;
  }
}
