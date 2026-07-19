/**
 * Local filesystem storage driver. Assets are written under STORAGE_LOCAL_DIR
 * and served by the API's static handler at PUBLIC_BASE_URL/files/<key>.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { IStorage, StoredObject } from '../../domain/ports.ts';

export class LocalStorage implements IStorage {
  readonly kind = 'local' as const;
  private baseDir: string;
  private publicBaseUrl: string;

  constructor(opts: { baseDir: string; publicBaseUrl?: string }) {
    this.baseDir = resolve(process.cwd(), opts.baseDir);
    this.publicBaseUrl = (opts.publicBaseUrl ?? '').replace(/\/$/, '');
    mkdirSync(this.baseDir, { recursive: true });
  }

  localPathFor(key: string): string {
    return join(this.baseDir, key.replace(/^\/+/, ''));
  }

  publicUrl(key: string): string | undefined {
    if (!this.publicBaseUrl) return undefined;
    return `${this.publicBaseUrl}/${key.replace(/^\/+/, '')}`;
  }

  async put(key: string, data: Buffer, contentType: string): Promise<StoredObject> {
    const path = this.localPathFor(key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
    return { key, path, url: this.publicUrl(key), bytes: data.length, contentType };
  }

  async get(key: string): Promise<Buffer> {
    return readFileSync(this.localPathFor(key));
  }
}
