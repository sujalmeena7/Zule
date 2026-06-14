// ============================================
// Zule AI — GeminiAdapter
// ============================================
//
// Pluggable `Provider_Adapter` for Google's Generative Language API
// (Gemini family). This adapter is a thin data-plane shim:
//
//   - Authentication is header-based via `x-goog-api-key` (Requirement 4.6).
//     The API key is NEVER appended to the URL as a query parameter, which
//     keeps it out of browser history, server access logs, and Telemetry
//     breadcrumbs (Property 11).
//   - Per-request timeouts and retry-with-jitter are delegated to the
//     shared HTTP utilities in `./http.ts` (Requirements 4.4, 4.5).
//   - SSE streaming uses the chunk-boundary-safe parser in
//     `../sse.ts` (Requirement 4.8); naive `\n` splitting that the legacy
//     `aiProvider.ts` used is replaced with event-boundary detection.
//   - Caller `AbortSignal` propagates to the underlying fetch and to the
//     reader so that the stream is cancelled within 200 ms of abort and
//     `onComplete` is never invoked after abort (Requirement 4.7).
//
// The adapter is purposely free of router / failover concerns; those live
// in `AI_Provider_Router` (task 8.9).

import { parseSseFrames } from '../sse';
import {
  fetchWithTimeout,
  parseRetryAfter,
  retryWithJitter,
} from './http';
import type {
  Capabilities,
  CallOpts,
  ProviderAdapter,
  ProviderHttpError,
  ProviderResponse,
  PromptInput,
  StreamCallbacks,
} from './types';

// --- Constants -----------------------------------------------------------

/** Stable identifier used in `ProviderResponse.providerId` and routing. */
const PROVIDER_ID = 'gemini' as const;

/** Default model when the router (or caller) does not supply `opts.modelId`. */
const DEFAULT_MODEL_ID = 'gemini-2.0-flash';

/** Generative Language base URL. The model id is path-segmented in. */
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/** API-key header name (per the Gemini REST docs). */
const API_KEY_HEADER = 'x-goog-api-key';

/**
 * Default capability descriptor. Tuned for `gemini-2.0-flash` (the default
 * model). Callers that prefer a different default tier should override
 * `capabilities.maxInputTokens` and `pricePerMTokens` via constructor
 * options. The router's `selectModel` is the place where per-tier
 * capability shape is finally resolved (task 2.15).
 */
const DEFAULT_CAPABILITIES: Capabilities = {
  streaming: true,
  imageInput: true,
  toolUse: false,
  // gemini-2.0-flash advertises a 1M token window; we conservatively cap
  // the context-builder budget at 32 000 to keep payloads small and
  // latency bounded. Override via `capabilities.maxInputTokens`.
  maxInputTokens: 32_000,
  // Public list price for gemini-2.0-flash.
  pricePerMTokens: { input: 0.075, output: 0.3 },
};

// --- Public options ------------------------------------------------------

export interface GeminiAdapterOptions {
  /** API key. Stored in memory; passed only via the `x-goog-api-key` header. */
  apiKey: string;
  /** Override the default model id (`gemini-2.0-flash`). */
  defaultModelId?: string;
  /** Override the default capability descriptor. */
  capabilities?: Capabilities;
  /** Override the base URL (test harnesses, regional endpoints). */
  baseUrl?: string;
  /** Injectable `fetch` for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

// --- Adapter -------------------------------------------------------------

/**
 * Gemini implementation of the `ProviderAdapter` contract. Exposes
 * `streamGenerate`, `complete`, and `countTokens`.
 */
export class GeminiAdapter implements ProviderAdapter {
  readonly name = PROVIDER_ID;
  readonly capabilities: Capabilities;

  private readonly apiKey: string;
  private readonly defaultModelId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof fetch;

  constructor(opts: GeminiAdapterOptions) {
    if (!opts.apiKey || !opts.apiKey.trim()) {
      throw new Error('GeminiAdapter requires a non-empty apiKey');
    }
    this.apiKey = opts.apiKey;
    this.defaultModelId = opts.defaultModelId ?? DEFAULT_MODEL_ID;
    this.capabilities = opts.capabilities ?? DEFAULT_CAPABILITIES;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl;
  }

