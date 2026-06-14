// ============================================
// Zule AI — OpenAIAdapter
// ============================================
//
// Pluggable `Provider_Adapter` for OpenAI's Chat Completions API,
// including the o-series reasoning models. The adapter is a thin
// data-plane shim:
//
//   - Authentication is header-based via `Authorization: Bearer <key>`
//     (Requirement 4.6). The API key NEVER appears in the URL — that
//     keeps it out of browser history, server access logs, and Telemetry
//     breadcrumbs (Property 11).
//   - Per-request timeouts and retry-with-jitter are delegated to the
//     shared HTTP utilities in `./http.ts` (Requirements 4.4, 4.5).
//   - SSE streaming uses the chunk-boundary-safe parser in `../sse.ts`
//     (Requirement 4.8). OpenAI emits a literal `data: [DONE]` frame
//     to terminate the stream, which we handle explicitly.
//   - Caller `AbortSignal` propagates to the underlying fetch and to
//     the reader so that the stream is cancelled within 200 ms of
//     abort and `onComplete` is never invoked after abort
//     (Requirement 4.7).
//
// The adapter is purposely free of router / failover concerns; those
// live in `AI_Provider_Router` (task 8.9).

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
const PROVIDER_ID = 'openai' as const;

/** Default model when the router (or caller) does not supply `opts.modelId`. */
const DEFAULT_MODEL_ID = 'gpt-4o-mini';

/** Chat Completions endpoint. The model id rides in the JSON body, not the URL. */
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** Authorization header carrying the bearer token. */
const AUTH_HEADER = 'Authorization';

/** Sentinel emitted by OpenAI to terminate an SSE stream. */
const DONE_SENTINEL = '[DONE]';

/**
 * Default capability descriptor. Tuned for `gpt-4o-mini` (the default
 * model). The router resolves per-tier capability shape via
 * `selectModel` (task 2.15) so callers that prefer a different default
 * can override `capabilities.maxInputTokens` and `pricePerMTokens` via
 * constructor options.
 */
const DEFAULT_CAPABILITIES: Capabilities = {
  streaming: true,
  imageInput: true,
  toolUse: true,
  // gpt-4o-mini advertises a 128k token context window.
  maxInputTokens: 128_000,
  // Public list price for gpt-4o-mini as of the design freeze.
  pricePerMTokens: { input: 0.15, output: 0.6 },
};

/**
 * Models in the o-series (o1, o1-mini, o3, o3-mini, …) reject
 * `temperature` and `max_tokens` and instead use `max_completion_tokens`.
 * The check is intentionally permissive (prefix match) so future
 * variants behave correctly without a code change.
 */
function isOSeriesModel(modelId: string): boolean {
  return /^o\d/.test(modelId);
}

// --- Public options ------------------------------------------------------

export interface OpenAIAdapterOptions {
  /** API key. Stored in memory; passed only via the `Authorization` header. */
  apiKey: string;
  /** Override the default model id (`gpt-4o-mini`). */
  defaultModelId?: string;
  /** Override the default capability descriptor. */
  capabilities?: Capabilities;
  /** Override the base URL (test harnesses, OpenAI-compatible runtimes). */
  baseUrl?: string;
  /** Optional organization id forwarded as `OpenAI-Organization`. */
  organization?: string;
  /** Injectable `fetch` for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

// --- Adapter -------------------------------------------------------------

/**
 * OpenAI implementation of the `ProviderAdapter` contract. Exposes
 * `streamGenerate`, `complete`, and `countTokens`.
 */
export class OpenAIAdapter implements ProviderAdapter {
  readonly name = PROVIDER_ID;
  readonly capabilities: Capabilities;

  private readonly apiKey: string;
  private readonly defaultModelId: string;
  private readonly baseUrl: string;
  private readonly organization: string | undefined;
  private readonly fetchImpl?: typeof fetch;

  constructor(opts: OpenAIAdapterOptions) {
    if (!opts.apiKey || !opts.apiKey.trim()) {
      throw new Error('OpenAIAdapter requires a non-empty apiKey');
    }
    this.apiKey = opts.apiKey;
    this.defaultModelId = opts.defaultModelId ?? DEFAULT_MODEL_ID;
    this.capabilities = opts.capabilities ?? DEFAULT_CAPABILITIES;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.organization = opts.organization;
    this.fetchImpl = opts.fetchImpl;
  }

