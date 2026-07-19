/**
 * Anthropic Messages API client — implements ILlmClient against
 * api.anthropic.com/v1/messages.
 *
 * Requires ANTHROPIC_API_KEY (wired via src/config/index.ts -> ai.anthropic).
 */
import type { ILlmClient, LlmCompleteRequest } from '../../domain/ports.ts';
import { ExternalApiError, NotConfiguredError } from '../../shared/errors.ts';
import { httpJson } from '../../shared/http.ts';
import { createLogger } from '../../shared/logger.ts';

const log = createLogger({ component: 'anthropic-client' });

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicConfig {
  apiKey: string;
  model: string;
}

interface AnthropicContentBlock {
  type?: string;
  text?: string;
}

interface AnthropicMessagesResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  error?: { message?: string; type?: string };
}

export class AnthropicClient implements ILlmClient {
  readonly name = 'anthropic';
  private cfg: AnthropicConfig;

  constructor(cfg: AnthropicConfig) {
    this.cfg = cfg;
  }

  isConfigured(): boolean {
    return !!this.cfg.apiKey;
  }

  private requireConfig(): void {
    if (!this.isConfigured()) {
      throw new NotConfiguredError('anthropic', ['ANTHROPIC_API_KEY']);
    }
  }

  async complete(req: LlmCompleteRequest): Promise<string> {
    this.requireConfig();

    const body: Record<string, unknown> = {
      model: this.cfg.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: req.temperature ?? 0.8,
      messages: [{ role: 'user', content: req.prompt }],
    };
    if (req.system) body.system = req.system;

    const data = await httpJson<AnthropicMessagesResponse>('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      provider: 'anthropic',
      headers: {
        'x-api-key': this.cfg.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body,
      timeoutMs: 45_000,
      retries: 2,
    });

    const text = (data.content ?? [])
      .filter((b) => (b.type ? b.type === 'text' : true))
      .map((b) => b.text ?? '')
      .join('')
      .trim();

    if (!text) {
      log.warn('anthropic returned empty completion', { stopReason: data.stop_reason });
      throw new ExternalApiError('anthropic', 'Anthropic returned no completion content', { responseBody: data });
    }
    return text;
  }
}
