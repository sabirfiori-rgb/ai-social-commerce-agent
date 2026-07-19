/**
 * OpenAI chat-completions client — implements ILlmClient against the OpenAI
 * (or any OpenAI-compatible) Chat Completions API.
 *
 * Requires OPENAI_API_KEY (wired via src/config/index.ts -> ai.openai).
 */
import type { ILlmClient, LlmCompleteRequest } from '../../domain/ports.ts';
import { ExternalApiError, NotConfiguredError } from '../../shared/errors.ts';
import { httpJson } from '../../shared/http.ts';
import { createLogger } from '../../shared/logger.ts';

const log = createLogger({ component: 'openai-client' });

export interface OpenAiConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

interface OpenAiChatChoice {
  message?: { role?: string; content?: string | null };
  finish_reason?: string;
}

interface OpenAiChatResponse {
  choices?: OpenAiChatChoice[];
  error?: { message?: string };
}

export class OpenAiClient implements ILlmClient {
  readonly name = 'openai';
  private cfg: OpenAiConfig;

  constructor(cfg: OpenAiConfig) {
    this.cfg = cfg;
  }

  isConfigured(): boolean {
    return !!this.cfg.apiKey;
  }

  private requireConfig(): void {
    if (!this.isConfigured()) {
      throw new NotConfiguredError('openai', ['OPENAI_API_KEY']);
    }
  }

  async complete(req: LlmCompleteRequest): Promise<string> {
    this.requireConfig();
    const baseUrl = (this.cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const messages: { role: 'system' | 'user'; content: string }[] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: req.prompt });

    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      temperature: req.temperature ?? 0.8,
    };
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (req.json) body.response_format = { type: 'json_object' };

    const data = await httpJson<OpenAiChatResponse>(`${baseUrl}/chat/completions`, {
      method: 'POST',
      provider: 'openai',
      headers: {
        authorization: `Bearer ${this.cfg.apiKey}`,
        'content-type': 'application/json',
      },
      body,
      timeoutMs: 45_000,
      retries: 2,
    });

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      log.warn('openai returned empty completion', { finishReason: data.choices?.[0]?.finish_reason });
      throw new ExternalApiError('openai', 'OpenAI returned no completion content', { responseBody: data });
    }
    return content;
  }
}
