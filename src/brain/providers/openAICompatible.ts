// ============================================
// Zule AI — OpenAICompatibleAdapter (provider-agnostic transport)
// ============================================
//
// Provider-agnostic `Provider_Adapter` for any endpoint that speaks the
// OpenAI Chat Completions wire format: `POST {baseUrl}/chat/completions`,
// `Authorization: Bearer …`, OpenAI-dialect SSE terminated by a literal
// `data: [DONE]` frame, and a `usage.{prompt_tokens, completion_tokens}`
// block.
//
// This is the extracted body of the former `OllamaCompatibleAdapter`
// (design.md §3. OpenAICompatibleAdapter). Identity, timeouts, default
// model, capabilities, and three injectable hooks are constructor options,
// so `ollama.ts` and `custom.ts` become thin subclasses that pin their own
// defaults instead of forking the transport.
//
// Design notes:
//   - The base URL is used **verbatim** after trailing-slash normalisation:
//     only `/chat/completions` is appended, never a synthesised `/v1`.
//     Gateways differ on whether their documented base already carries a
//     version segment (`https://openrouter.ai/api/v1`,
//     `https://api.groq.com/openai/v1`), so synthesising one is wrong in
//     the general case.
//   - The secret travels in a header, never in the URL.
//   - Per-request timeout, abort honouring, and retry-with-jitter are
//     delegated to the shared utilities in `./http.ts`.
//   - Streaming uses the chunk-boundary-safe SSE parser in `../sse.ts`.
//   - `preflight` runs before the request body is serialised and before any
//     `fetch`, so a throwing guard produces zero HTTP requests
//     (Requirement 2.10).
//   - `scrubError` is the last-chance transform applied to an HTTP error
//     message before it escapes the adapter, because a careless gateway can
//     echo the request's `Authorization` header back inside a 4xx body
//     (Requirement 3.7).
//
// Requirements: 2.10, 3.7

