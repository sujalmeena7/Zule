// ============================================
// Zule AI — AnthropicAdapter
// ============================================
//
// Pluggable `Provider_Adapter` for Anthropic's Claude Messages API.
// This adapter is a thin data-plane shim that mirrors the design of
// `GeminiAdapter`:
//
//   - Authentication is header-based via `x-api-key` (Requirement 4.6).
//     The API key is NEVER appended to the URL as a query parameter so
//     it stays out of browser history, server access logs, and Telemetry
//     breadcrumbs (Property 11).
//   - Per-request timeouts and retry-with-jitter are delegated to the
//     shared HTTP utilities in `./http.ts` (Requirements 4.4, 4.5).
//   - SSE streaming uses the chunk-boundary-safe parser in `../sse.ts`
//     (Requirement 4.8). Anthropic's stream emits typed events
//     (`content_block_delta`, `message_delta`, `message_stop`, …); the
//     adapter listens for `content_block_delta` frames whose
//     `delta.type === 'text_delta'` and accumulates their `delta.text`.
//   - Caller `AbortSignal` propagates to the underlying fetch and to the
//     reader so the stream is cancelled within 200 ms of abort and
//     `onComplete` is never invoked after abort (Requirement 4.7).
//
// Router/failover concerns are intentionally out of scope here; they
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
const PROVIDER_ID = 'anthropic' as const;

/** Default model when the router (or caller) does not supply `opts.modelId`. */
const DEFAULT_MODEL_ID = 'claude-3-5-sonnet-20241022';

/** Anthropic Messages endpoint. The model id is in the JSON body, not the URL. */
const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1/messages';

/** API-key header name (per the Anthropic Messages API docs). */
const API_KEY_HEADER = 'x-api-key';

/** Pinned API version. Anthropic requires this header on every request. */
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

/**
 * Anthropic requires `max_tokens` on every Messages request. We pick a
 * generous default that fits comfortably inside Claude 3.5 Sonnet's
 * output budget without truncating typical Copilot answers.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/**
 * Default capability descriptor. Tuned for Claude 3.5 Sonnet (the default
 * model). Callers that prefer a different default tier should override
 * `capabilities.maxInputTokens` and `pricePerMTokens` via constructor
 * options. The router's `selectModel` resolves per-tier capability shape
 * (task 2.15).
 */
const DEFAULT_CAPABILITIES: Capabilities = {
  streaming: true,
  imageInput: true,
  toolUse: true,
  // Claude 3.5 Sonnet advertises a 200 000-token context window.
  maxInputTokens: 200_000,
  // Public list price for claude-3-5-sonnet-20241022 as of the design freeze.
  pricePerMTokens: { input: 3.0, output: 15.0 },
};

// --- Public options ------------------------------------------------------