  /**
   * Rough character-based token estimator. Gemini tokens average ~4
   * characters of English text per token; the Generative Language
   * `countTokens` REST endpoint exists but a remote round-trip is far too
   * expensive for the prompt-budget loop in `Context_Builder`. The
   * estimate is conservative for budget enforcement: it slightly
   * over-counts on dense text, which is exactly what we want when
   * choosing whether to drop a section.
   */
  countTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Non-streaming `:generateContent` call. Returns the parsed text and the
   * provider-reported usage (falling back to the local estimator when the
   * response omits `usageMetadata`).
   */
  async complete(prompt: PromptInput, opts: CallOpts): Promise<ProviderResponse> {
    const modelId = opts.modelId ?? this.defaultModelId;
    const url = this.endpoint(modelId, ':generateContent');
    const body = JSON.stringify(buildRequestBody(prompt, opts));

    const response = await retryWithJitter(
      () =>
        fetchWithTimeout(
          url,
          {
            method: 'POST',
            headers: this.buildHeaders(),
            body,
          },
          {
            kind: 'non-streaming',
            timeoutMs: opts.timeoutMs,
            signal: opts.signal,
            fetchImpl: this.fetchImpl,
          },
        ).then(throwIfNotOk),
      { signal: opts.signal },
    );

    const json = (await response.json()) as unknown;
    const text = extractText(json);
    const usage = extractUsage(json, prompt, text, this);

    return {
      text,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      modelId,
      providerId: PROVIDER_ID,
      isSimulated: false,
      status: response.status,
    };
  }

  /**
   * Streaming `:streamGenerateContent?alt=sse` call. Parses SSE frames
   * with the chunk-boundary-safe parser, accumulates text, and invokes
   * the callbacks per Requirement 4.7:
   *
   *   - `cb.onToken` is called with the cumulative text on every frame
   *     that contributed new text.
   *   - `cb.onComplete` is invoked exactly once on a successful stream
   *     and never after the caller's abort signal fires.
   *   - `cb.onError` is invoked for mid-stream errors (after the initial
   *     fetch has succeeded). Errors during the initial fetch (including
   *     non-2xx status after retries are exhausted) are thrown so the
   *     router can fail over to the next adapter (Requirement 4.3).
   */
  async streamGenerate(
    prompt: PromptInput,
    cb: StreamCallbacks,
    opts: CallOpts,
  ): Promise<void> {
    const modelId = opts.modelId ?? this.defaultModelId;
    const url = this.endpoint(modelId, ':streamGenerateContent?alt=sse');
    const body = JSON.stringify(buildRequestBody(prompt, opts));

    // Initial connection (with retries on transient HTTP failures). If we
    // exhaust retries the error escapes — the router treats that as a
    // failover trigger.
    const response = await retryWithJitter(
      () =>
        fetchWithTimeout(
          url,
          {
            method: 'POST',
            headers: this.buildHeaders(),
            body,
          },
          {
            kind: 'streaming',
            timeoutMs: opts.timeoutMs,
            signal: opts.signal,
            fetchImpl: this.fetchImpl,
          },
        ).then(throwIfNotOk),
      { signal: opts.signal },
    );

    const reader = response.body?.getReader();
    if (!reader) {
      const err = new Error('GeminiAdapter: response has no readable stream');
      cb.onError(err);
      return;
    }

    // If the caller has already aborted, cancel the reader and exit
    // without producing any callback output.
    if (opts.signal?.aborted) {
      await reader.cancel().catch(() => {});
      return;
    }

    // Wire abort to reader.cancel() so cancellation propagates within one
    // event-loop tick. We remove the listener in `finally` to avoid
    // dangling references after a normal completion.
    let abortHandler: (() => void) | undefined;
    if (opts.signal) {
      abortHandler = () => {
        reader.cancel().catch(() => {});
      };
      opts.signal.addEventListener('abort', abortHandler, { once: true });
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let cumulativeText = '';
    let lastUsageJson: unknown = null;

    try {
      while (true) {
        if (opts.signal?.aborted) return;
        const { done, value } = await reader.read();
        if (done) break;
        if (value) buffer += decoder.decode(value, { stream: true });

        const { events, rest } = parseSseFrames(buffer);
        buffer = rest;
        for (const evt of events) {
          if (!evt.data) continue;
          // Some providers terminate with a literal `[DONE]` frame; Gemini
          // does not, but we tolerate it for robustness.
          if (evt.data === '[DONE]') continue;

          let parsed: unknown;
          try {
            parsed = JSON.parse(evt.data);
          } catch {
            // Malformed frame — skip. The pure SSE parser already handles
            // chunk-boundary correctness; a JSON parse failure here means
            // the provider sent something we don't recognise.
            continue;
          }

          const partText = extractText(parsed);
          if (partText) {
            cumulativeText += partText;
            cb.onToken(cumulativeText);
          }
          // Gemini reports `usageMetadata` on the final frame; keep the
          // most-recent one we see for the `onComplete` payload.
          const maybeUsage = (parsed as { usageMetadata?: unknown })?.usageMetadata;
          if (maybeUsage && typeof maybeUsage === 'object') {
            lastUsageJson = parsed;
          }
        }
      }
    } catch (err) {
      // Aborts during streaming flush silently per Requirement 4.7.
      if (opts.signal?.aborted) return;
      cb.onError(err instanceof Error ? err : new Error(String(err)));
      return;
    } finally {
      if (opts.signal && abortHandler) {
        opts.signal.removeEventListener('abort', abortHandler);
      }
      try {
        reader.releaseLock();
      } catch {
        /* reader already released or cancelled — ignore */
      }
    }

    // Honour late aborts: if the signal fired between the last `read()`
    // returning `done` and here, do not emit `onComplete`.
    if (opts.signal?.aborted) return;

    const usage = extractUsage(lastUsageJson, prompt, cumulativeText, this);
    cb.onComplete({
      text: cumulativeText,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      modelId,
      providerId: PROVIDER_ID,
      isSimulated: false,
      status: response.status,
    });
  }

  // --- Internal --------------------------------------------------------

  private endpoint(modelId: string, suffix: string): string {
    // The model id is path-segmented; encode to keep the URL safe even
    // for unusual characters. The API key NEVER appears in the URL —
    // that's the entire point of Requirement 4.6.
    return `${this.baseUrl}/${encodeURIComponent(modelId)}${suffix}`;
  }

  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      [API_KEY_HEADER]: this.apiKey,
    };
  }
}

