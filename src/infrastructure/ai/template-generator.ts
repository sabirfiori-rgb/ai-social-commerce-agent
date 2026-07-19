/**
 * TemplateCopyGenerator — the deterministic, zero-key default ICopyGenerator.
 *
 * No network calls, no LLM. Produces genuinely varied, platform-appropriate
 * marketing copy purely from the product/brand data and a per-tone phrase
 * bank. This is what the pipeline falls back to when no AI provider is
 * configured, and it is also reused by LlmCopyGenerator to backfill any
 * field an LLM response is missing.
 */
import type { CaptionSet, GeneratedContent, NormalizedProduct, BrandProfile } from '../../domain/entities.ts';
import type { Platform, Tone } from '../../domain/enums.ts';
import type { CopyGenerationContext, ICopyGenerator } from '../../domain/ports.ts';
import { nowIso } from '../../shared/clock.ts';
import { prefixedId } from '../../shared/ids.ts';

/* ============================== Tone lexicon ============================= */

interface ToneVoice {
  /** Short adjectives/phrases used to describe the product. */
  descriptors: string[];
  /** Sentence-level openers for body copy. */
  openers: string[];
  /** Closing lines that precede the CTA. */
  closers: string[];
  /** Hook prefixes/templates — {title} / {benefit} get substituted. */
  hookTemplates: string[];
  /** Extra punctuation/emphasis style, e.g. all-caps word, exclamation density. */
  emphasis: (s: string) => string;
  /** Emoji palette biased toward this tone. */
  emojis: string[];
}