import { parseSseFrames } from '../sse';
import {
  DEFAULT_NON_STREAMING_TIMEOUT_MS,
  DEFAULT_STREAMING_TIMEOUT_MS,
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

/**
 * Default capability descriptor. Conservative on purpose — an arbitrary
 * OpenAI-compatible endpoint is not known to be multimodal or tool-capable,
 * and zero pricing means an un-priced endpoint never inflates Spend_Tracker.
 * Every subclass overrides what it can vouch for.
 */
const DEFAULT_CAPABILITIES: Capabilities = {
  streaming: true,
  imageInput: false,
  toolUse: false,
  maxInputTokens: 32_000,
  pricePerMTokens: { input: 0, output: 0 },
};

// --- Public options ------------------------------------------------------

/** Resolved usage handed to `onUsage` once per completed request. */
export interface OpenAICompatibleUsageEvent {
  modelId: string;
  promptTokens: number;
  completionTokens: number;
}

export interface OpenAICompatibleAdapterOptions {
  /** Stable adapter identity: `'ollama'`, `'custom'`, … */
  providerId: string;
  /**
   * Absolute http(s) prefix. Trailing slashes are normalised. The full
   * endpoint is `${baseUrl}/chat/completions` — no `/v1` is synthesised.
   */
  baseUrl: string;
  /** Model id used when `CallOpts.modelId` is absent. */
  defaultModelId: string;
  /**
   * `max_tokens` to send when the caller does not specify `maxOutputTokens`.
   *
   * Omitting `max_tokens` is not neutral on a metered gateway: the endpoint
   * reserves the model's entire output window and bills/authorises against
   * that, so a credit-limited key can be refused outright (OpenRouter answers
   * HTTP 402 "you requested up to 16384 tokens, but can only afford …") before
   * a single token is generated. Subclasses serving remote gateways should set
   * this; leaving it undefined preserves the "send no `max_tokens`" behaviour.
   */
  defaultMaxOutputTokens?: number;
  /**
   * Optional bearer token. Blank / whitespace-only is treated as
   * "no credential configured" and the `Authorization` header is omitted.
   * When set, the value travels only in `Authorization: Bearer …`.
   */
  apiKey?: string;
  /** Override the default capability descriptor. */
  capabilities?: Capabilities;
  /** Per-request timeout for `streamGenerate`. */
  streamingTimeoutMs?: number;
  /** Per-request timeout for `complete`. */
  nonStreamingTimeoutMs?: number;
  /** Injectable `fetch` for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Called once per completed request with the resolved usage. */
  onUsage?: (usage: OpenAICompatibleUsageEvent) => void;
  /** Last-chance transform applied to every HTTP error message before it escapes. */
  scrubError?: (message: string) => string;
  /** Pre-flight guard; throwing aborts the request before any `fetch`. */
  preflight?: (prompt: PromptInput) => void;
}

// --- Adapter -------------------------------------------------------------

/**
 * OpenAI-compatible implementation of `ProviderAdapter`. Exposes
 * `streamGenerate`, `complete`, and `countTokens`; router / failover
 * concerns live in `AI_Provider_Router`.
 */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly name: string;
  readonly capabilities: Capabilities;

  protected readonly providerId: string;
  protected readonly apiKey: string | undefined;
  protected readonly defaultModelId: string;
  protected readonly baseUrl: string;
  protected readonly fetchImpl?: typeof fetch;

  private readonly streamingTimeoutMs: number;
  private readonly nonStreamingTimeoutMs: number;
  private readonly defaultMaxOutputTokens?: number;
  private readonly onUsage?: (usage: OpenAICompatibleUsageEvent) => void;
  private readonly scrubError: (message: string) => string;
  private readonly preflightHook?: (prompt: PromptInput) => void;

  constructor(opts: OpenAICompatibleAdapterOptions) {
    this.providerId = opts.providerId;
    this.name = opts.providerId;
    // An empty / whitespace-only apiKey is treated as "no key configured"
    // so the Authorization header is omitted (vanilla Ollama happy path).
    const trimmedKey = opts.apiKey?.trim();
    this.apiKey = trimmedKey ? trimmedKey : undefined;
    this.defaultModelId = opts.defaultModelId;
    this.capabilities = opts.capabilities ?? DEFAULT_CAPABILITIES;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl;
    this.streamingTimeoutMs = opts.streamingTimeoutMs ?? DEFAULT_STREAMING_TIMEOUT_MS;
    this.nonStreamingTimeoutMs =
      opts.nonStreamingTimeoutMs ?? DEFAULT_NON_STREAMING_TIMEOUT_MS;
    this.defaultMaxOutputTokens = opts.defaultMaxOutputTokens;
    this.onUsage = opts.onUsage;
    this.scrubError = opts.scrubError ?? ((message: string) => message);
    this.preflightHook = opts.preflight;
  }

  /**
   * Apply `defaultMaxOutputTokens` when the caller left `maxOutputTokens`
   * unset, so a metered gateway is never asked to reserve the model's whole
   * output window. Returns `opts` untouched when there is nothing to default,
   * keeping the local-runtime path byte-identical.
   */
  private withDefaultMaxTokens(opts: CallOpts): CallOpts {
    if (opts.maxOutputTokens !== undefined) return opts;
    if (this.defaultMaxOutputTokens === undefined) return opts;
    return { ...opts, maxOutputTokens: this.defaultMaxOutputTokens };
  }

  /**
   * Rough character-based token estimator. OpenAI-compatible endpoints vary
   * widely in tokenizer (BPE, SentencePiece, tiktoken) and ship no remote
   * `countTokens` endpoint, so we approximate with ~4 characters per token.
   * The estimate is conservative: it slightly over-counts on dense text,
   * which is the right bias for prompt-budget enforcement.
   */
  countTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Non-streaming `/chat/completions` call. Returns the parsed assistant
   * message and the endpoint-reported token usage (falling back to the
   * local estimator when the response omits `usage`).
   */
  async complete(prompt: PromptInput, opts: CallOpts): Promise<ProviderResponse> {
    // Runs before the body is serialised and before any fetch, so a throw
    // here produces zero HTTP requests (Requirement 2.10).
    this.preflightHook?.(prompt);

    const modelId = opts.modelId ?? this.defaultModelId;
    const url = this.endpoint();
    const body = JSON.stringify(
      buildRequestBody(prompt, this.withDefaultMaxTokens(opts), modelId, false),
    );

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
            timeoutMs: opts.timeoutMs ?? this.nonStreamingTimeoutMs,
            signal: opts.signal,
            fetchImpl: this.fetchImpl,
          },
        ).then((res) => throwIfNotOk(res, this.providerId, this.scrubError)),
      { signal: opts.signal },
    );

    const json = (await response.json()) as unknown;
    const text = extractCompletionText(json);
    const usage = extractUsage(json, prompt, text, this);

    this.onUsage?.({
      modelId,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    });

    return {
      text,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      modelId,
      providerId: this.providerId,
      isSimulated: false,
      status: response.status,
    };
  }

  /**
   * Streaming `/chat/completions` call (`stream: true`). Parses SSE
   * frames with the chunk-boundary-safe parser, accumulates `delta.content`
   * tokens, and invokes the callbacks per Requirement 4.7:
   *
   *   - `cb.onToken` is called with the cumulative text on every frame
   *     that contributed new content.
   *   - `cb.onComplete` is invoked exactly once on a successful stream
   *     and never after the caller's abort signal fires.
   *   - `cb.onError` is invoked for mid-stream errors. Errors during the
   *     initial fetch (including non-2xx status after retries are
   *     exhausted) are thrown so the router can fail over.
   */
  async streamGenerate(
    prompt: PromptInput,
    cb: StreamCallbacks,
    opts: CallOpts,
  ): Promise<void> {
    // Pre-flight first: a throw must not be preceded by any fetch.
    this.preflightHook?.(prompt);

    const modelId = opts.modelId ?? this.defaultModelId;
    const url = this.endpoint();
    const body = JSON.stringify(
      buildRequestBody(prompt, this.withDefaultMaxTokens(opts), modelId, true),
    );

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
            timeoutMs: opts.timeoutMs ?? this.streamingTimeoutMs,
            signal: opts.signal,
            fetchImpl: this.fetchImpl,
          },
        ).then((res) => throwIfNotOk(res, this.providerId, this.scrubError)),
      { signal: opts.signal },
    );

    const reader = response.body?.getReader();
    if (!reader) {
      const err = new Error(
        `OpenAICompatibleAdapter[${this.providerId}]: response has no readable stream`,
      );
      cb.onError(err);
      return;
    }

    if (opts.signal?.aborted) {
      await reader.cancel().catch(() => {});
      return;
    }

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
    let lastUsage: unknown = null;

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
          // OpenAI dialect terminates with `data: [DONE]`. Ollama emits
          // it as well, LM Studio omits it on early termination — both
          // cases are handled.
          if (evt.data === '[DONE]') continue;

          let parsed: unknown;
          try {
            parsed = JSON.parse(evt.data);
          } catch {
            // Unrecognised frame — skip. The pure SSE parser already
            // guarantees frame-boundary correctness; a JSON parse failure
            // here means the endpoint sent something we don't recognise.
            continue;
          }

          const partText = extractDeltaContent(parsed);
          if (partText) {
            cumulativeText += partText;
            cb.onToken(cumulativeText);
          }
          // Ollama reports `usage` on the final frame; LM Studio sometimes
          // does, sometimes not. Keep the most-recent one for
          // `onComplete`'s payload.
          const maybeUsage = (parsed as { usage?: unknown })?.usage;
          if (maybeUsage && typeof maybeUsage === 'object') {
            lastUsage = parsed;
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

    // Honour late aborts: do not emit `onComplete` once the signal has fired.
    if (opts.signal?.aborted) return;

    const usage = extractUsage(lastUsage, prompt, cumulativeText, this);

    this.onUsage?.({
      modelId,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    });

    cb.onComplete({
      text: cumulativeText,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      modelId,
      providerId: this.providerId,
      isSimulated: false,
      status: response.status,
    });
  }

  // --- Internal --------------------------------------------------------

  protected endpoint(): string {
    // Static path — the model id travels in the JSON body, not the URL,
    // so there is nothing user-supplied to encode here. Only
    // `/chat/completions` is appended; `/v1` is never synthesised.
    return `${this.baseUrl}/chat/completions`;
  }

  protected buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }
}

