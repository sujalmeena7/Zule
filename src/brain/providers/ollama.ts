// ============================================
// Zule AI — OllamaCompatibleAdapter
// ============================================
//
// Pluggable `Provider_Adapter` for OpenAI-compatible local runtimes such
// as Ollama (`http://localhost:11434/v1`) and LM Studio
// (`http://localhost:1234/v1`). Both expose the OpenAI Chat Completions
// wire format, so a single adapter targeting that contract serves both.
//
// Design notes:
//   - No API key is required for vanilla Ollama. LM Studio (and some
//     reverse-proxied deployments) optionally accept a bearer token; we
//     send `Authorization: Bearer ${apiKey}` only when the caller has
//     configured one. Either way the secret travels in a header, never
//     in the URL — Requirement 4.6 / Property 11 (design.md §Property 11).
//   - Per-request timeout, abort honouring, and retry-with-jitter are
//     delegated to the shared utilities in `./http.ts`
//     (Requirements 4.4, 4.5).
//   - Streaming uses the chunk-boundary-safe SSE parser in `../sse.ts`
//     (Requirement 4.8). The OpenAI dialect terminates with a literal
//     `data: [DONE]` frame, which we respect.
//   - Capabilities advertise `imageInput: true` — the OpenAI-compatible
//     `/v1/chat/completions` endpoint supports multimodal content_parts
//     for vision models (llava, llama3.2-vision, bakllava). Non-vision
//     models gracefully ignore image parts. Zero pricing — local inference
//     is free at the wire level.
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
const PROVIDER_ID = 'ollama' as const;

/** Default model tag. Most Ollama installs ship `llama3.1` as a sane default. */
const DEFAULT_MODEL_ID = 'llama3.1';

/**
 * Default base URL points at vanilla Ollama. LM Studio users override to
 * `http://localhost:1234/v1`; reverse-proxied deployments override to
 * whatever HTTPS endpoint they expose.
 */
const DEFAULT_BASE_URL = 'http://localhost:11434/v1';

/**
 * Local-runtime timeouts are much longer than cloud timeouts because:
 *   - Ollama may need to load the model into VRAM on first request (~15-60s)
 *   - Consumer GPUs (e.g. RTX 4050 6GB) take longer than datacenter hardware
 *   - There's no network latency concern — only compute time
 */
const LOCAL_STREAMING_TIMEOUT_MS = 120_000; // 2 minutes
const LOCAL_NON_STREAMING_TIMEOUT_MS = 120_000; // 2 minutes

/**
 * Default capability descriptor for a local-runtime adapter:
 *   - `streaming: true` — `/v1/chat/completions` supports SSE.
 *   - `imageInput: true` — multimodal content parts are supported via
 *     the OpenAI-compatible API for vision models (llava, llama3.2-vision,
 *     bakllava). Non-vision models gracefully ignore image parts.
 *   - `toolUse: true` — modern Ollama models (llama3.1, qwen2.5) support
 *     OpenAI-style `tools` field; LM Studio surfaces this when the
 *     loaded model declares it.
 *   - `maxInputTokens: 32_000` — keeps payloads bounded; the
 *     `Context_Builder` budget honours this regardless of the model's
 *     advertised window.
 *   - `pricePerMTokens: { input: 0, output: 0 }` — local inference is
 *     free at the wire level.
 */
const DEFAULT_CAPABILITIES: Capabilities = {
  streaming: true,
  imageInput: true,
  toolUse: true,
  maxInputTokens: 32_000,
  pricePerMTokens: { input: 0, output: 0 },
};

// --- Public options ------------------------------------------------------