  /**
   * Rough character-based token estimator. OpenAI's BPE tokens average
   * ~4 characters of English text per token; running the real
   * `tiktoken` encoder in the prompt-budget loop is too expensive and
   * pulls a large WASM dependency. The estimate is conservative for
   * budget enforcement: it slightly over-counts on dense text, which
   * is the safe direction for the `Context_Builder` drop decision.
   */
  countTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Non-streaming `/v1/chat/completions` call (`stream: false`). Returns
   * the parsed text and the provider-reported usage (falling back to
   * the local estimator when the response omits `usage`).
   */
  async complete(prompt: PromptInput, opts: CallOpts): Promise<ProviderResponse> {
    const modelId = opts.modelId ?? this.defaultModelId;
    const url = this.endpoint('/chat/completions');
    const body = JSON.stringify(buildRequestBody(modelId, prompt, opts, false));

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
    const text = extractMessageContent(json);
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
   * Streaming `/v1/chat/completions` call (`stream: true`). Parses SSE
   * frames with the chunk-boundary-safe parser, accumulates text, and
   * invokes the callbacks per Requirement 4.7:
   *
   *   - `cb.onToken` is called with the cumulative text on every frame
   *     that contributed new text.
   *   - `cb.onComplete` is invoked exactly once on a successful stream
   *     and never after the caller's abort signal fires.
   *   - `cb.onError` is invoked for mid-stream errors (after the
   *     initial fetch has succeeded). Errors during the initial fetch
   *     (including non-2xx status after retries are exhausted) are
   *     thrown so the router can fail over to the next adapter
   *     (Requirement 4.3).
   */
  async streamGenerate(
    prompt: PromptInput,
    cb: StreamCallbacks,
    opts: CallOpts,
  ): Promise<void> {
    const modelId = opts.modelId ?? this.defaultModelId;
    const url = this.endpoint('/chat/completions');
    const body = JSON.stringify(buildRequestBody(modelId, prompt, opts, true));

    // Initial connection (with retries on transient HTTP failures). If
    // we exhaust retries the error escapes — the router treats that as
    // a failover trigger.
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
      const err = new Error('OpenAIAdapter: response has no readable stream');
      cb.onError(err);
      return;
    }

    // If the caller has already aborted, cancel the reader and exit
    // without producing any callback output.
    if (opts.signal?.aborted) {
      await reader.cancel().catch(() => {});
      return;
    }

    // Wire abort to reader.cancel() so cancellation propagates within
    // one event-loop tick. We remove the listener in `finally` to avoid
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
          // OpenAI terminates the stream with a literal `[DONE]` frame.
          if (evt.data === DONE_SENTINEL) continue;

          let parsed: unknown;
          try {
            parsed = JSON.parse(evt.data);
          } catch {
            // Malformed frame — skip. The pure SSE parser already
            // handles chunk-boundary correctness; a JSON parse failure
            // here means the provider sent something we don't
            // recognise.
            continue;
          }

          const partText = extractDeltaContent(parsed);
          if (partText) {
            cumulativeText += partText;
            cb.onToken(cumulativeText);
          }
          // OpenAI only reports `usage` on the final chunk when the
          // request includes `stream_options.include_usage = true`,
          // but we tolerate either shape and keep the most-recent
          // payload that carried it.
          const maybeUsage = (parsed as { usage?: unknown })?.usage;
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

  private endpoint(path: string): string {
    // The API key NEVER appears in the URL — that's the entire point
    // of Requirement 4.6.
    return `${this.baseUrl}${path}`;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      [AUTH_HEADER]: `Bearer ${this.apiKey}`,
    };
    if (this.organization) {
      headers['OpenAI-Organization'] = this.organization;
    }
    return headers;
  }
}

// --- Helpers (module-private) -------------------------------------------

/**
 * Builds the `chat/completions` JSON body. Pure, no side-effects.
 *
 * Composes `messages` from `prompt.systemPrompt` (as a `system` role
 * message when present) and `prompt.fullPrompt || prompt.userText` (as
 * a `user` role message). When `prompt.images` are supplied, the user
 * message uses the multi-modal content array form.
 *
 * For o-series reasoning models we omit `temperature` / `max_tokens`
 * (rejected by those endpoints) and use `max_completion_tokens` when
 * an output budget is requested.
 */
function buildRequestBody(
  modelId: string,
  prompt: PromptInput,
  opts: CallOpts,
  stream: boolean,
): Record<string, unknown> {
  const userText = prompt.fullPrompt || prompt.userText || '';

  // Compose the user content. For text-only requests we use the simple
  // string form (the most widely-supported shape); when images are
  // attached we switch to the array form using `image_url` data URIs
  // (the documented multi-modal input format for chat completions).
  let userContent: unknown = userText;
  if (prompt.images && prompt.images.length > 0) {
    const parts: Array<Record<string, unknown>> = [
      { type: 'text', text: userText },
    ];
    for (const img of prompt.images) {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
      });
    }
    userContent = parts;
  }

  const messages: Array<Record<string, unknown>> = [];
  if (prompt.systemPrompt) {
    messages.push({ role: 'system', content: prompt.systemPrompt });
  }
  messages.push({ role: 'user', content: userContent });

  const body: Record<string, unknown> = {
    model: modelId,
    messages,
    stream,
  };

  if (isOSeriesModel(modelId)) {
    // o-series reject `temperature` and `max_tokens`.
    if (opts.maxOutputTokens !== undefined) {
      body.max_completion_tokens = opts.maxOutputTokens;
    }
  } else {
    body.temperature = opts.temperature ?? 0.7;
    if (opts.maxOutputTokens !== undefined) {
      body.max_tokens = opts.maxOutputTokens;
    }
  }

  return body;
}

