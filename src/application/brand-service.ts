/**
 * Resolves the effective BrandProfile for a product row by layering:
 *   sheet Brand Settings (by brand name)  >  environment defaults.
 */
import type { BrandProfile } from '../domain/entities.ts';
import type { ISheetStore } from '../domain/ports.ts';
import type { ProductRow } from '../domain/sheet-schema.ts';
import type { AppConfig } from '../config/index.ts';

export class BrandService {
  private sheet: ISheetStore;
  private config: AppConfig;

  constructor(sheet: ISheetStore, config: AppConfig) {
    this.sheet = sheet;
    this.config = config;
  }

  async resolve(row: ProductRow): Promise<BrandProfile> {
    const b = this.config.brand;
    const fromSheet = (await this.sheet.getBrandSettings(row.brand || undefined)) ?? {};
    return {
      name: row.brand || fromSheet.name || b.name,
      primaryColor: fromSheet.primaryColor || b.primaryColor,
      accentColor: fromSheet.accentColor || b.accentColor,
      textColor: fromSheet.textColor || b.textColor,
      font: fromSheet.font || b.font,
      logoUrl: fromSheet.logoUrl || b.logoUrl || undefined,
      watermarkText: fromSheet.watermarkText ?? b.watermarkText,
      cta: fromSheet.cta || b.defaultCta,
      language: row.language || fromSheet.language || b.defaultLanguage,
    };
  }
}