export interface OllamaCompatibleAdapterOptions {
  /**
   * Optional API key. Vanilla Ollama ignores authentication; LM Studio
   * and reverse-proxied deployments may require a bearer token. When set,
   * the value travels only in `Authorization: Bearer …` — never in the URL.
   */
  apiKey?: string;
  /** Override the default model id (`llama3.1`). */
  defaultModelId?: string;
  /** Override the default capability descriptor. */
  capabilities?: Capabilities;
  /**
   * Override the base URL. Trailing slashes are normalised. The full
   * endpoint is `${baseUrl}/chat/completions`.
   */
  baseUrl?: string;
  /** Injectable `fetch` for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

// --- Adapter -------------------------------------------------------------

/**
 * OpenAI-compatible local-runtime implementation of `ProviderAdapter`.
 * Targets Ollama (`/v1/chat/completions`) and LM Studio (which mirrors
 * the same surface). Exposes `streamGenerate`, `complete`, and
 * `countTokens`.
 */
export class OllamaCompatibleAdapter implements ProviderAdapter {
  readonly name = PROVIDER_ID;
  readonly capabilities: Capabilities;

  private readonly apiKey: string | undefined;
  private readonly defaultModelId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof fetch;

  constructor(opts: OllamaCompatibleAdapterOptions = {}) {
    // An empty / whitespace-only apiKey is treated as "no key configured"
    // so the Authorization header is omitted (vanilla Ollama happy path).
    const trimmedKey = opts.apiKey?.trim();
    this.apiKey = trimmedKey ? trimmedKey : undefined;
    this.defaultModelId = opts.defaultModelId ?? DEFAULT_MODEL_ID;
    this.capabilities = opts.capabilities ?? DEFAULT_CAPABILITIES;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl;
  }

  /**
   * Rough character-based token estimator. Local runtimes vary widely in
   * tokenizer (BPE, SentencePiece, tiktoken) and ship no remote
   * `countTokens` endpoint, so we approximate with ~4 characters per
   * token. The estimate is conservative: it slightly over-counts on
   * dense text, which is the right bias for prompt-budget enforcement.
   */
  countTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Non-streaming `/chat/completions` call. Returns the parsed assistant
   * message and the runtime-reported token usage (falling back to the
   * local estimator when the response omits `usage`).
   */
  async complete(prompt: PromptInput, opts: CallOpts): Promise<ProviderResponse> {
    const modelId = opts.modelId ?? this.defaultModelId;
    const url = this.endpoint();
    const body = JSON.stringify(buildRequestBody(prompt, opts, modelId, false));

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
            timeoutMs: opts.timeoutMs ?? LOCAL_NON_STREAMING_TIMEOUT_MS,
            signal: opts.signal,
            fetchImpl: this.fetchImpl,
          },
        ).then(throwIfNotOk),
      { signal: opts.signal },
    );

    const json = (await response.json()) as unknown;
    const text = extractCompletionText(json);
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
    const modelId = opts.modelId ?? this.defaultModelId;
    const url = this.endpoint();
    const body = JSON.stringify(buildRequestBody(prompt, opts, modelId, true));

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
            timeoutMs: opts.timeoutMs ?? LOCAL_STREAMING_TIMEOUT_MS,
            signal: opts.signal,
            fetchImpl: this.fetchImpl,
          },
        ).then(throwIfNotOk),
      { signal: opts.signal },
    );

    const reader = response.body?.getReader();
    if (!reader) {
      const err = new Error('OllamaCompatibleAdapter: response has no readable stream');
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
            // here means the runtime sent something we don't recognise.
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

  private endpoint(): string {
    // Static path — the model id travels in the JSON body, not the URL,
    // so there is nothing user-supplied to encode here.
    return `${this.baseUrl}/chat/completions`;
  }

  private buildHeaders(): Record<string, string> {
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
  // travel together — `systemPrompt` stays separate so the runtime can
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
    `OllamaCompatibleAdapter: HTTP ${response.status} ${response.statusText}` +
    (bodyText ? ` — ${bodyText.slice(0, 200)}` : '');

  const err = new Error(message) as ProviderHttpError;
  err.providerId = PROVIDER_ID;
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
 * Resolves prompt/completion token counts. Prefers the runtime-reported
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
