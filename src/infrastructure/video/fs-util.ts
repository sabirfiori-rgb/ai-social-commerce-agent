import { existsSync } from 'node:fs';

/** existsSync that never throws (defensive for odd paths). */
export function existsSyncSafe(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}