/**
 * Throws a `ProviderHttpError` carrying `status` and (when present)
 * `retryAfterMs`. The `status` field is what the default retry
 * classifier in `./http.ts` keys on (4.5: 429 / 5xx are retryable).
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
    `OpenAIAdapter: HTTP ${response.status} ${response.statusText}` +
    (bodyText ? ` — ${bodyText.slice(0, 200)}` : '');

  const err = new Error(message) as ProviderHttpError;
  err.providerId = PROVIDER_ID;
  err.status = response.status;
  const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
  if (retryAfter !== null) err.retryAfterMs = retryAfter;
  throw err;
}

/**
 * Reads `choices[0].message.content` from a non-streaming chat
 * completion response. Returns `''` when the response shape is
 * unexpected so the caller can still build a `ProviderResponse`.
 */
function extractMessageContent(json: unknown): string {
  if (!json || typeof json !== 'object') return '';
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const msg = (choices[0] as { message?: { content?: unknown } })?.message;
  const content = msg?.content;
  if (typeof content === 'string') return content;
  // Multi-modal responses use an array of parts. Concatenate every
  // textual part for robustness.
  if (Array.isArray(content)) {
    let text = '';
    for (const part of content) {
      if (
        part &&
        typeof part === 'object' &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        text += (part as { text: string }).text;
      }
    }
    return text;
  }
  return '';
}

/**
 * Reads `choices[0].delta.content` from a streaming chat completion
 * chunk. Returns `''` when the chunk has no textual delta (e.g., the
 * very first chunk, which may carry only a role marker).
 */
function extractDeltaContent(json: unknown): string {
  if (!json || typeof json !== 'object') return '';
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const delta = (choices[0] as { delta?: { content?: unknown } })?.delta;
  const content = delta?.content;
  if (typeof content === 'string') return content;
  return '';
}

/**
 * Resolves prompt/completion token counts. Prefers the
 * provider-reported `usage` block when available; otherwise falls
 * back to the adapter's local estimator so cost/budget reporting
 * always returns a number.
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
    typeof (json as { usage?: unknown }).usage === 'object'
      ? ((json as { usage?: { prompt_tokens?: number; completion_tokens?: number } })
          .usage ?? {})
      : {};

  const promptText = prompt.fullPrompt || prompt.userText || '';
  const promptTokens =
    typeof usage.prompt_tokens === 'number' && usage.prompt_tokens >= 0
      ? usage.prompt_tokens
      : adapter.countTokens(promptText);
  const completionTokens =
    typeof usage.completion_tokens === 'number' && usage.completion_tokens >= 0
      ? usage.completion_tokens
      : adapter.countTokens(responseText);

  return { promptTokens, completionTokens };
}
