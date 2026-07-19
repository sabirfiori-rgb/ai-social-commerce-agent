/**
 * Storage factory — selects the local disk or Google Drive driver from config.
 */
import type { IStorage } from '../../domain/ports.ts';
import type { AppConfig } from '../../config/index.ts';
import { LocalStorage } from './local-storage.ts';
import { GoogleDriveStorage } from './google-drive-storage.ts';

export function createStorage(config: AppConfig): IStorage {
  if (config.storage.driver === 'gdrive') {
    return new GoogleDriveStorage({
      folderId: config.storage.gdriveFolderId,
      serviceAccountFile: config.sheets.serviceAccountFile,
      serviceAccountJson: config.sheets.serviceAccountJson,
    });
  }
  return new LocalStorage({ baseDir: config.storage.localDir, publicBaseUrl: config.storage.publicBaseUrl });
}
