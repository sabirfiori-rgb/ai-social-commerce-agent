/**
 * Publish service — for each target platform, builds a PublishRequest (correct
 * asset + platform caption + hashtags), decides publish-now vs schedule, invokes
 * the platform adapter, and records a Publication (DB + Publishing Schedule tab).
 * Supports multiple platforms; multi-account is available via the account repo.
 */
import type { GeneratedAsset, GeneratedContent, GeneratedVideo, NormalizedProduct, Publication } from '../domain/entities.ts';
import { PublicationStatus, type Platform } from '../domain/enums.ts';
import type { IPublicationRepository, IPublisherRegistry, ISheetStore, PublishRequest, PublishResult } from '../domain/ports.ts';
import type { ProductRow } from '../domain/sheet-schema.ts';
import { nowIso } from '../shared/clock.ts';
import { prefixedId } from '../shared/ids.ts';
import { createLogger } from '../shared/logger.ts';
import { pickAssetForPlatform, pickCaption } from './selectors.ts';
import type { SchedulerService } from './scheduler-service.ts';

const log = createLogger({ mod: 'publish' });

export interface PublishAllInput {
  product: NormalizedProduct;
  content: GeneratedContent;
  assets: GeneratedAsset[];
  video?: GeneratedVideo;
  platforms: Platform[];
  row: ProductRow;
}

export class PublishService {
  private publishers: IPublisherRegistry;
  private pubRepo: IPublicationRepository;
  private sheet: ISheetStore;
  private scheduler: SchedulerService;

  constructor(publishers: IPublisherRegistry, pubRepo: IPublicationRepository, sheet: ISheetStore, scheduler: SchedulerService) {
    this.publishers = publishers;
    this.pubRepo = pubRepo;
    this.sheet = sheet;
    this.scheduler = scheduler;
  }

  async publishAll(input: PublishAllInput): Promise<Publication[]> {
    const results: Publication[] = [];
    const scheduledAt = this.scheduler.computeScheduledAt(input.row);
    const due = this.scheduler.isDue(scheduledAt);

    for (const platform of input.platforms) {
      if (!this.publishers.has(platform)) {
        log.warn('no publisher registered; skipping', { platform });
        continue;
      }
      const publisher = this.publishers.get(platform);
      const asset = pickAssetForPlatform(input.assets, platform);
      const req: PublishRequest = {
        platform,
        product: input.product,
        content: input.content,
        assets: asset ? [asset] : input.assets,
        video: input.video,
        caption: pickCaption(input.content, platform),
        hashtags: input.content.hashtags,
        scheduledAt: scheduledAt ?? undefined,
      };

      let result: PublishResult;
      try {
        result = due ? await publisher.publish(req) : await publisher.schedule(req, scheduledAt!);
      } catch (e) {
        result = { status: 'failed', error: (e as Error).message };
        log.warn('publish failed', { platform, error: (e as Error).message });
      }

      const now = nowIso();
      const pub: Publication = {
        id: prefixedId('pub'),
        productId: input.product.id,
        platform,
        status: (result.status as Publication['status']) ?? PublicationStatus.failed,
        scheduledAt: scheduledAt ?? undefined,
        publishedAt: result.status === 'published' ? now : undefined,
        remoteId: result.remoteId,
        permalink: result.permalink,
        caption: req.caption,
        error: result.error,
        createdAt: now,
        updatedAt: now,
      };
      this.pubRepo.save(pub);
      try {
        await this.sheet.upsertSchedule(pub);
      } catch (e) {
        log.warn('schedule sheet write failed', { error: (e as Error).message });
      }
      results.push(pub);
    }
    return results;
  }
}
