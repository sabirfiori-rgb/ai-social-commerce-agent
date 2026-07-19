/**
 * Notifier — optional outbound webhook on key pipeline events (failures,
 * completions). Failures to notify never break the pipeline.
 */
import type { INotifier, NotifyEvent } from '../../domain/ports.ts';
import { httpJson } from '../../shared/http.ts';
import { nowIso } from '../../shared/clock.ts';
import { createLogger } from '../../shared/logger.ts';

const log = createLogger({ mod: 'notify' });

export class WebhookNotifier implements INotifier {
  private url: string;
  constructor(url: string) {
    this.url = url;
  }
  async notify(event: NotifyEvent): Promise<void> {
    if (!this.url) return;
    try {
      await httpJson(this.url, {
        method: 'POST',
        provider: 'notify-webhook',
        timeoutMs: 8000,
        retries: 1,
        body: { ...event, ts: nowIso() },
      });
    } catch (e) {
      log.warn('notification failed', { error: (e as Error).message, type: event.type });
    }
  }
}

export class NoopNotifier implements INotifier {
  async notify(): Promise<void> {
    /* no-op */
  }
}

export function createNotifier(webhookUrl: string): INotifier {
  return webhookUrl ? new WebhookNotifier(webhookUrl) : new NoopNotifier();
}