// --- Helpers (module-private) -------------------------------------------

/** Builds the `generateContent` JSON body. Pure, no side-effects. */
function buildRequestBody(
  prompt: PromptInput,
  opts: CallOpts,
): Record<string, unknown> {
  // Prefer the fully-assembled prompt produced by `Context_Builder`. Fall
  // back to `userText` for callers (e.g., tests) that do not assemble a
  // structured prompt.
  const userText = prompt.fullPrompt || prompt.userText || '';
  const parts: Array<Record<string, unknown>> = [{ text: userText }];

  // Optional inline image attachments (Requirement 23.3). The
  // `Capabilities.imageInput` flag is consulted at the router layer;
  // adapters trust the input here.
  if (prompt.images && prompt.images.length > 0) {
    for (const img of prompt.images) {
      parts.push({
        inlineData: { mimeType: img.mimeType, data: img.base64 },
      });
    }
  }

  const generationConfig: Record<string, unknown> = {
    temperature: opts.temperature ?? 0.7,
  };
  if (opts.maxOutputTokens !== undefined) {
    generationConfig.maxOutputTokens = opts.maxOutputTokens;
  }

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts }],
    generationConfig,
  };

  if (prompt.systemPrompt) {
    body.systemInstruction = { parts: [{ text: prompt.systemPrompt }] };
  }

  return body;
}

/**
 * Throws a `ProviderHttpError` carrying `status` and (when present)
 * `retryAfterMs`. The `status` field is what the default retry classifier
 * in `./http.ts` keys on (4.5: 429 / 5xx are retryable).
 */
async function throwIfNotOk(response: Response): Promise<Response> {
  if (response.ok) return response;

  let bodyText = '';
  try {
    bodyText = await response.text();
  } catch {
    /* ignore */
  }

  const message =
    `GeminiAdapter: HTTP ${response.status} ${response.statusText}` +
    (bodyText ? ` — ${bodyText.slice(0, 200)}` : '');

  const err = new Error(message) as ProviderHttpError;
  err.providerId = PROVIDER_ID;
  err.status = response.status;
  const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
  if (retryAfter !== null) err.retryAfterMs = retryAfter;
  throw err;
}

/** Concatenates every `parts[].text` field from `candidates[0].content`. */
function extractText(json: unknown): string {
  if (!json || typeof json !== 'object') return '';
  const candidates = (json as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return '';
  const cand = candidates[0] as { content?: { parts?: unknown } };
  const parts = cand?.content?.parts;
  if (!Array.isArray(parts)) return '';
  let text = '';
  for (const p of parts) {
    if (
      p &&
      typeof p === 'object' &&
      typeof (p as { text?: unknown }).text === 'string'
    ) {
      text += (p as { text: string }).text;
    }
  }
  return text;
}

/**
 * Resolves prompt/completion token counts. Prefers the provider-reported
 * `usageMetadata` when available; otherwise falls back to the adapter's
 * local estimator so cost/budget reporting always returns a number.
 */
function extractUsage(
  json: unknown,
  prompt: PromptInput,
  responseText: string,
  adapter: { countTokens(t: string): number },
): { promptTokens: number; completionTokens: number } {
  const usage =
    json &&
    typeof json === 'object' &&
    typeof (json as { usageMetadata?: unknown }).usageMetadata === 'object'
      ? ((json as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } })
          .usageMetadata ?? {})
      : {};

  const promptText = prompt.fullPrompt || prompt.userText || '';
  const promptTokens =
    typeof usage.promptTokenCount === 'number' && usage.promptTokenCount >= 0
      ? usage.promptTokenCount
      : adapter.countTokens(promptText);
  const completionTokens =
    typeof usage.candidatesTokenCount === 'number' &&
    usage.candidatesTokenCount >= 0
      ? usage.candidatesTokenCount
      : adapter.countTokens(responseText);

  return { promptTokens, completionTokens };
}
