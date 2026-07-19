/**
 * Setup service — drives the first-run setup wizard: reports what's configured,
 * runs live connection tests, and records completion.
 */
import type { AppConfig } from '../config/index.ts';
import type { Platform } from '../domain/enums.ts';
import type { ICopyGenerator, ISettingsRepository, ISheetStore, ISourceRegistry, IPublisherRegistry } from '../domain/ports.ts';
import { withTimeout } from '../shared/retry.ts';

export interface SetupStep {
  id: string;
  label: string;
  done: boolean;
  detail?: string;
}
export interface SetupStatus {
  complete: boolean;
  dismissed: boolean;
  steps: SetupStep[];
}

export interface TestResult {
  ok: boolean;
  detail: string;
}

export interface SetupDeps {
  settings: ISettingsRepository;
  sheet: ISheetStore;
  config: AppConfig;
  sources: ISourceRegistry;
  publishers: IPublisherRegistry;
  copyGenerator: ICopyGenerator;
}

export class SetupService {
  private d: SetupDeps;
  constructor(deps: SetupDeps) {
    this.d = deps;
  }

  async status(): Promise<SetupStatus> {
    const cfg = this.d.config;
    const keyStrong = cfg.security.encryptionKey.length === 64 && cfg.security.encryptionKey !== '0'.repeat(64);
    const brand = await this.d.sheet.getBrandSettings().catch(() => null);
    const configuredPublishers = this.d.publishers.list().filter((p) => p.isConfigured());
    const configuredSources = this.d.sources.list().filter((s) => s.isConfigured() && s.type !== 'manual' && s.type !== 'csv');
    const aiConfigured = cfg.ai.provider === 'template' || !!this.providerKey();

    const steps: SetupStep[] = [
      { id: 'encryption', label: 'Encryption key set', done: keyStrong, detail: keyStrong ? undefined : 'Set a strong 64-hex ENCRYPTION_KEY' },
      { id: 'brand', label: 'Brand configured', done: !!brand?.name, detail: brand?.name ?? 'Add your brand name, colors, and logo' },
      { id: 'ai', label: 'AI copy provider', done: aiConfigured, detail: `${cfg.ai.provider}${cfg.ai.provider !== 'template' && !this.providerKey() ? ' (missing key)' : ''}` },
      { id: 'sheet', label: 'Product source (sheet)', done: true, detail: `${cfg.sheets.store} store` },
      { id: 'sources', label: 'Store integrations', done: configuredSources.length > 0, detail: configuredSources.length ? configuredSources.map((s) => s.type).join(', ') : 'Manual + CSV ready; connect stores optionally' },
      { id: 'publishers', label: 'Social publishers', done: configuredPublishers.length > 0, detail: configuredPublishers.length ? configuredPublishers.map((p) => p.platform).join(', ') : 'Dry-run until you add tokens' },
    ];

    return {
      complete: this.d.settings.get('setup_complete') === 'true',
      dismissed: this.d.settings.get('setup_dismissed') === 'true',
      steps,
    };
  }

  private providerKey(): string {
    const ai = this.d.config.ai;
    if (ai.provider === 'openai') return ai.openai.apiKey;
    if (ai.provider === 'gemini') return ai.gemini.apiKey;
    if (ai.provider === 'anthropic') return ai.anthropic.apiKey;
    return '';
  }

  markComplete(): void {
    this.d.settings.set('setup_complete', 'true');
  }
  dismiss(): void {
    this.d.settings.set('setup_dismissed', 'true');
  }

  async testSheet(): Promise<TestResult> {
    try {
      await withTimeout(this.d.sheet.listProducts({ limit: 1 }), 15_000, 'sheet');
      return { ok: true, detail: `${this.d.sheet.kind} store reachable` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  async testAi(): Promise<TestResult> {
    const provider = this.d.config.ai.provider;
    if (provider === 'template') return { ok: true, detail: 'Template generator (no key required)' };
    const key = this.providerKey();
    if (!key) return { ok: false, detail: `${provider}: API key not set` };
    return { ok: true, detail: `${provider}: key present` };
  }

  async testPublisher(platform: string): Promise<TestResult> {
    if (!this.d.publishers.has(platform)) return { ok: false, detail: `no publisher for ${platform}` };
    const pub = this.d.publishers.get(platform as Platform);
    if (!pub.isConfigured()) return { ok: false, detail: 'credentials not set (runs in dry-run)' };
    try {
      await withTimeout(pub.connect(), 15_000, platform);
      return { ok: true, detail: 'connected' };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}
