/**
 * LlmCopyGenerator — ICopyGenerator backed by any ILlmClient (OpenAI, Gemini,
 * Anthropic, ...). Builds a strict-JSON prompt, calls the model, and parses
 * the response defensively: code fences are stripped, every array field is
 * validated and coerced to the required size, and any field the model omits
 * or gets wrong is backfilled from TemplateCopyGenerator so the returned
 * GeneratedContent is always complete and well-formed.
 */
import type { CaptionSet, GeneratedContent } from '../../domain/entities.ts';
import type { Platform } from '../../domain/enums.ts';
import { ALL_PLATFORMS } from '../../domain/enums.ts';
import type { CopyGenerationContext, ICopyGenerator, ILlmClient } from '../../domain/ports.ts';
import { nowIso } from '../../shared/clock.ts';
import { prefixedId } from '../../shared/ids.ts';
import { createLogger } from '../../shared/logger.ts';
import { TemplateCopyGenerator } from './template-generator.ts';

const log = createLogger({ component: 'llm-copy-generator' });

const HOOKS_COUNT = 10;
const CTAS_COUNT = 5;
const HASHTAGS_COUNT = 30;
const SEO_MIN = 10;
const SEO_MAX = 15;
const VARIATIONS_PER_PLATFORM = 2;
const EMOJIS_MIN = 8;
const EMOJIS_MAX = 12;

interface LlmCaptionShape {
  platform?: string;
  primary?: string;
  variations?: unknown[];
}

interface LlmContentShape {
  captions?: LlmCaptionShape[];
  hooks?: unknown[];
  ctas?: unknown[];
  hashtags?: unknown[];
  seoKeywords?: unknown[];
  emojis?: unknown[];
}

export class LlmCopyGenerator implements ICopyGenerator {
  readonly name: string;
  private client: ILlmClient;
  private fallback: TemplateCopyGenerator;

  constructor(client: ILlmClient) {
    this.client = client;
    this.name = `llm:${client.name}`;
    this.fallback = new TemplateCopyGenerator();
  }

  async generate(ctx: CopyGenerationContext): Promise<GeneratedContent> {
    const fallbackContent = await this.fallback.generate(ctx);

    const system = buildSystemPrompt();
    const prompt = buildUserPrompt(ctx);

    let raw: string;
    try {
      raw = await this.client.complete({ system, prompt, json: true, temperature: 0.85, maxTokens: 4096 });
    } catch (e) {
      log.warn('llm completion failed; using template fallback', { provider: this.client.name, error: (e as Error).message });
      return { ...fallbackContent, provider: this.name };
    }

    const parsed = parseJsonLoose(raw);
    if (!parsed) {
      log.warn('llm response was not valid JSON; using template fallback', { provider: this.client.name });
      return { ...fallbackContent, provider: this.name };
    }

    return this.reconcile(parsed, ctx, fallbackContent);
  }

  private reconcile(parsed: LlmContentShape, ctx: CopyGenerationContext, fallback: GeneratedContent): GeneratedContent {
    const platforms = ctx.platforms.length ? ctx.platforms : ALL_PLATFORMS;

    const captions = reconcileCaptions(parsed.captions, platforms, fallback.captions);
    const hooks = coerceStringArray(parsed.hooks, HOOKS_COUNT, HOOKS_COUNT, fallback.hooks);
    const ctas = coerceStringArray(parsed.ctas, CTAS_COUNT, CTAS_COUNT, fallback.ctas);
    const hashtags = coerceHashtags(parsed.hashtags, fallback.hashtags);
    const seoKeywords = coerceStringArray(parsed.seoKeywords, SEO_MIN, SEO_MAX, fallback.seoKeywords);
    const emojis = coerceStringArray(parsed.emojis, EMOJIS_MIN, EMOJIS_MAX, fallback.emojis);

    return {
      id: prefixedId('gc'),
      productId: ctx.product.id,
      tone: ctx.tone,
      language: ctx.language || ctx.product.language || ctx.brand.language || 'en',
      captions,
      hooks,
      ctas,
      hashtags,
      seoKeywords,
      emojis,
      provider: this.name,
      createdAt: nowIso(),
    };
  }
}

/* ================================ Prompting ================================ */

function buildSystemPrompt(): string {
  return [
    'You are a senior social media copywriter for e-commerce brands.',
    'You write scroll-stopping, platform-native marketing copy that converts.',
    'You ALWAYS respond with a single strict JSON object and nothing else — no markdown, no code fences, no commentary.',
    'The tone the user requests must materially change your word choice, sentence rhythm, and emphasis — do not write generic copy.',
  ].join(' ');
}