// --- Helpers (module-private) -------------------------------------------

/**
 * Builds the OpenAI-compatible chat-completions JSON body. Pure, no
 * side-effects.
 */
function buildRequestBody(
  prompt: PromptInput,
  opts: CallOpts,
  modelId: string,
  stream: boolean,
): Record<string, unknown> {
  // Prefer the role-tagged messages for OpenAI-compatible servers. When
  // `Context_Builder` has assembled `fullPrompt`, we fold it into the user
  // message so retrieved context, citations, and language directives all
  // travel together — `systemPrompt` stays separate so the endpoint can
  // honour role-specific finetuning.
  const userContent = prompt.fullPrompt || prompt.userText || '';
  const messages: Array<{ role: string; content: unknown }> = [];
  if (prompt.systemPrompt) {
    messages.push({ role: 'system', content: prompt.systemPrompt });
  }

  // If images are provided, use the OpenAI-compatible multimodal content format.
  // Ollama supports this via the /v1/chat/completions endpoint for vision models
  // (llava, llama3.2-vision, bakllava, etc.). Non-vision models ignore the image parts.
  if (prompt.images && prompt.images.length > 0) {
    const contentParts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
      { type: 'text', text: userContent },
    ];
    for (const img of prompt.images) {
      contentParts.push({
        type: 'image_url',
        image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
      });
    }
    messages.push({ role: 'user', content: contentParts });
  } else {
    messages.push({ role: 'user', content: userContent });
  }

  const body: Record<string, unknown> = {
    model: modelId,
    messages,
    stream,
    temperature: opts.temperature ?? 0.7,
  };
  if (opts.maxOutputTokens !== undefined) {
    body.max_tokens = opts.maxOutputTokens;
  }

  return body;
}

