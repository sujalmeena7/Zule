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
 * Host of the first-party API. Used only to decide whether this request is
 * going to Anthropic itself or to a gateway standing in front of it — see
 * `buildHeaders`.
 */
const OFFICIAL_API_HOST = 'api.anthropic.com';

/**
 * How much of an unrecognised response body to keep for the diagnostic.
 *
 * Only accumulated until the first frame this adapter understands, so a normal
 * stream copies a few hundred bytes and then stops. The cap bounds the
 * pathological case: an endpoint that answers 200 with a large body in a dialect
 * we cannot read at all.
 */
const RAW_BODY_SAMPLE_LIMIT = 64 * 1024;

/** Characters of that sample quoted in the diagnostic message. */
const RAW_BODY_EXCERPT_CHARS = 300;

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
  /**
   * Model id used when the caller sets `CallOpts.preferFastModel` — the screen
   * path, where the answer is worthless if it arrives late.
   *
   * Same key, same base URL, same dialect: only the `model` field of the body
   * changes, so this costs nothing to configure and nothing to fall back from.
   * Left undefined, `preferFastModel` is a no-op and the default model answers,
   * which is the behaviour before this field existed.
   */
  fastModelId?: string;
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
  private readonly fastModelId?: string;
  private readonly baseUrl: string;
  private readonly anthropicVersion: string;
  private readonly fetchImpl?: typeof fetch;
  /** Whether `baseUrl` points at Anthropic itself rather than at a gateway. */
  private readonly isOfficialHost: boolean;

  constructor(opts: AnthropicAdapterOptions) {
    if (!opts.apiKey || !opts.apiKey.trim()) {
      throw new Error('AnthropicAdapter requires a non-empty apiKey');
    }
    this.apiKey = opts.apiKey;
    this.defaultModelId = opts.defaultModelId ?? DEFAULT_MODEL_ID;
    // Blank is unset, so a field the User cleared in Settings does not become a
    // model id of `''` that the gateway would reject.
    const trimmedFastModel = opts.fastModelId?.trim();
    this.fastModelId = trimmedFastModel ? trimmedFastModel : undefined;
    this.capabilities = opts.capabilities ?? DEFAULT_CAPABILITIES;
    this.baseUrl = completeMessagesPath(
      (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    );
    this.anthropicVersion = opts.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION;
    this.fetchImpl = opts.fetchImpl;

    // Host comparison rather than a substring test, so a gateway whose path or
    // subdomain happens to contain the official host is still treated as a
    // gateway. An unparseable URL is treated as a gateway: that is the
    // permissive side for the auth header, and a malformed base URL fails at
    // `fetch` anyway.
    let host = '';
    try {
      host = new URL(this.baseUrl).host.toLowerCase();
    } catch {
      host = '';
    }
    this.isOfficialHost = host === OFFICIAL_API_HOST;
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
   * The model id to send.
   *
   * Precedence is explicit > fast > default, matching the OpenAI-compatible
   * adapter. An explicit `opts.modelId` wins outright because a caller naming
   * one model is a stronger statement than a caller expressing a preference for
   * speed; `preferFastModel` falls through to the default whenever no fast model
   * is configured, so the screen path can set the flag unconditionally.
   */
  private resolveModelId(opts: CallOpts): string {
    if (opts.modelId) return opts.modelId;
    if (opts.preferFastModel && this.fastModelId) return this.fastModelId;
    return this.defaultModelId;
  }

  /**
   * Non-streaming Messages call. Returns the parsed text and the
   * provider-reported usage (falling back to the local estimator when
   * the response omits `usage`).
   */
  async complete(prompt: PromptInput, opts: CallOpts): Promise<ProviderResponse> {
    const modelId = this.resolveModelId(opts);
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
    const modelId = this.resolveModelId(opts);
    const body = JSON.stringify(buildRequestBody(prompt, opts, modelId, true));

    // Wall clock for the metrics frame. Started before the fetch so it covers
    // connection and any transient retry, which is the latency the User feels
    // rather than the latency the model spent generating.
    const startedAt = performance.now();
    let ttftMs = -1;
    let attempts = 0;

    // Initial connection (with retries on transient HTTP failures). If we
    // exhaust retries the error escapes — the router treats that as a
    // failover trigger.
    const response = await retryWithJitter(
      () => {
        attempts += 1;
        return fetchWithTimeout(
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
        ).then(throwIfNotOk);
      },
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
    let cumulativeReasoning = '';
    // Anthropic reports input tokens on `message_start` and output tokens
    // on `message_delta`; both are cumulative-by-event so we keep the
    // most recent value seen.
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    /**
     * Copy of the response body kept only until a frame is understood, so a
     * stream that produced nothing can say what it actually contained instead of
     * resolving with an empty string.
     */
    let rawSample = '';
    let recognisedAnyFrame = false;
    /** An error the endpoint reported inside a 200 response. */
    let gatewayError: string | null = null;

    try {
      while (true) {
        if (opts.signal?.aborted) return;
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;
          if (!recognisedAnyFrame && rawSample.length < RAW_BODY_SAMPLE_LIMIT) {
            rawSample += chunk;
          }
        }

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
            const delta = (parsed as { delta?: { type?: unknown; text?: unknown; thinking?: unknown } })
              ?.delta;
            if (
              delta &&
              typeof delta === 'object' &&
              delta.type === 'text_delta' &&
              typeof delta.text === 'string'
            ) {
              recognisedAnyFrame = true;
              cumulativeText += delta.text;
              if (ttftMs < 0) ttftMs = performance.now() - startedAt;
              cb.onToken(cumulativeText);
            } else if (
              // Extended thinking. Kept out of `cumulativeText` — it is not part
              // of the answer — but surfaced so a long think is visibly
              // progressing instead of looking like a stall.
              delta &&
              typeof delta === 'object' &&
              delta.type === 'thinking_delta' &&
              typeof delta.thinking === 'string'
            ) {
              recognisedAnyFrame = true;
              cumulativeReasoning += delta.thinking;
              cb.onReasoning?.(cumulativeReasoning);
            }
          } else if (eventType === 'message_start') {
            recognisedAnyFrame = true;
            const usage = (parsed as { message?: { usage?: unknown } })?.message
              ?.usage;
            if (usage && typeof usage === 'object') {
              const inp = (usage as { input_tokens?: unknown }).input_tokens;
              const outp = (usage as { output_tokens?: unknown }).output_tokens;
              if (typeof inp === 'number' && inp >= 0) inputTokens = inp;
              if (typeof outp === 'number' && outp >= 0) outputTokens = outp;
            }
          } else if (eventType === 'message_delta') {
            recognisedAnyFrame = true;
            const usage = (parsed as { usage?: unknown })?.usage;
            if (usage && typeof usage === 'object') {
              const outp = (usage as { output_tokens?: unknown }).output_tokens;
              if (typeof outp === 'number' && outp >= 0) outputTokens = outp;
            }
          } else if (eventType === 'error') {
            // Anthropic's own mid-stream failure frame. Previously ignored,
            // which turned a reported overload into a silent empty answer.
            gatewayError = extractErrorMessage(parsed) ?? 'the endpoint sent an error frame';
          } else {
            // Not an event name this adapter knows. A gateway reselling Claude
            // frequently answers in the OpenAI dialect regardless of the path it
            // was asked on — the request is translated, the response is not — so
            // an unlabelled `data:` frame carrying `choices[].delta.content` is
            // the common case here, not an exotic one. Reading it costs one
            // property lookup and is the difference between an answer and a
            // spinner.
            const openAi = extractOpenAiDelta(parsed);
            if (openAi.text) {
              recognisedAnyFrame = true;
              cumulativeText += openAi.text;
              if (ttftMs < 0) ttftMs = performance.now() - startedAt;
              cb.onToken(cumulativeText);
            }
            if (openAi.reasoning) {
              recognisedAnyFrame = true;
              cumulativeReasoning += openAi.reasoning;
              cb.onReasoning?.(cumulativeReasoning);
            }
            if (openAi.promptTokens !== null) inputTokens = openAi.promptTokens;
            if (openAi.completionTokens !== null) outputTokens = openAi.completionTokens;
            if (!gatewayError) gatewayError = extractErrorMessage(parsed);
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

    // Last resort before giving up: some gateways ignore `stream: true` and
    // answer with a single non-streamed JSON body. That body arrives with no
    // `data:` framing, so the SSE parser correctly yields no events and the
    // answer would be thrown away — even though it is sitting in the sample
    // buffer, in a shape `extractText` already understands.
    if (cumulativeText.length === 0) {
      let salvaged = '';
      try {
        const body: unknown = JSON.parse(rawSample.trim());
        salvaged = extractText(body);
        // Same body, other outcome: a whole-body error envelope. Reading it here
        // is what turns "could not read the response" into the gateway's own
        // words about why it refused.
        if (!salvaged && !gatewayError) gatewayError = extractErrorMessage(body);
      } catch {
        salvaged = '';
      }
      if (salvaged) {
        cumulativeText = salvaged;
        cb.onToken(cumulativeText);
      }
    }

    // Still nothing. Resolving here would hand the router an empty answer, which
    // is what left the overlay spinning on "Thinking…" with no text and no error
    // to explain it. Report instead: the router withholds this while it fails
    // over, and surfaces it if every provider comes back the same way.
    if (cumulativeText.length === 0) {
      cb.onError(new Error(this.describeEmptyStream(rawSample, gatewayError)));
      return;
    }

    const promptTokens =
      inputTokens ?? this.countTokens(prompt.fullPrompt || prompt.userText || '');
    const completionTokens =
      outputTokens ?? this.countTokens(cumulativeText);

    // Emitted before `onComplete` so a consumer logging both sees the model id
    // alongside the timings. Without this frame the overlay's `[perf] answered
    // by …` line never printed for Anthropic, which made its latency
    // unattributable: you could see the total but not which model spent it, nor
    // how much of it was time-to-first-token versus generation.
    cb.onMetrics?.({
      ttftMs: Math.round(ttftMs >= 0 ? ttftMs : performance.now() - startedAt),
      totalMs: Math.round(performance.now() - startedAt),
      retries: Math.max(0, attempts - 1),
      modelId,
    });

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
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      [API_KEY_HEADER]: this.apiKey,
      'anthropic-version': this.anthropicVersion,
    };

    // Gateways that resell Claude are overwhelmingly written against the OpenAI
    // convention and authenticate on `Authorization: Bearer`; several ignore
    // `x-api-key` entirely, and an unauthenticated request to one of those comes
    // back as a 200 carrying an error envelope rather than a 401. So send both
    // when the target is not Anthropic itself.
    //
    // Withheld for the first-party host on purpose: there, `Authorization` is
    // the OAuth channel, and presenting an API key through it alongside a valid
    // `x-api-key` invites a 401 on a request that works today.
    if (!this.isOfficialHost) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    return headers;
  }

  /**
   * Human-readable account of a 200 response that produced no answer, for the
   * `onError` the router carries into its failover log. This is the line that
   * tells the User whether their gateway is speaking an unknown dialect, or
   * refusing the request inside a success status.
   */
  private describeEmptyStream(rawSample: string, gatewayError: string | null): string {
    const where = this.isOfficialHost ? this.baseUrl : `gateway ${this.baseUrl}`;
    if (gatewayError) {
      return maskSecret(
        `AnthropicAdapter: ${where} answered HTTP 200 but reported an error instead of an answer — ${gatewayError}`,
        this.apiKey,
      );
    }
    const excerpt = rawSample.trim().slice(0, RAW_BODY_EXCERPT_CHARS);
    return maskSecret(
      `AnthropicAdapter: ${where} answered HTTP 200 with a body this adapter could not read as either ` +
        `the Anthropic Messages stream or the OpenAI chat-completions stream. ` +
        (excerpt
          ? `First ${excerpt.length} characters: ${excerpt}`
          : 'The body was empty. Check that the Base URL points at the Messages endpoint (…/v1/messages) and that the model id exists on this gateway.'),
      this.apiKey,
    );
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
 * Completes a Base URL that names only a host into a Messages endpoint.
 *
 * Unlike the OpenAI-compatible adapter — where `baseUrl` is an API root and a
 * path is appended to it — this adapter POSTs `baseUrl` verbatim, so the value
 * is expected to be a full endpoint (the default is
 * `https://api.anthropic.com/v1/messages`). A host on its own is therefore an
 * incomplete entry rather than a different convention, and posting it hits the
 * gateway's website: the observed failure was `https://tokenbom.com` answering
 * with its HTML homepage under HTTP 200.
 *
 * Only a URL with no path at all is completed. Anything carrying a path is left
 * exactly as given, so no configuration that works today can be changed by this.
 */
function completeMessagesPath(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return baseUrl; // Not a URL — let `fetch` be the one to complain.
  }
  if (parsed.pathname && parsed.pathname !== '/') return baseUrl;
  return `${parsed.origin}/v1/messages`;
}

/**
 * Concatenates every `text` block from `content` in a non-streaming
 * Messages response. Anthropic returns:
 *   { content: [{ type: 'text', text: '…' }, …], usage: { … } }
 *
 * Falls through to the OpenAI chat-completions shape
 * (`choices[0].message.content`) when no Anthropic content block is present,
 * because a gateway asked for Claude on an Anthropic path will often still
 * answer in the dialect it was written for. Trying the second shape costs a
 * property lookup; not trying it costs the whole answer.
 */
function extractText(json: unknown): string {
  if (!json || typeof json !== 'object') return '';
  const content = (json as { content?: unknown }).content;
  if (Array.isArray(content)) {
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
    if (text) return text;
  }

  // `content` as a plain string — some gateways flatten it.
  if (typeof content === 'string') return content;

  const choices = (json as { choices?: unknown }).choices;
  if (Array.isArray(choices)) {
    let text = '';
    for (const choice of choices) {
      const message = (choice as { message?: { content?: unknown } })?.message;
      if (typeof message?.content === 'string') text += message.content;
    }
    if (text) return text;
  }

  return '';
}

/**
 * Reads one OpenAI-dialect streaming frame: `choices[].delta.content`, the
 * `reasoning` / `reasoning_content` field thinking models put their
 * chain-of-thought in, and the usage block.
 *
 * Returns empty strings and `null` counts for anything that is not such a
 * frame, so the caller can treat "not this dialect" and "nothing in it" alike.
 */
function extractOpenAiDelta(parsed: unknown): {
  text: string;
  reasoning: string;
  promptTokens: number | null;
  completionTokens: number | null;
} {
  const result = { text: '', reasoning: '', promptTokens: null as number | null, completionTokens: null as number | null };
  if (!parsed || typeof parsed !== 'object') return result;

  const choices = (parsed as { choices?: unknown }).choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      const delta = (choice as { delta?: Record<string, unknown> })?.delta;
      if (delta && typeof delta === 'object') {
        if (typeof delta.content === 'string') result.text += delta.content;
        const reasoning =
          typeof delta.reasoning === 'string'
            ? delta.reasoning
            : typeof delta.reasoning_content === 'string'
              ? delta.reasoning_content
              : '';
        result.reasoning += reasoning;
      }
      // A gateway that ignored `stream: true` but still framed its answer as
      // one SSE event puts the whole reply under `message` instead of `delta`.
      const message = (choice as { message?: { content?: unknown } })?.message;
      if (typeof message?.content === 'string') result.text += message.content;
    }
  }

  const usage = (parsed as { usage?: unknown }).usage;
  if (usage && typeof usage === 'object') {
    const inp = (usage as { prompt_tokens?: unknown }).prompt_tokens;
    const outp = (usage as { completion_tokens?: unknown }).completion_tokens;
    if (typeof inp === 'number' && inp >= 0) result.promptTokens = inp;
    if (typeof outp === 'number' && outp >= 0) result.completionTokens = outp;
  }

  return result;
}

/**
 * Pulls a human-readable message out of an error envelope, covering the shapes
 * the gateways in use put one in: `{ error: { message } }`, `{ error: '…' }`,
 * and a bare `{ message }`.
 *
 * Needed because an error delivered inside HTTP 200 never reaches
 * `throwIfNotOk`. Gateways do this routinely — quota exhausted, unknown model,
 * upstream refusal — and without this the whole event is indistinguishable from
 * a model that had nothing to say.
 */
function extractErrorMessage(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;

  const error = (parsed as { error?: unknown }).error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
    const type = (error as { type?: unknown }).type;
    if (typeof type === 'string' && type.trim()) return type.trim();
  }

  const message = (parsed as { message?: unknown }).message;
  if (typeof message === 'string' && message.trim()) return message.trim();

  return null;
}

/**
 * Literal (regex-free) masking of the credential before it can reach a log line.
 * Mirrors `scrubSecret` in `./custom.ts`; kept local so this adapter does not
 * pull the custom-provider module into its chunk for six lines of string work.
 */
function maskSecret(text: string, secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length < 8) return text;
  return text.split(`Bearer ${trimmed}`).join('[REDACTED:APIKEY]').split(trimmed).join('[REDACTED:APIKEY]');
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