function buildUserPrompt(ctx: CopyGenerationContext): string {
  const { product, brand, tone, platforms, language } = ctx;
  const platformList = (platforms.length ? platforms : ALL_PLATFORMS).join(', ');
  const features = (product.features ?? []).join('; ') || 'none listed';
  const price = product.price ? `${product.price.formatted}${product.price.compareAtFormatted ? ` (was ${product.price.compareAtFormatted})` : ''}` : 'not specified';

  return [
    `Write a complete marketing copy package for this product in a "${tone}" tone, in language "${language || 'en'}".`,
    '',
    'PRODUCT:',
    `- Title: ${product.title}`,
    `- Brand: ${product.brand ?? brand.name}`,
    `- Category: ${product.category ?? 'unspecified'}`,
    `- Description: ${product.description || 'none provided'}`,
    `- Key features: ${features}`,
    `- Price: ${price}`,
    '',
    'BRAND:',
    `- Name: ${brand.name}`,
    `- Preferred CTA phrase: ${brand.cta}`,
    '',
    `PLATFORMS to cover (write one caption set per platform, matching that platform's native voice): ${platformList}`,
    '- instagram: emoji-rich, punchy, short line breaks, ends with hashtags',
    '- linkedin: professional, benefit/ROI framing, minimal emoji, paragraph form',
    '- x: 270 characters or fewer, 1-2 hashtags max',
    '- pinterest: keyword-rich, descriptive, discovery-oriented',
    '- facebook: friendly, conversational, a little longer',
    '- threads: casual, short, conversational',
    '',
    'Return STRICT JSON matching exactly this shape (no extra keys, no trailing commentary):',
    '{',
    '  "captions": [ { "platform": "instagram", "primary": "...", "variations": ["...", "..."] }, ... one entry per requested platform, each with exactly 2 variations ... ],',
    `  "hooks": [ ... exactly ${HOOKS_COUNT} distinct scroll-stopping opening lines ... ],`,
    `  "ctas": [ ... exactly ${CTAS_COUNT} short calls to action, respecting the brand's preferred CTA phrase where natural ... ],`,
    `  "hashtags": [ ... exactly ${HASHTAGS_COUNT} lowercase hashtags, each starting with "#", no spaces, deduplicated, relevant to the product/brand/category ... ],`,
    `  "seoKeywords": [ ... ${SEO_MIN} to ${SEO_MAX} SEO keywords/phrases ... ],`,
    `  "emojis": [ ... ${EMOJIS_MIN} to ${EMOJIS_MAX} on-brand emoji characters appropriate to the category and tone ... ]`,
    '}',
  ].join('\n');
}

/* ============================== JSON extraction ============================= */

/** Strip markdown code fences and parse JSON; returns null (never throws) on failure. */
function parseJsonLoose(raw: string): LlmContentShape | null {
  let text = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced) text = fenced[1]!.trim();
  if (!text.startsWith('{')) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as LlmContentShape;
    return null;
  } catch {
    return null;
  }
}

/* ============================== Coercion helpers ============================= */

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function coerceStringArray(input: unknown, min: number, max: number, fallback: string[]): string[] {
  const cleaned = Array.isArray(input) ? input.filter(isNonEmptyString).map((s) => s.trim()) : [];
  const deduped = dedupe(cleaned);
  const target = deduped.length >= min ? Math.min(deduped.length, max) : min;
  const result = deduped.slice(0, target);
  let i = 0;
  while (result.length < target) {
    const filler = fallback[i % Math.max(fallback.length, 1)] ?? `item ${i + 1}`;
    if (!result.some((r) => r.toLowerCase() === filler.toLowerCase())) result.push(filler);
    i++;
    if (i > target + fallback.length + 5) break; // safety valve against pathological loops
  }
  return result;
}

function coerceHashtags(input: unknown, fallback: string[]): string[] {
  const cleaned = Array.isArray(input)
    ? input
        .filter(isNonEmptyString)
        .map((s) => normalizeHashtag(s))
        .filter((s): s is string => !!s)
    : [];
  const deduped = dedupe(cleaned);
  const result = deduped.slice(0, HASHTAGS_COUNT);
  let i = 0;
  while (result.length < HASHTAGS_COUNT) {
    const filler = normalizeHashtag(fallback[i % Math.max(fallback.length, 1)] ?? `tag${i}`) ?? `#tag${i}`;
    if (!result.some((r) => r.toLowerCase() === filler.toLowerCase())) result.push(filler);
    i++;
    if (i > HASHTAGS_COUNT + fallback.length + 5) break;
  }
  return result;
}

function normalizeHashtag(input: string): string | null {
  const stripped = input.trim().replace(/\s+/g, '');
  const withoutHash = stripped.startsWith('#') ? stripped.slice(1) : stripped;
  const slug = withoutHash
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
  return slug ? `#${slug}` : null;
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function reconcileCaptions(input: unknown, platforms: Platform[], fallback: CaptionSet[]): CaptionSet[] {
  const byPlatform = new Map<string, LlmCaptionShape>();
  if (Array.isArray(input)) {
    for (const entry of input) {
      if (entry && typeof entry === 'object' && isNonEmptyString((entry as LlmCaptionShape).platform)) {
        byPlatform.set((entry as LlmCaptionShape).platform!.toLowerCase().trim(), entry as LlmCaptionShape);
      }
    }
  }
  const fallbackByPlatform = new Map(fallback.map((c) => [c.platform, c] as const));

  return platforms.map((platform) => {
    const llm = byPlatform.get(platform);
    const fb = fallbackByPlatform.get(platform) ?? fallback[0];
    const primary = llm && isNonEmptyString(llm.primary) ? llm.primary.trim() : fb?.primary ?? `${platform} caption unavailable`;
    const rawVariations = Array.isArray(llm?.variations) ? llm!.variations!.filter(isNonEmptyString).map((s) => s.trim()) : [];
    const dedupedVariations = dedupe(rawVariations).filter((v) => v.toLowerCase() !== primary.toLowerCase());
    const variations = dedupedVariations.slice(0, VARIATIONS_PER_PLATFORM);
    const fbVariations = fb?.variations ?? [];
    let i = 0;
    while (variations.length < VARIATIONS_PER_PLATFORM) {
      const filler = fbVariations[i % Math.max(fbVariations.length, 1)] ?? `${primary} (alt ${i + 1})`;
      if (!variations.some((v) => v.toLowerCase() === filler.toLowerCase()) && filler.toLowerCase() !== primary.toLowerCase()) {
        variations.push(filler);
      }
      i++;
      if (i > VARIATIONS_PER_PLATFORM + fbVariations.length + 5) {
        variations.push(`${primary} (alt ${variations.length + 1})`);
      }
    }
    return { platform, primary, variations };
  });
}