/**
 * Throws a `ProviderHttpError` carrying `status` and (when present)
 * `retryAfterMs`. The default retry classifier in `./http.ts` keys on
 * `status` (4.5: 429 / 5xx are retryable).
 *
 * The assembled message — which embeds the first 200 characters of the
 * response body — passes through `scrubError` before the error is
 * constructed, so a gateway that echoes the `Authorization` header back
 * cannot leak the credential through the error surface (Requirement 3.7).
 */
async function throwIfNotOk(
  response: Response,
  providerId: string,
  scrubError: (message: string) => string,
): Promise<Response> {
  if (response.ok) return response;

  let bodyText = '';
  try {
    bodyText = await response.text();
  } catch {
    /* ignore */
  }

  const message =
    `OpenAICompatibleAdapter[${providerId}]: HTTP ${response.status} ${response.statusText}` +
    (bodyText ? ` — ${bodyText.slice(0, 200)}` : '');

  const err = new Error(scrubError(message)) as ProviderHttpError;
  err.providerId = providerId;
  err.status = response.status;
  const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
  if (retryAfter !== null) err.retryAfterMs = retryAfter;
  throw err;
}

/**
 * Reads `choices[0].message.content` from a non-streaming response.
 * Tolerates the structured-content array form (`content: [{type:'text',
 * text:'…'}]`) some compatibility shims emit.
 */
function extractCompletionText(json: unknown): string {
  if (!json || typeof json !== 'object') return '';
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const choice = choices[0] as { message?: { content?: unknown } };
  const content = choice?.message?.content;
  if (typeof content === 'string') return content;
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
 * Reads `choices[0].delta.content` from a streaming SSE frame. Returns
 * the empty string when the frame carries no new content (e.g., the
 * initial role-only delta or a pure finish-reason frame).
 */
function extractDeltaContent(json: unknown): string {
  if (!json || typeof json !== 'object') return '';
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const choice = choices[0] as { delta?: { content?: unknown } };
  const content = choice?.delta?.content;
  if (typeof content === 'string') return content;
  // Some compatibility shims emit content as an array of parts even in
  // streaming mode; concatenate text parts when present.
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
 * Resolves prompt/completion token counts. Prefers the endpoint-reported
 * `usage` field (`prompt_tokens` / `completion_tokens`) when available;
 * otherwise falls back to the adapter's local estimator so cost/budget
 * reporting always returns a number.
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