const TONE_VOICE: Record<Tone, ToneVoice> = {
  professional: {
    descriptors: ['engineered', 'reliable', 'purpose-built', 'refined', 'consistent', 'dependable'],
    openers: [
      'Built for people who expect more from their everyday tools.',
      'Designed with a clear focus: performance you can count on.',
      'Every detail here serves a purpose.',
    ],
    closers: [
      'A smart, considered addition to your day.',
      'Quality that holds up to real use, every day.',
      'Made to perform, built to last.',
    ],
    hookTemplates: [
      'Meet {title} — built for how you actually work.',
      'The details that matter, finally in one product.',
      'Here is what changes when your gear just works.',
      'A better standard for {category}, starting today.',
      'Consistency you can rely on, day after day.',
    ],
    emphasis: (s) => s,
    emojis: ['✅', '📈', '🔧', '💼', '🎯', '⚙️', '📊', '🤝'],
  },
  friendly: {
    descriptors: ['easy-to-love', 'comfy', 'delightful', 'thoughtful', 'welcoming', 'everyday-perfect'],
    openers: [
      "Okay, we're genuinely excited about this one.",
      'This is the kind of product that just makes your day a little better.',
      "You're going to want to tell your friends about this.",
    ],
    closers: [
      "We think you're going to love it as much as we do.",
      'Give it a try — your future self will thank you.',
      'Small thing, big smile. That is the idea.',
    ],
    hookTemplates: [
      'Say hello to your new favorite thing: {title}.',
      "Okay, we need to talk about {title}.",
      'This might just make your whole week better.',
      "Warning: you're going to want one of these.",
      'The little upgrade your routine has been missing.',
    ],
    emphasis: (s) => s,
    emojis: ['😊', '🙌', '💛', '✨', '🥳', '👋', '🌟', '☀️'],
  },
  luxury: {
    descriptors: ['exquisite', 'meticulously crafted', 'timeless', 'rare', 'effortless', 'uncompromising'],
    openers: [
      'Some things are made. This was crafted.',
      'There is a quiet confidence in getting every detail right.',
      'Luxury is not louder — it is more precise.',
    ],
    closers: [
      'Reserved for those who notice the difference.',
      'An understated statement, made to last generations.',
      'Because the details are never an afterthought.',
    ],
    hookTemplates: [
      'Introducing {title} — where craft meets restraint.',
      'Not for everyone. Exactly as intended.',
      'The art of doing less, done perfectly.',
      'An heirloom in the making: {title}.',
      'Precision, in its most elegant form.',
    ],
    emphasis: (s) => s,
    emojis: ['🖤', '✨', '💎', '🥂', '🕊️', '🤍', '🪶', '🔱'],
  },
  minimal: {
    descriptors: ['clean', 'essential', 'quiet', 'considered', 'unadorned', 'precise'],
    openers: ['Less, but better.', 'Only what belongs.', 'Form follows function. Nothing else.'],
    closers: ['Nothing extra. Nothing missing.', 'Simple, by design.', 'Just the essentials, done right.'],
    hookTemplates: ['{title}. Nothing more to say.', 'Simple. Considered. {title}.', 'Less noise. More {benefit}.', 'The essentials, reimagined.', 'Quiet design. Loud results.'],
    emphasis: (s) => s,
    emojis: ['⚪', '⬜', '◻️', '🤍', '➖', '🔘', '⚫', '◯'],
  },
  funny: {
    descriptors: ['ridiculously good', 'suspiciously great', 'annoyingly perfect', 'unreasonably useful', 'weirdly addictive'],
    openers: [
      "We're not saying this will change your life. We're saying it kind of will.",
      'Look, we tried to find something wrong with it. We failed.',
      "This is your sign to stop scrolling and start shopping (we won't tell anyone)."
    ],
    closers: [
      "Don't say we didn't warn you.",
      "You'll wonder how you lived without it (dramatic, but true).",
      'Add to cart before your inner monologue talks you out of it.',
    ],
    hookTemplates: [
      'POV: you finally stop settling for mediocre {category}.',
      "We put {title} through the wringer so you don't have to.",
      'Plot twist: this actually lives up to the hype.',
      "Your old {category} just got served notice.",
      "Nobody asked, but here's why {title} is kind of a big deal.",
    ],
    emphasis: (s) => s,
    emojis: ['😂', '👀', '🔥', '🙃', '🤯', '😎', '🫠', '📦'],
  },
  sales: {
    descriptors: ['unbeatable', 'high-value', 'best-selling', 'proven', 'crowd-favorite', 'top-rated'],
    openers: [
      'Here is the deal everyone is talking about.',
      'The offer is simple: more value, less compromise.',
      "This is the upgrade that pays for itself."
    ],
    closers: [
      'Grab yours before this run sells out.',
      'Limited stock. Unlimited satisfaction.',
      'The best time to buy is always right now.',
    ],
    hookTemplates: [
      "Everyone's talking about {title}. Here's why.",
      'The best-seller you keep hearing about, explained.',
      'This is the deal your cart has been waiting for.',
      "Stop overpaying for basic {category}.",
      'The upgrade that pays for itself, starting today.',
    ],
    emphasis: (s) => s.toUpperCase(),
    emojis: ['🔥', '💥', '🛒', '💸', '🏆', '⭐', '📣', '✅'],
  },
  urgent: {
    descriptors: ['almost gone', 'in high demand', 'selling fast', 'last-chance', 'time-sensitive', 'limited-run'],
    openers: [
      'This will not last long — and neither will the stock.',
      'Demand is outpacing supply. Move quickly.',
      'The clock is already running on this one.',
    ],
    closers: ['Do not wait until it is gone.', 'Once it sells out, that is it.', 'Act now — restocks are not guaranteed.'],
    hookTemplates: [
      'Selling out fast: {title} is almost gone.',
      'Last call for {title} — stock will not last.',
      'This drops off shelves within hours. Here is why.',
      "Don't wait: {category} like this doesn't restock fast.",
      'The countdown is on for {title}.',
    ],
    emphasis: (s) => s.toUpperCase(),
    emojis: ['⏰', '🚨', '⚡', '🔥', '⏳', '❗', '📉', '🏃'],
  },
};

/* ================================ Helpers ================================ */

