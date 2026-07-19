/**
 * Google Gemini client — implements ILlmClient against the
 * generativelanguage.googleapis.com `generateContent` REST endpoint.
 *
 * Requires GEMINI_API_KEY (wired via src/config/index.ts -> ai.gemini).
 */
import type { ILlmClient, LlmCompleteRequest } from '../../domain/ports.ts';
import { ExternalApiError, NotConfiguredError } from '../../shared/errors.ts';
import { httpJson } from '../../shared/http.ts';
import { createLogger } from '../../shared/logger.ts';

const log = createLogger({ component: 'gemini-client' });

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

interface GeminiPart {
  text?: string;
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[]; role?: string };
  finishReason?: string;
}

interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

export class GeminiClient implements ILlmClient {
  readonly name = 'gemini';
  private cfg: GeminiConfig;

  constructor(cfg: GeminiConfig) {
    this.cfg = cfg;
  }

  isConfigured(): boolean {
    return !!this.cfg.apiKey;
  }

  private requireConfig(): void {
    if (!this.isConfigured()) {
      throw new NotConfiguredError('gemini', ['GEMINI_API_KEY']);
    }
  }

  async complete(req: LlmCompleteRequest): Promise<string> {
    this.requireConfig();
    const baseUrl = (this.cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const model = this.cfg.model;

    const generationConfig: Record<string, unknown> = {
      temperature: req.temperature ?? 0.8,
    };
    if (req.maxTokens) generationConfig.maxOutputTokens = req.maxTokens;
    if (req.json) generationConfig.responseMimeType = 'application/json';

    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
      generationConfig,
    };
    if (req.system) body.systemInstruction = { role: 'system', parts: [{ text: req.system }] };

    const data = await httpJson<GeminiGenerateContentResponse>(`${baseUrl}/models/${model}:generateContent`, {
      method: 'POST',
      provider: 'gemini',
      query: { key: this.cfg.apiKey },
      headers: { 'content-type': 'application/json' },
      body,
      timeoutMs: 45_000,
      retries: 2,
    });

    if (data.promptFeedback?.blockReason) {
      throw new ExternalApiError('gemini', `Gemini blocked the prompt: ${data.promptFeedback.blockReason}`, {
        responseBody: data,
      });
    }

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .map((p) => p.text ?? '')
      .join('')
      .trim();

    if (!text) {
      log.warn('gemini returned empty completion', { finishReason: data.candidates?.[0]?.finishReason });
      throw new ExternalApiError('gemini', 'Gemini returned no completion content', { responseBody: data });
    }
    return text;
  }
}