export interface AnthropicAdapterOptions {
  /** API key. Stored in memory; passed only via the `x-api-key` header. */
  apiKey: string;
  /** Override the default model id (`claude-3-5-sonnet-20241022`). */
  defaultModelId?: string;
  /** Override the default capability descriptor. */
  capabilities?: Capabilities;
  /** Override the base URL (test harnesses, regional endpoints, gateways). */
  baseUrl?: string;
  /** Override the pinned `anthropic-version` header. */
  anthropicVersion?: string;
  /** Injectable `fetch` for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

// --- Adapter -------------------------------------------------------------

/**
 * Anthropic implementation of the `ProviderAdapter` contract. Exposes
 * `streamGenerate`, `complete`, and `countTokens`.
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly name = PROVIDER_ID;
  readonly capabilities: Capabilities;

  private readonly apiKey: string;
  private readonly defaultModelId: string;
  private readonly baseUrl: string;
  private readonly anthropicVersion: string;
  private readonly fetchImpl?: typeof fetch;

  constructor(opts: AnthropicAdapterOptions) {
    if (!opts.apiKey || !opts.apiKey.trim()) {
      throw new Error('AnthropicAdapter requires a non-empty apiKey');
    }
    this.apiKey = opts.apiKey;
    this.defaultModelId = opts.defaultModelId ?? DEFAULT_MODEL_ID;
    this.capabilities = opts.capabilities ?? DEFAULT_CAPABILITIES;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.anthropicVersion = opts.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION;
    this.fetchImpl = opts.fetchImpl;
  }

  /**
   * Rough character-based token estimator. Anthropic exposes a remote
   * `count_tokens` endpoint, but a network round-trip is far too
   * expensive for the prompt-budget loop in `Context_Builder`. Estimates
   * here are conservative for budget enforcement: they slightly
   * over-count on dense text, which is exactly what we want when
   * choosing whether to drop a section.
   */
  countTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Non-streaming Messages call. Returns the parsed text and the
   * provider-reported usage (falling back to the local estimator when
   * the response omits `usage`).
   */
  async complete(prompt: PromptInput, opts: CallOpts): Promise<ProviderResponse> {
    const modelId = opts.modelId ?? this.defaultModelId;
    const body = JSON.stringify(buildRequestBody(prompt, opts, modelId, false));

    const response = await retryWithJitter(
      () =>
        fetchWithTimeout(
          this.baseUrl,
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
   * Streaming Messages call (`stream: true`). Parses SSE frames with the
   * chunk-boundary-safe parser, accumulates text from
   * `content_block_delta` events whose `delta.type === 'text_delta'`,
   * and finalises on `message_stop`. Per Requirement 4.7:
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
    const body = JSON.stringify(buildRequestBody(prompt, opts, modelId, true));

    // Initial connection (with retries on transient HTTP failures). If we
    // exhaust retries the error escapes — the router treats that as a
    // failover trigger.
    const response = await retryWithJitter(
      () =>
        fetchWithTimeout(
          this.baseUrl,
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
      const err = new Error('AnthropicAdapter: response has no readable stream');
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
    // event-loop tick. Remove the listener in `finally` to avoid dangling
    // references after a normal completion.
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
    // Anthropic reports input tokens on `message_start` and output tokens
    // on `message_delta`; both are cumulative-by-event so we keep the
    // most recent value seen.
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;

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
          // Some providers terminate with a literal `[DONE]` frame;
          // Anthropic uses typed events and `message_stop` instead, but
          // tolerate `[DONE]` for robustness against gateway proxies.
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

          // Use the SSE event name when present; otherwise fall back to
          // the JSON `type` discriminator (Anthropic supplies both).
          const eventType =
            evt.event ||
            (typeof (parsed as { type?: unknown })?.type === 'string'
              ? ((parsed as { type: string }).type)
              : '');

          if (eventType === 'content_block_delta') {
            const delta = (parsed as { delta?: { type?: unknown; text?: unknown } })
              ?.delta;
            if (
              delta &&
              typeof delta === 'object' &&
              delta.type === 'text_delta' &&
              typeof delta.text === 'string'
            ) {
              cumulativeText += delta.text;
              cb.onToken(cumulativeText);
            }
          } else if (eventType === 'message_start') {
            const usage = (parsed as { message?: { usage?: unknown } })?.message
              ?.usage;
            if (usage && typeof usage === 'object') {
              const inp = (usage as { input_tokens?: unknown }).input_tokens;
              const outp = (usage as { output_tokens?: unknown }).output_tokens;
              if (typeof inp === 'number' && inp >= 0) inputTokens = inp;
              if (typeof outp === 'number' && outp >= 0) outputTokens = outp;
            }
          } else if (eventType === 'message_delta') {
            const usage = (parsed as { usage?: unknown })?.usage;
            if (usage && typeof usage === 'object') {
              const outp = (usage as { output_tokens?: unknown }).output_tokens;
              if (typeof outp === 'number' && outp >= 0) outputTokens = outp;
            }
          }
          // `message_stop` is informational; we finalise after the reader
          // drains so any trailing usage frame is honoured.
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

    const promptTokens =
      inputTokens ?? this.countTokens(prompt.fullPrompt || prompt.userText || '');
    const completionTokens =
      outputTokens ?? this.countTokens(cumulativeText);

    cb.onComplete({
      text: cumulativeText,
      promptTokens,
      completionTokens,
      modelId,
      providerId: PROVIDER_ID,
      isSimulated: false,
      status: response.status,
    });
  }

  // --- Internal --------------------------------------------------------

  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      [API_KEY_HEADER]: this.apiKey,
      'anthropic-version': this.anthropicVersion,
    };
  }
}

// --- Helpers (module-private) -------------------------------------------

/** Builds the Messages JSON body. Pure, no side-effects. */
function buildRequestBody(
  prompt: PromptInput,
  opts: CallOpts,
  modelId: string,
  stream: boolean,
): Record<string, unknown> {
  // Prefer the fully-assembled prompt produced by `Context_Builder`. Fall
  // back to `userText` for callers (e.g., tests) that do not assemble a
  // structured prompt.
  const userText = prompt.fullPrompt || prompt.userText || '';

  // Anthropic's Messages API accepts string content for simple prompts
  // and a content-block array when images are attached. Use the array
  // form whenever images are present so we can preserve order.
  let userContent: unknown;
  if (prompt.images && prompt.images.length > 0) {
    const blocks: Array<Record<string, unknown>> = [];
    for (const img of prompt.images) {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mimeType,
          data: img.base64,
        },
      });
    }
    blocks.push({ type: 'text', text: userText });
    userContent = blocks;
  } else {
    userContent = userText;
  }

  const body: Record<string, unknown> = {
    model: modelId,
    messages: [{ role: 'user', content: userContent }],
    max_tokens: opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    temperature: opts.temperature ?? 0.7,
    stream,
  };

  // Anthropic takes the system prompt as a top-level `system` field
  // rather than a system-role message in `messages`.
  if (prompt.systemPrompt) {
    body.system = prompt.systemPrompt;
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
    `AnthropicAdapter: HTTP ${response.status} ${response.statusText}` +
    (bodyText ? ` — ${bodyText.slice(0, 200)}` : '');

  const err = new Error(message) as ProviderHttpError;
  err.providerId = PROVIDER_ID;
  err.status = response.status;
  const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
  if (retryAfter !== null) err.retryAfterMs = retryAfter;
  throw err;
}

/**
 * Concatenates every `text` block from `content` in a non-streaming
 * Messages response. Anthropic returns:
 *   { content: [{ type: 'text', text: '…' }, …], usage: { … } }
 */
function extractText(json: unknown): string {
  if (!json || typeof json !== 'object') return '';
  const content = (json as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      text += (block as { text: string }).text;
    }
  }
  return text;
}

/**
 * Resolves prompt/completion token counts. Prefers the provider-reported
 * `usage.input_tokens` / `usage.output_tokens` when available; otherwise
 * falls back to the adapter's local estimator so cost/budget reporting
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
      ? ((json as { usage?: { input_tokens?: number; output_tokens?: number } })
          .usage ?? {})
      : {};

  const promptText = prompt.fullPrompt || prompt.userText || '';
  const promptTokens =
    typeof usage.input_tokens === 'number' && usage.input_tokens >= 0
      ? usage.input_tokens
      : adapter.countTokens(promptText);
  const completionTokens =
    typeof usage.output_tokens === 'number' && usage.output_tokens >= 0
      ? usage.output_tokens
      : adapter.countTokens(responseText);

  return { promptTokens, completionTokens };
}
