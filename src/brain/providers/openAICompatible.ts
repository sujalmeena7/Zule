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
  ReasoningEffort,
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
   * Model id used when the caller sets `CallOpts.preferFastModel` — the
   * latency-critical slot, served by the same endpoint and credential.
   *
   * Exists because "make the answer arrive sooner" is, past a point, a model
   * choice rather than a tuning knob: a thinking-tuned variant deliberates for
   * tens of seconds whether or not it is asked to, so the only way to be quick
   * is to ask a model that does not deliberate. Since one gateway usually fronts
   * both variants, this is a second `model` string rather than a second adapter.
   *
   * Left undefined, `preferFastModel` is a no-op and the request is
   * byte-identical to what it was before this option existed.
   */
  fastModelId?: string;
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
   * Deliberation budget sent for a thinking model when the caller specifies
   * none. Left undefined the `reasoning` field is omitted entirely, so an
   * endpoint applies whatever it does by default.
   *
   * Worth setting for a gateway: the reasoning phase dominates wall-clock
   * latency and its default is "as long as the model likes". Unknown to a
   * plain OpenAI-compatible server, which is handled — see
   * `reasoningRejected`.
   */
  defaultReasoningEffort?: ReasoningEffort;
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
  protected readonly fastModelId?: string;
  protected readonly baseUrl: string;
  protected readonly fetchImpl?: typeof fetch;

  private readonly streamingTimeoutMs: number;
  private readonly nonStreamingTimeoutMs: number;
  private readonly defaultMaxOutputTokens?: number;
  private readonly defaultReasoningEffort?: ReasoningEffort;
  /**
   * Set once an endpoint has rejected the `reasoning` field.
   *
   * `reasoning` is an OpenRouter extension, not part of the OpenAI schema.
   * Gateways that don't know it mostly ignore it, but a strict server answers
   * HTTP 400 for the unknown parameter — which would turn a latency
   * optimisation into a total outage for that provider. So the first rejection
   * is absorbed: the request is reissued without the field and the field is
   * never sent to this adapter again. Not time-bounded, in the same spirit as
   * the router's image-capability verdict: a server that doesn't understand a
   * parameter won't start understanding it.
   */
  private reasoningRejected = false;
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
    // Blank / whitespace-only means "no fast model configured", matching how a
    // blank apiKey is read above. A Settings field the User left empty must not
    // become a request for the model named `''`.
    const trimmedFastModel = opts.fastModelId?.trim();
    this.fastModelId = trimmedFastModel ? trimmedFastModel : undefined;
    this.capabilities = opts.capabilities ?? DEFAULT_CAPABILITIES;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl;
    this.streamingTimeoutMs = opts.streamingTimeoutMs ?? DEFAULT_STREAMING_TIMEOUT_MS;
    this.nonStreamingTimeoutMs =
      opts.nonStreamingTimeoutMs ?? DEFAULT_NON_STREAMING_TIMEOUT_MS;
    this.defaultMaxOutputTokens = opts.defaultMaxOutputTokens;
    this.defaultReasoningEffort = opts.defaultReasoningEffort;
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
   * The model id to send.
   *
   * Precedence is explicit > fast > default. An explicit `opts.modelId` wins
   * outright because it is a caller naming one model, which is a stronger
   * statement than a caller expressing a preference for speed. `preferFastModel`
   * falls through to the default whenever no fast model is configured, so the
   * flag is safe to set unconditionally on the screen path.
   */
  private resolveModelId(opts: CallOpts): string {
    if (opts.modelId) return opts.modelId;
    if (opts.preferFastModel && this.fastModelId) return this.fastModelId;
    return this.defaultModelId;
  }

  /**
   * The deliberation budget to send, or `undefined` to omit the field. The
   * caller's choice wins over the adapter default; a prior rejection overrides
   * both, because sending it again would just reproduce the 400.
   */
  private resolveReasoningEffort(opts: CallOpts): ReasoningEffort | undefined {
    if (this.reasoningRejected) return undefined;
    return opts.reasoningEffort ?? this.defaultReasoningEffort;
  }

  /**
   * Issues a request, and if the endpoint rejects the `reasoning` extension,
   * reissues it once without that field.
   *
   * The retry exists because `reasoning` buys latency but is not universally
   * understood: a gateway that 400s on the unknown parameter would otherwise
   * fail every request to this provider. Only a 4xx naming the field triggers
   * it — a 429, a 5xx, or an unrelated 400 must keep their normal meaning so
   * the router's failover and retry logic still see the real error.
   */
  private async requestWithReasoningFallback(
    build: (effort: ReasoningEffort | undefined) => string,
    issue: (body: string) => Promise<Response>,
    opts: CallOpts,
  ): Promise<Response> {
    const effort = this.resolveReasoningEffort(opts);
    if (effort === undefined) return issue(build(undefined));

    try {
      return await issue(build(effort));
    } catch (err) {
      if (!isReasoningUnsupportedError(err)) throw err;
      this.reasoningRejected = true;
      console.warn(
        `[${this.providerId}] Endpoint rejected the 'reasoning' parameter — retrying without it and not sending it again.`,
      );
      return issue(build(undefined));
    }
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

    const modelId = this.resolveModelId(opts);
    const url = this.endpoint();
    const resolved = this.withDefaultMaxTokens(opts);

    const response = await this.requestWithReasoningFallback(
      (effort) => JSON.stringify(buildRequestBody(prompt, resolved, modelId, false, effort)),
      (body) =>
        retryWithJitter(
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
        ),
      opts,
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

    const modelId = this.resolveModelId(opts);
    const url = this.endpoint();
    const resolved = this.withDefaultMaxTokens(opts);

    // Wall-clock and attempt accounting for `cb.onMetrics`. Without these the
    // only adapter that ever reported metrics was `simulation`, so a real
    // request's latency could not be attributed to a model at all — and on this
    // path the whole question is whether the fast slot or the thinking model
    // answered.
    const startedAt = performance.now();
    let attempts = 0;
    let ttftMs = -1;

    const response = await this.requestWithReasoningFallback(
      (effort) => JSON.stringify(buildRequestBody(prompt, resolved, modelId, true, effort)),
      (body) =>
        retryWithJitter(
          () => {
            attempts += 1;
            return fetchWithTimeout(
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
            ).then((res) => throwIfNotOk(res, this.providerId, this.scrubError));
          },
          { signal: opts.signal },
        ),
      opts,
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
    let cumulativeReasoning = '';
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
            if (ttftMs < 0) ttftMs = performance.now() - startedAt;
            cumulativeText += partText;
            cb.onToken(cumulativeText);
          }
          // A thinking model streams its chain-of-thought here for the whole
          // reasoning phase while `delta.content` stays null. Surfaced
          // separately from `onToken` so it never contaminates the answer, but
          // surfaced at all so a 60-second think is visibly progressing rather
          // than indistinguishable from a stall.
          const partReasoning = extractDeltaReasoning(parsed);
          if (partReasoning) {
            cumulativeReasoning += partReasoning;
            cb.onReasoning?.(cumulativeReasoning);
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

    // A thinking model spends `max_tokens` on reasoning first, so a budget that
    // is generous for a normal answer can be exhausted before the answer
    // starts. The symptom is an empty success, which is otherwise
    // indistinguishable from a model that had nothing to say.
    if (!cumulativeText && cumulativeReasoning) {
      console.warn(
        `[${this.providerId}] Stream ended with ${cumulativeReasoning.length} chars of reasoning but an empty answer — ` +
          `the reasoning phase likely consumed the whole max_tokens budget. Raise it for this model.`,
      );
    }

    this.onUsage?.({
      modelId,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    });

    // Emitted before `onComplete` so a consumer that logs both sees the model id
    // alongside the timings rather than after them. `ttftMs` falls back to the
    // total when the answer was empty: there was no first token to time, and
    // reporting 0 would read as "instant".
    cb.onMetrics?.({
      ttftMs: Math.round(ttftMs >= 0 ? ttftMs : performance.now() - startedAt),
      totalMs: Math.round(performance.now() - startedAt),
      retries: Math.max(0, attempts - 1),
      modelId,
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
  reasoningEffort?: ReasoningEffort,
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

  // OpenRouter's reasoning control, and the de-facto convention gateways copy.
  // `'none'` maps to `enabled: false` rather than `effort: 'none'` because the
  // latter is rejected outright by models whose thinking cannot be turned off,
  // whereas `enabled: false` is documented to be ignored by them — a request
  // that degrades to "reasons anyway" beats one that 400s.
  if (reasoningEffort) {
    body.reasoning =
      reasoningEffort === 'none' ? { enabled: false } : { effort: reasoningEffort };
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
 * True when a request failed *because of* the `reasoning` extension rather than
 * for a real reason.
 *
 * Deliberately narrow. It requires a 4xx AND the word "reasoning" in the body
 * the gateway echoed back, because the consequence of a false positive is
 * permanently disabling a latency optimisation, and the consequence of matching
 * too loosely is worse: a 429 or a 5xx that happens to mention reasoning would
 * be swallowed into a silent retry instead of reaching the router's failover.
 * 402 is excluded on purpose — that is a real billing failure that a retry
 * without `reasoning` would not fix.
 */
function isReasoningUnsupportedError(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (typeof status !== 'number' || status < 400 || status >= 500) return false;
  if (status === 401 || status === 402 || status === 403 || status === 429) return false;
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  return msg.includes('reasoning');
}

/**
 * Reads a *reasoning* delta from a streaming SSE frame, returning '' when the
 * frame carries none.
 *
 * Thinking models (`qwen3-vl-…-thinking`, DeepSeek-R1, GLM-Z1, …) do not put
 * their chain-of-thought in `delta.content`. They emit it on a sibling field
 * for the whole reasoning phase, and `delta.content` stays null until the
 * answer itself begins. On a hard problem that phase runs for tens of seconds,
 * so an adapter that reads only `content` calls `onToken` zero times and the UI
 * cannot tell a working request from a hung one.
 *
 * Two spellings exist and neither is standard, so both are accepted:
 *   - `reasoning`          — OpenRouter's normalised field
 *   - `reasoning_content`  — DashScope / vLLM / SGLang, and DeepSeek's own API
 *
 * `reasoning_details` (OpenRouter's structured form) is deliberately ignored:
 * it duplicates `reasoning`, so reading both would double every chunk.
 */
function extractDeltaReasoning(json: unknown): string {
  if (!json || typeof json !== 'object') return '';
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const delta = (choices[0] as { delta?: Record<string, unknown> })?.delta;
  if (!delta || typeof delta !== 'object') return '';
  const reasoning = delta.reasoning ?? delta.reasoning_content;
  return typeof reasoning === 'string' ? reasoning : '';
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
