/**
 * Source registry — resolves a ProductSourceType to its adapter.
 * New sources are registered here (or via a plugin loader) with ZERO changes to
 * the core pipeline, satisfying the open/closed extensibility requirement.
 */
import type { ProductSourceType } from '../../domain/enums.ts';
import type { IProductSource, ISourceRegistry } from '../../domain/ports.ts';
import { NotFoundError } from '../../shared/errors.ts';

export class SourceRegistry implements ISourceRegistry {
  private sources = new Map<string, IProductSource>();

  register(source: IProductSource): void {
    this.sources.set(source.type, source);
  }

  get(type: ProductSourceType | string): IProductSource {
    const key = String(type).toLowerCase().trim();
    const source = this.sources.get(key);
    if (!source) {
      throw new NotFoundError(`No product source registered for "${type}"`, {
        available: [...this.sources.keys()],
      });
    }
    return source;
  }

  has(type: string): boolean {
    return this.sources.has(String(type).toLowerCase().trim());
  }

  list(): IProductSource[] {
    return [...this.sources.values()];
  }
}
