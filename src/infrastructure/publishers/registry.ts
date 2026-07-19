/**
 * Publisher registry — resolves a Platform to its adapter.
 * New publishers are registered here (or via a plugin loader) with ZERO
 * changes to the core pipeline, mirroring src/infrastructure/sources/registry.ts.
 */
import type { Platform } from '../../domain/enums.ts';
import type { IPublisher, IPublisherRegistry } from '../../domain/ports.ts';
import { NotFoundError } from '../../shared/errors.ts';

export class PublisherRegistry implements IPublisherRegistry {
  private publishers = new Map<string, IPublisher>();

  register(publisher: IPublisher): void {
    this.publishers.set(publisher.platform, publisher);
  }

  get(platform: Platform | string): IPublisher {
    const key = String(platform).toLowerCase().trim();
    const publisher = this.publishers.get(key);
    if (!publisher) {
      throw new NotFoundError(`No publisher registered for "${platform}"`, {
        available: [...this.publishers.keys()],
      });
    }
    return publisher;
  }

  has(platform: string): boolean {
    return this.publishers.has(String(platform).toLowerCase().trim());
  }

  list(): IPublisher[] {
    return [...this.publishers.values()];
  }
}