function pick<T>(arr: T[], seed: number): T {
  if (arr.length === 0) throw new Error('pick() called on empty array');
  return arr[((seed % arr.length) + arr.length) % arr.length]!;
}

function topFeatures(product: NormalizedProduct, n: number): string[] {
  return (product.features ?? []).filter(Boolean).slice(0, n);
}

function benefitPhrase(product: NormalizedProduct): string {
  const feature = topFeatures(product, 1)[0];
  if (feature) return feature.toLowerCase();
  if (product.category) return `everyday ${product.category.toLowerCase()}`;
  return 'everyday performance';
}

function priceLine(product: NormalizedProduct): string | undefined {
  if (!product.price) return undefined;
  const { formatted, compareAtFormatted } = product.price;
  if (compareAtFormatted && compareAtFormatted !== formatted) {
    return `Now ${formatted} (was ${compareAtFormatted}).`;
  }
  return `Just ${formatted}.`;
}

function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, key: string) => vars[key] ?? '');
}

function dedupeCaseInsensitive(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item.trim());
  }
  return out;
}

function padOrTrim<T>(items: T[], count: number, filler: (i: number) => T): T[] {
  const out = items.slice(0, count);
  let i = out.length;
  while (out.length < count) {
    out.push(filler(i));
    i++;
  }
  return out;
}

