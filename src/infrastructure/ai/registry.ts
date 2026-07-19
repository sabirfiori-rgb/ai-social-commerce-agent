/**
 * AI registry — resolves an AiProvider selection to a concrete ICopyGenerator
 * (and exposes the underlying ILlmClient builders for anything that wants the
 * raw LLM, e.g. future creative/copy-editing features).
 *
 * 'template' always yields the deterministic, zero-key TemplateCopyGenerator.
 * 'openai' | 'gemini' | 'anthropic' yield an LlmCopyGenerator wrapping the
 * matching client IF that client has credentials configured; otherwise this
 * silently (with a logged warning) falls back to the template generator so
 * the pipeline never breaks for lack of an API key.
 */
import type { ICopyGenerator, ILlmClient } from '../../domain/ports.ts';
import { createLogger } from '../../shared/logger.ts';
import { AnthropicClient, type AnthropicConfig } from './anthropic-client.ts';
import { GeminiClient, type GeminiConfig } from './gemini-client.ts';
import { LlmCopyGenerator } from './llm-generator.ts';
import { OpenAiClient, type OpenAiConfig } from './openai-client.ts';
import { TemplateCopyGenerator } from './template-generator.ts';

const log = createLogger({ component: 'ai-registry' });

export type AiProviderName = 'template' | 'openai' | 'gemini' | 'anthropic';

export interface AiRegistryOptions {
  provider: AiProviderName;
  openai?: OpenAiConfig;
  gemini?: GeminiConfig;
  anthropic?: AnthropicConfig;
}

/** Build every ILlmClient the registry knows about, regardless of which provider is selected. */
export function buildLlmClients(opts: AiRegistryOptions): { openai: OpenAiClient; gemini: GeminiClient; anthropic: AnthropicClient } {
  return {
    openai: new OpenAiClient(opts.openai ?? { apiKey: '', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' }),
    gemini: new GeminiClient(opts.gemini ?? { apiKey: '', model: 'gemini-1.5-flash' }),
    anthropic: new AnthropicClient(opts.anthropic ?? { apiKey: '', model: 'claude-3-5-sonnet-latest' }),
  };
}

/** Build the ILlmClient matching a specific provider name (throws for 'template', which has no LLM client). */
export function buildLlmClient(provider: Exclude<AiProviderName, 'template'>, opts: AiRegistryOptions): ILlmClient {
  const clients = buildLlmClients(opts);
  return clients[provider];
}

/**
 * Resolve the configured AiProvider to a ready-to-use ICopyGenerator.
 * Never throws for missing credentials — falls back to the template
 * generator (with a warning) so copy generation always succeeds.
 */
export function createCopyGenerator(opts: AiRegistryOptions): ICopyGenerator {
  if (opts.provider === 'template') {
    return new TemplateCopyGenerator();
  }

  const clients = buildLlmClients(opts);
  const client = clients[opts.provider];

  if (!client) {
    log.warn('unknown AI provider requested; falling back to template generator', { provider: opts.provider });
    return new TemplateCopyGenerator();
  }

  if (!client.isConfigured()) {
    log.warn('AI provider selected but not configured (missing API key); falling back to template generator', {
      provider: opts.provider,
    });
    return new TemplateCopyGenerator();
  }

  return new LlmCopyGenerator(client);
}
