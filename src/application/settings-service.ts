/**
 * Settings service — brand config, posting times, encrypted social-account
 * credentials, and encrypted secret storage. Credentials are AES-256-GCM
 * encrypted at rest and never returned in plaintext to the API surface.
 */
import type { BrandProfile, SocialAccount } from '../domain/entities.ts';
import type { Platform } from '../domain/enums.ts';
import type { IAccountRepository, ISettingsRepository, ISheetStore } from '../domain/ports.ts';
import { nowIso } from '../shared/clock.ts';
import { decryptSecret, encryptSecret } from '../shared/crypto.ts';
import { prefixedId } from '../shared/ids.ts';

export interface PublicAccount {
  id: string;
  platform: Platform;
  label: string;
  isDefault: boolean;
  createdAt: string;
}

export class SettingsService {
  private settings: ISettingsRepository;
  private accounts: IAccountRepository;
  private sheet: ISheetStore;
  private encKey: string;

  constructor(settings: ISettingsRepository, accounts: IAccountRepository, sheet: ISheetStore, encryptionKey: string) {
    this.settings = settings;
    this.accounts = accounts;
    this.sheet = sheet;
    this.encKey = encryptionKey;
  }

  async getBrand(name?: string): Promise<Partial<BrandProfile> | null> {
    return this.sheet.getBrandSettings(name);
  }
  async setBrand(profile: BrandProfile): Promise<void> {
    await this.sheet.upsertBrandSettings(profile);
  }

  getPostingTimes(): string[] {
    const raw = this.settings.get('posting_times');
    return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  }
  setPostingTimes(times: string[]): void {
    this.settings.set('posting_times', times.join(','));
  }

  setSecret(name: string, value: string): void {
    this.settings.set(`secret:${name}`, encryptSecret(value, this.encKey));
  }
  getSecret(name: string): string | null {
    const raw = this.settings.get(`secret:${name}`);
    return raw ? decryptSecret(raw, this.encKey) : null;
  }
  listSecretNames(): string[] {
    return Object.keys(this.settings.all())
      .filter((k) => k.startsWith('secret:'))
      .map((k) => k.slice('secret:'.length));
  }

  saveAccount(platform: Platform, label: string, credentials: Record<string, unknown>, isDefault = false): SocialAccount {
    const account: SocialAccount = {
      id: prefixedId('acct'),
      platform,
      label,
      encryptedCredentials: encryptSecret(JSON.stringify(credentials), this.encKey),
      isDefault,
      createdAt: nowIso(),
    };
    this.accounts.save(account);
    return account;
  }
  getAccountCredentials(platform: Platform): Record<string, unknown> | null {
    const acct = this.accounts.getDefault(platform);
    if (!acct) return null;
    try {
      return JSON.parse(decryptSecret(acct.encryptedCredentials, this.encKey));
    } catch {
      return null;
    }
  }
  removeAccount(id: string): void {
    this.accounts.remove(id);
  }

  publicAccounts(): PublicAccount[] {
    return this.accounts.list().map((a) => ({ id: a.id, platform: a.platform, label: a.label, isDefault: a.isDefault, createdAt: a.createdAt }));
  }
}