function slugTag(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/* ============================== Hashtag builder ============================ */

function buildHashtags(product: NormalizedProduct, brand: BrandProfile, tone: Tone): string[] {
  const base: string[] = [];
  const titleWords = product.title.split(/\s+/).filter((w) => w.length > 2).slice(0, 6);

  base.push(slugTag(product.title));
  for (const w of titleWords) base.push(slugTag(w));
  if (product.brand) base.push(slugTag(product.brand));
  base.push(slugTag(brand.name));
  if (product.category) {
    base.push(slugTag(product.category));
    base.push(slugTag(`${product.category}lovers`));
    base.push(slugTag(`shop${product.category}`));
  }
  for (const f of topFeatures(product, 6)) {
    const words = f.split(/\s+/).filter((w) => w.length > 2);
    for (const w of words.slice(0, 2)) base.push(slugTag(w));
    base.push(slugTag(words.join('')));
  }

  const generic = [
    'newarrival',
    'mustbuy',
    'shopsmall',
    'onlineshopping',
    'productoftheday',
    'trending',
    'giftideas',
    'dailydeals',
    'shopnow',
    'nowavailable',
    'qualityfirst',
    'customerfavorite',
    'bestseller',
    'shoplocal',
    'retailtherapy',
  ];
  const toneTag: Record<Tone, string[]> = {
    professional: ['builtforperformance', 'engineeredforlife', 'reliablebydesign'],
    friendly: ['loveitordoubleback', 'everydayjoy', 'feelgoodfinds'],
    luxury: ['luxurylifestyle', 'craftedwithcare', 'timelessdesign'],
    minimal: ['minimalistdesign', 'lessismore', 'cleanaesthetic'],
    funny: ['noregrets', 'treatyourself', 'toogoodtorefuse'],
    sales: ['limitedoffer', 'bestvalue', 'saveonline'],
    urgent: ['sellingfast', 'lastchance', 'whilesupplieslast'],
  };

  const candidates = dedupeCaseInsensitive([...base, ...toneTag[tone], ...generic])
    .map((t) => slugTag(t))
    .filter((t) => t.length >= 3);

  const baseSlug = slugTag(product.title) || 'product';
  const padded = padOrTrim(candidates, 30, (i) => `${baseSlug}pick${i}`);
  const tagged = padded.map((t) => `#${t}`);

  // Final guarantee of exactly 30 unique, well-formed tags.
  const unique = dedupeCaseInsensitive(tagged);
  return padOrTrim(unique, 30, (idx) => `#${baseSlug}${idx}`);
}

/* ============================ SEO keyword builder ========================== */

function buildSeoKeywords(product: NormalizedProduct, tone: Tone): string[] {
  const out: string[] = [];
  out.push(product.title.toLowerCase());
  if (product.brand) out.push(`${product.brand} ${product.category ?? product.title}`.toLowerCase().trim());
  if (product.category) {
    out.push(`best ${product.category.toLowerCase()}`);
    out.push(`buy ${product.category.toLowerCase()} online`);
    out.push(`${product.category.toLowerCase()} for sale`);
  }
  for (const f of topFeatures(product, 6)) {
    out.push(f.toLowerCase());
    if (product.category) out.push(`${product.category.toLowerCase()} with ${f.toLowerCase()}`);
  }
  out.push(`${product.title.toLowerCase()} review`);
  out.push(`${product.title.toLowerCase()} price`);
  const toneKeyword: Record<Tone, string> = {
    professional: 'professional grade',
    friendly: 'everyday favorite',
    luxury: 'premium quality',
    minimal: 'minimalist design',
    funny: 'fan favorite',
    sales: 'best deal',
    urgent: 'limited stock',
  };
  out.push(`${toneKeyword[tone]} ${product.category ?? product.title}`.toLowerCase());

  const unique = dedupeCaseInsensitive(out).filter(Boolean);
  const trimmed = unique.slice(0, 15);
  const target = Math.max(10, trimmed.length); // land in the 10-15 range, never fewer than 10
  return padOrTrim(trimmed, target, (i) => `${product.title.toLowerCase()} keyword ${i}`);
}

/* =============================== Emoji builder ============================= */

const CATEGORY_EMOJI: Record<string, string[]> = {
  audio: ['🎧', '🔊', '🎶'],
  headphones: ['🎧', '🔊', '🎶'],
  electronics: ['🔌', '📱', '💡'],
  fashion: ['👗', '👜', '🧵'],
  apparel: ['👕', '🧥', '👖'],
  beauty: ['💄', '🧴', '🌸'],
  skincare: ['🧴', '🌿', '✨'],
  home: ['🏠', '🕯️', '🛋️'],
  kitchen: ['🍳', '🍽️', '🥘'],
  fitness: ['💪', '🏋️', '🏃'],
  jewelry: ['💍', '💎', '📿'],
  food: ['🍽️', '🍰', '🥗'],
  toys: ['🧸', '🎲', '🪁'],
  outdoor: ['🏞️', '⛺', '🥾'],
};

function categoryEmojis(category?: string): string[] {
  if (!category) return [];
  const key = category.toLowerCase();
  for (const [k, v] of Object.entries(CATEGORY_EMOJI)) {
    if (key.includes(k)) return v;
  }
  return [];
}

function buildEmojis(product: NormalizedProduct, tone: Tone): string[] {
  const toneEmojis = TONE_VOICE[tone].emojis;
  const catEmojis = categoryEmojis(product.category);
  const combined = dedupeCaseInsensitive([...catEmojis, ...toneEmojis, '🛍️', '📦', '💯', '👍']).slice(0, 12);
  return padOrTrim(combined, Math.max(8, combined.length), () => '✨');
}

/* ================================ Hooks / CTAs ============================= */

function buildHooks(product: NormalizedProduct, tone: Tone): string[] {
  const voice = TONE_VOICE[tone];
  const vars = {
    title: product.title,
    category: product.category ?? 'products',
    benefit: benefitPhrase(product),
  };
  const fromTemplates = voice.hookTemplates.map((t) => fillTemplate(t, vars));
  const extra: string[] = [];
  const features = topFeatures(product, 5);
  for (const f of features) {
    extra.push(voice.emphasis(`This ${product.category ?? 'product'} comes with ${f.toLowerCase()} — here is why that matters.`));
  }
  extra.push(voice.emphasis(`${product.title}: the upgrade you did not know you needed.`));
  extra.push(voice.emphasis(`Here is what makes ${product.title} different.`));
  extra.push(voice.emphasis(`Why everyone keeps asking about ${product.title}.`));
  extra.push(voice.emphasis(`${product.brand ?? 'We'} built ${product.title} for exactly this moment.`));

  const merged = dedupeCaseInsensitive([...fromTemplates, ...extra]);
  return padOrTrim(merged, 10, (i) => voice.emphasis(`${product.title} — reason #${i + 1} to make the switch.`));
}

function buildCtas(brand: BrandProfile, tone: Tone): string[] {
  const base = brand.cta?.trim() || 'Shop now';
  const voice = TONE_VOICE[tone];
  const templates: Record<Tone, string[]> = {
    professional: [base, `${base} — see the details`, 'Explore the specs', 'Request more info', 'Compare and decide'],
    friendly: [base, `${base}, you deserve it`, 'Grab yours today', 'Treat yourself', 'Add it to your cart'],
    luxury: [base, `${base}, quietly`, 'Discover the collection', 'Reserve yours', 'Experience it firsthand'],
    minimal: [base, 'View details', 'Explore', 'See more', 'Learn more'],
    funny: [base, `${base} (you know you want to)`, 'Add to cart, no regrets', "Don't overthink it — buy it", 'Make it yours'],
    sales: [`${base} — limited stock`, 'Claim your discount', 'Get the deal now', 'Save while it lasts', base],
    urgent: [`${base} before it sells out`, 'Act now — stock is limited', "Don't miss out", 'Buy before it is gone', 'Secure yours today'],
  };
  const merged = dedupeCaseInsensitive(templates[tone].map((c) => voice.emphasis(c)));
  return padOrTrim(merged, 5, (i) => voice.emphasis(`${base} #${i + 1}`));
}

/* ============================ Platform caption builders ==================== */

function buildInstagramCaption(product: NormalizedProduct, brand: BrandProfile, tone: Tone, variant: number): string {
  const voice = TONE_VOICE[tone];
  const hook = pick(voice.hookTemplates, variant).replace('{title}', product.title).replace('{category}', product.category ?? 'faves').replace('{benefit}', benefitPhrase(product));
  const opener = pick(voice.openers, variant + 1);
  const features = topFeatures(product, 3);
  const featureLines = features.map((f) => `${pick(['✔️', '➤', '•'], variant)} ${f}`).join('\n');
  const price = priceLine(product);
  const closer = pick(voice.closers, variant + 2);
  const emoji1 = pick(voice.emojis, variant);
  const emoji2 = pick(voice.emojis, variant + 3);

  const lines = [
    voice.emphasis(`${hook} ${emoji1}`),
    '',
    opener,
    '',
    featureLines,
    '',
    price ? `${price} ${emoji2}` : '',
    closer,
    '',
    brand.cta,
  ].filter((l) => l !== undefined);

  const body = lines.join('\n').trim();
  const hashtagLine = buildHashtags(product, brand, tone).slice(0, 8).join(' ');
  return `${body}\n\n${hashtagLine}`;
}

function buildLinkedinCaption(product: NormalizedProduct, brand: BrandProfile, tone: Tone, variant: number): string {
  const voice = TONE_VOICE[tone];
  const feature = topFeatures(product, 3);
  const roiLine = feature.length
    ? `The result: ${feature.map((f) => f.toLowerCase()).join(', ')} — delivered without unnecessary complexity.`
    : 'The result: measurable performance without unnecessary complexity.';

  const paragraphs = [
    `${product.brand ?? brand.name} is introducing ${product.title}${product.category ? `, a new benchmark in ${product.category.toLowerCase()}` : ''}.`,
    pick(voice.openers, variant),
    roiLine,
    pick(voice.closers, variant + 1),
    `${brand.cta}: link in the comments.`,
  ];
  return paragraphs.join('\n\n');
}

function buildXCaption(product: NormalizedProduct, brand: BrandProfile, tone: Tone, variant: number): string {
  const voice = TONE_VOICE[tone];
  const hook = pick(voice.hookTemplates, variant).replace('{title}', product.title).replace('{category}', product.category ?? 'this').replace('{benefit}', benefitPhrase(product));
  const price = priceLine(product);
  const tags = buildHashtags(product, brand, tone).slice(0, 2).join(' ');
  let text = `${voice.emphasis(hook)} ${price ?? ''} ${brand.cta}. ${tags}`.replace(/\s+/g, ' ').trim();
  if (text.length > 270) text = `${text.slice(0, 267).trimEnd()}...`;
  return text;
}

function buildPinterestCaption(product: NormalizedProduct, brand: BrandProfile, tone: Tone, variant: number): string {
  const voice = TONE_VOICE[tone];
  const features = topFeatures(product, 4);
  const keywordBits = [product.title, product.category, product.brand, ...features].filter(Boolean).join(' | ');
  const desc = `${product.title}${product.category ? ` — ${product.category}` : ''}. ${features.join(', ')}. ${pick(voice.descriptors, variant)} pick for anyone who wants ${benefitPhrase(product)}. ${brand.cta}.`;
  return `${keywordBits}\n${desc}`.trim();
}

function buildFacebookCaption(product: NormalizedProduct, brand: BrandProfile, tone: Tone, variant: number): string {
  const voice = TONE_VOICE[tone];
  const opener = pick(voice.openers, variant);
  const features = topFeatures(product, 3);
  const price = priceLine(product);
  const closer = pick(voice.closers, variant + 1);
  const parts = [
    `${opener} Meet ${product.title}.`,
    features.length ? `Here's what you get: ${features.join(', ')}.` : '',
    price ?? '',
    closer,
    brand.cta,
  ].filter(Boolean);
  return parts.join(' ');
}

function buildThreadsCaption(product: NormalizedProduct, brand: BrandProfile, tone: Tone, variant: number): string {
  const voice = TONE_VOICE[tone];
  const hook = pick(voice.hookTemplates, variant).replace('{title}', product.title).replace('{category}', product.category ?? 'this').replace('{benefit}', benefitPhrase(product));
  const feature = topFeatures(product, 1)[0];
  const bits = [voice.emphasis(hook), feature ? `also — ${feature.toLowerCase()}.` : '', brand.cta.toLowerCase()].filter(Boolean);
  return bits.join(' ');
}

const PLATFORM_BUILDERS: Record<Platform, (p: NormalizedProduct, b: BrandProfile, t: Tone, v: number) => string> = {
  instagram: buildInstagramCaption,
  linkedin: buildLinkedinCaption,
  x: buildXCaption,
  pinterest: buildPinterestCaption,
  facebook: buildFacebookCaption,
  threads: buildThreadsCaption,
};

function buildCaptionSet(platform: Platform, product: NormalizedProduct, brand: BrandProfile, tone: Tone): CaptionSet {
  const builder = PLATFORM_BUILDERS[platform] ?? buildFacebookCaption;
  const primary = builder(product, brand, tone, 0);
  const variations = dedupeCaseInsensitive([builder(product, brand, tone, 1), builder(product, brand, tone, 2)]);
  const finalVariations = padOrTrim(variations, 2, (i) => `${primary} (v${i + 2})`);
  return { platform, primary, variations: finalVariations };
}

/* ================================ Generator ================================ */

export class TemplateCopyGenerator implements ICopyGenerator {
  readonly name = 'template';

  async generate(ctx: CopyGenerationContext): Promise<GeneratedContent> {
    const { product, brand, tone, platforms } = ctx;
    const captions = platforms.map((platform) => buildCaptionSet(platform, product, brand, tone));

    return {
      id: prefixedId('gc'),
      productId: product.id,
      tone,
      language: ctx.language || product.language || brand.language || 'en',
      captions,
      hooks: buildHooks(product, tone),
      ctas: buildCtas(brand, tone),
      hashtags: buildHashtags(product, brand, tone),
      seoKeywords: buildSeoKeywords(product, tone),
      emojis: buildEmojis(product, tone),
      provider: 'template',
      createdAt: nowIso(),
    };
  }
}
