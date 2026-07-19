/**
 * Google Drive storage driver (real Drive v3 REST via fetch + service account).
 * Uploads assets/videos, makes them link-readable, and returns shareable URLs.
 * Used when STORAGE_DRIVER=gdrive; the prototype default is local disk.
 */
import type { IStorage, StoredObject } from '../../domain/ports.ts';
import { httpJson, httpRequest } from '../../shared/http.ts';
import { createLogger } from '../../shared/logger.ts';
import { GoogleAuth, GOOGLE_DRIVE_SCOPES, loadServiceAccount } from '../sheets/google-auth.ts';

const log = createLogger({ mod: 'gdrive-storage' });

export class GoogleDriveStorage implements IStorage {
  readonly kind = 'gdrive' as const;
  private auth: GoogleAuth;
  private folderId: string;
  private keyToId = new Map<string, string>();

  constructor(opts: { folderId: string; serviceAccountFile?: string; serviceAccountJson?: string }) {
    this.folderId = opts.folderId;
    const sa = loadServiceAccount({ file: opts.serviceAccountFile, inlineJson: opts.serviceAccountJson });
    this.auth = new GoogleAuth(sa, GOOGLE_DRIVE_SCOPES);
  }

  localPathFor(key: string): string {
    return key; // not backed by local disk
  }

  publicUrl(key: string): string | undefined {
    const id = this.keyToId.get(key);
    return id ? `https://drive.google.com/uc?export=view&id=${id}` : undefined;
  }

  async put(key: string, data: Buffer, contentType: string): Promise<StoredObject> {
    const token = await this.auth.getAccessToken();
    const boundary = `bnd${Date.now()}${Math.random().toString(36).slice(2)}`;
    const metadata = { name: key.split('/').pop(), parents: this.folderId ? [this.folderId] : undefined };
    const pre = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
      'utf8',
    );
    const post = Buffer.from(`\r\n--${boundary}--`, 'utf8');
    const body = Buffer.concat([pre, data, post]);

    const res = await httpJson<{ id: string; webViewLink?: string; webContentLink?: string }>(
      'https://www.googleapis.com/upload/drive/v3/files',
      {
        method: 'POST',
        provider: 'gdrive',
        query: { uploadType: 'multipart', fields: 'id,webViewLink,webContentLink', supportsAllDrives: true },
        headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` },
        body,
        timeoutMs: 60_000,
      },
    );

    this.keyToId.set(key, res.id);
    // Make link-readable so publishers can fetch the media by URL.
    try {
      await httpJson(`https://www.googleapis.com/drive/v3/files/${res.id}/permissions`, {
        method: 'POST',
        provider: 'gdrive',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: { role: 'reader', type: 'anyone' },
      });
    } catch (e) {
      log.warn('could not set public permission', { error: (e as Error).message });
    }

    return {
      key,
      path: `gdrive://${res.id}`,
      url: res.webContentLink ?? `https://drive.google.com/uc?export=view&id=${res.id}`,
      bytes: data.length,
      contentType,
    };
  }

  async get(key: string): Promise<Buffer> {
    const id = this.keyToId.get(key);
    if (!id) throw new Error(`Unknown Drive object for key ${key}`);
    const token = await this.auth.getAccessToken();
    const res = await httpRequest<Buffer>(`https://www.googleapis.com/drive/v3/files/${id}`, {
      provider: 'gdrive',
      query: { alt: 'media' },
      headers: { authorization: `Bearer ${token}` },
      responseType: 'buffer',
    });
    return res.data;
  }
}
