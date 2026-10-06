/**
 * Gemini API client — shared by notes, study tools, embeddings and Q&A.
 *
 * - API key goes in the `x-goog-api-key` header (never in the URL, so it can't leak
 *   through logs, proxies or error messages).
 * - Retries 429 / 5xx with exponential backoff.
 * - Refuses truncated output (finishReason MAX_TOKENS) instead of silently saving it.
 * - Supports JSON-schema constrained output for structured extraction.
 */

import type { Logger } from 'pino';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiClientOptions {
  apiKey?: string;
  model?: string;
  embeddingModel?: string;
  logger?: Logger;
  /** Max attempts per request (default 4) */
  maxAttempts?: number;
  /** Base backoff in ms (default 1500). Tests set this to 0. */
  backoffMs?: number;
}

export interface GenerateOptions {
  system?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Gemini responseSchema (OpenAPI subset). Implies application/json output. */
  schema?: Record<string, unknown>;
}

export class GeminiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'GeminiError';
  }
}

export class GeminiClient {
  private readonly apiKey: string;
  readonly model: string;
  readonly embeddingModel: string;
  private readonly logger?: Logger;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;

  constructor(options: GeminiClientOptions = {}) {
    this.apiKey = options.apiKey || process.env['GEMINI_API_KEY'] || '';
    this.model = options.model || 'gemini-2.5-flash';
    this.embeddingModel = options.embeddingModel || 'gemini-embedding-001';
    this.logger = options.logger?.child({ component: 'gemini' });
    this.maxAttempts = options.maxAttempts ?? 4;
    this.backoffMs = options.backoffMs ?? 1500;
  }

  get hasKey(): boolean {
    return this.apiKey.length > 0;
  }

  private requireKey(): void {
    if (!this.apiKey) {
      throw new GeminiError(
        'GEMINI_API_KEY no está configurada. Añádela en tu archivo .env para usar las funciones de IA.'
      );
    }
  }

  /** POST with retry/backoff on 429 and 5xx. Never includes the key in thrown messages. */
  private async post(url: string, body: unknown): Promise<any> {
    this.requireKey();
    let lastError: GeminiError | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify(body),
        });
      } catch (err) {
        lastError = new GeminiError(`No se pudo contactar con Gemini: ${(err as Error).message}`);
        await this.sleep(attempt);
        continue;
      }

      if (response.ok) return response.json();

      const errorBody = await response.text().catch(() => '');
      lastError = new GeminiError(
        `Error en la API de Gemini (${response.status} ${response.statusText}): ${errorBody.slice(0, 500)}`,
        response.status
      );

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) throw lastError;

      this.logger?.warn({ status: response.status, attempt }, 'Gemini request failed, retrying');
      await this.sleep(attempt);
    }

    throw lastError ?? new GeminiError('Gemini request failed');
  }

  private async sleep(attempt: number): Promise<void> {
    if (this.backoffMs <= 0 || attempt >= this.maxAttempts) return;
    await new Promise((r) => setTimeout(r, this.backoffMs * 2 ** (attempt - 1)));
  }

  /** Generate text. Throws on empty or truncated output. */
  async generateText(prompt: string, options: GenerateOptions = {}): Promise<string> {
    const generationConfig: Record<string, unknown> = {
      temperature: options.temperature ?? 0.2,
    };
    if (options.maxOutputTokens) generationConfig['maxOutputTokens'] = options.maxOutputTokens;
    if (options.schema) {
      generationConfig['responseMimeType'] = 'application/json';
      generationConfig['responseSchema'] = options.schema;
    }

    const data = await this.post(`${API_ROOT}/models/${this.model}:generateContent`, {
      ...(options.system ? { systemInstruction: { parts: [{ text: options.system }] } } : {}),
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig,
    });

    const candidate = data?.candidates?.[0];
    // Skip "thought" parts that thinking models may emit before the answer.
    const parts: { text?: string; thought?: boolean }[] = candidate?.content?.parts ?? [];
    const text = parts
      .filter((p) => !p.thought && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');

    if (!text) {
      const reason = candidate?.finishReason ?? data?.promptFeedback?.blockReason ?? 'desconocido';
      throw new GeminiError(`Gemini no devolvió texto en su respuesta (motivo: ${reason}).`);
    }
    if (candidate?.finishReason === 'MAX_TOKENS') {
      throw new GeminiError(
        'La respuesta de Gemini se cortó por límite de tokens (MAX_TOKENS); no se guarda un resultado incompleto.'
      );
    }
    return text;
  }

  /** Generate and parse schema-constrained JSON. */
  async generateJson<T>(prompt: string, schema: Record<string, unknown>, options: Omit<GenerateOptions, 'schema'> = {}): Promise<T> {
    const text = await this.generateText(prompt, { ...options, schema });
    try {
      return JSON.parse(text) as T;
    } catch {
      // Defensive: strip a stray markdown fence if the model added one.
      const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
      try {
        return JSON.parse(stripped) as T;
      } catch {
        throw new GeminiError('Gemini devolvió JSON no válido.');
      }
    }
  }

  /**
   * Embed texts in batches. Use taskType RETRIEVAL_DOCUMENT for chunks and
   * RETRIEVAL_QUERY for questions. Vectors are L2-normalised (required when the
   * output is truncated with outputDimensionality).
   */
  async embed(
    texts: string[],
    taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY',
    dimensions = 768
  ): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    const BATCH = 50;

    for (let i = 0; i < texts.length; i += BATCH) {
      const slice = texts.slice(i, i + BATCH);
      const data = await this.post(`${API_ROOT}/models/${this.embeddingModel}:batchEmbedContents`, {
        requests: slice.map((text) => ({
          model: `models/${this.embeddingModel}`,
          content: { parts: [{ text }] },
          taskType,
          outputDimensionality: dimensions,
        })),
      });

      const embeddings: { values: number[] }[] = data?.embeddings ?? [];
      if (embeddings.length !== slice.length) {
        throw new GeminiError('Gemini devolvió un número inesperado de embeddings.');
      }
      for (const e of embeddings) vectors.push(normalize(Float32Array.from(e.values)));
    }
    return vectors;
  }
}

export function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

/** Dot product of two normalised vectors == cosine similarity. */
export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}
