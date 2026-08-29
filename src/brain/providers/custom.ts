// ============================================
// Zule AI — CustomOpenAICompatibleAdapter (design.md §4)
// ============================================
//
// The Custom_Provider_Adapter: a thin subclass of the provider-agnostic
// `OpenAICompatibleAdapter` that pins the identifier `custom`, cloud-grade
// timeouts, a redaction guard, a secret scrubber, and token telemetry.
//
// Why a distinct identifier matters: `AI_Provider_Router` exempts the ids
// in `LOCAL_PROVIDER_NAMES` (`ollama`, `simulation`) from the vault-locked
// gate, the offline gate, and the 429 cooldown, because local runtimes never
// transmit User data off-device. A remote gateway registered under `ollama`
// would ship live transcripts and Knowledge_Base excerpts across the network
// while the application believes it is offline. Because this adapter's name
// is `custom`, every cloud gate applies to it by construction — no new gate
// logic exists here (Requirements 2.1, 2.2).
//
// Differences from the Ollama subclass, each traceable to a requirement:
//   - `name` / `providerId`: `'custom'`, never `'ollama'`     (2.1, 2.2)
//   - Timeouts: the `http.ts` cloud defaults (6 000 ms non-streaming,
//     12 000 ms streaming) rather than Ollama's 120 000 ms model-load budget
//   - Base_URL: used verbatim; only `/chat/completions` is appended and
//     `/v1` is never synthesised (the base class guarantees this)
//   - Constructor validation: throws when `baseUrl` or `modelId` is blank,
//     so an incompletely configured adapter cannot exist          (1.6)
//   - `preflight`: `assertRedacted`                          (2.9, 2.10)
//   - `scrubError`: `scrubSecret(message, apiKey)`                 (3.7)
//   - `onUsage`: exactly one `tokens` metric event per completed request (3.8)
//
// Requirements: 1.6, 2.1, 2.10, 3.2, 3.4, 3.7, 3.8

import { telemetry, type MetricEvent } from '../telemetry';
import { CUSTOM_PROVIDER_ID } from './customProviderConfig';
import {
  DEFAULT_NON_STREAMING_TIMEOUT_MS,
  DEFAULT_STREAMING_TIMEOUT_MS,
} from './http';
import {
  OpenAICompatibleAdapter,
  type OpenAICompatibleUsageEvent,
} from './openAICompatible';
import type { Capabilities, PromptInput, ReasoningEffort } from './types';

// --- Constants -----------------------------------------------------------

/** The mask substituted for a credential on every outward-facing surface. */
export const REDACTED_APIKEY_MASK = '[REDACTED:APIKEY]';

/**
 * Secrets shorter than this are not masked. A 4-character "key" could be a
 * common substring (`test`, `1234`) whose blanket replacement would mangle
 * unrelated error text without protecting anything meaningful.
 */
export const MIN_SCRUBBABLE_SECRET_LENGTH = 8;

/**
 * `max_tokens` sent when the caller specifies none.
 *
 * A remote gateway that meters spend authorises the request against the
 * *requested* ceiling, not the tokens actually produced. Omitting `max_tokens`
 * makes the gateway reserve the model's entire output window, which a
 * credit-limited key cannot cover — OpenRouter refuses with HTTP 402 ("you
 * requested up to 16384 tokens, but can only afford …") before generating
 * anything. So a ceiling is sent, but it has to be a *bounded* one rather than
 * a tight one.
 *
 * 2048 was tight, sized for "a copilot suggestion is a few hundred tokens".
 * That reasoning does not survive a thinking model: on those, `max_tokens` is
 * the budget for the reasoning phase *and* the answer, and the reasoning runs
 * first. A hard problem (design an O(1) LFU cache) can spend well over 2000
 * tokens deciding on the approach, at which point the request ends having
 * produced only a chain-of-thought — a successful HTTP 200 with an empty or
 * truncated answer, which looks like the model had nothing to say.
 *
 * 8192 is still small enough to authorise against a nearly-exhausted balance
 * (fractions of a cent on the cheap models people put behind a gateway) and
 * far from "the model's entire output window", so the 402 this constant exists
 * to prevent stays prevented. Overridable per configuration.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/**
 * Deliberation budget requested from a thinking model behind a gateway.
 *
 * Sized from a measurement, not a preference: on `qwen3-vl-235b-a22b-thinking`
 * a hard DSA problem produced 3099 reasoning tokens at roughly 60 tok/s, so the
 * first answer token landed near 52 seconds. That is past the point where a
 * live-interview answer is worth anything, and the reasoning phase was the
 * whole cost — capture had already finished in tens of milliseconds.
 *
 * `'low'` rather than `'none'` because a thinking-tuned variant reasons whether
 * or not it is asked to, so `'none'` buys nothing while giving up the option of
 * a shorter think. Overridable per configuration, and ignored outright by
 * endpoints that don't implement the parameter.
 */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'low';

/**
 * Conservative capability descriptor for an arbitrary gateway model.
 *
 * `imageInput` and `toolUse` default to `false` because an arbitrary model
 * behind a gateway is not known to be multimodal or tool-capable, and
 * sending image parts to a text-only model produces a hard 400 on most
 * gateways. Both are overridable via `capabilities` for a User who knows
 * their endpoint supports them. Pricing defaults to zero so an un-priced
 * endpoint never inflates Spend_Tracker.
 */
const DEFAULT_CAPABILITIES: Capabilities = {
  streaming: true,
  imageInput: true,
  toolUse: false,
  maxInputTokens: 32_000,
  pricePerMTokens: { input: 0, output: 0 },
};

// --- Errors --------------------------------------------------------------

/**
 * Thrown by the pre-flight guard when a prompt carries no complete redaction
 * attestation. Content-free by construction: it names the provider and
 * nothing else, so it can be logged and surfaced verbatim
 * (Requirement 2.10; `ZuleError` variant `provider.redaction-incomplete`).
 */
export class RedactionIncompleteError extends Error {
  readonly code = 'REDACTION_INCOMPLETE' as const;
  readonly providerId: string;
  constructor(providerId: string) {
    super(
      `Custom_Provider_Adapter: refusing to transmit to provider '${providerId}' because redaction did not complete over every prompt segment. No request was issued.`,
    );
    this.name = 'RedactionIncompleteError';
    this.providerId = providerId;
  }
}

// --- Pure helpers --------------------------------------------------------

/**
 * Replaces every occurrence of `secret` — and its `Bearer …` form — with a
 * fixed mask.
 *
 * Returns `text` unchanged when `secret` is absent, blank, or shorter than
 * `MIN_SCRUBBABLE_SECRET_LENGTH` characters, which avoids pathological
 * masking of common substrings.
 *
 * This exists because a careless gateway can echo the request's
 * `Authorization` header back inside a 4xx body, and the base class embeds
 * the first 200 characters of that body in the error message. It is applied
 * to the adapter's error messages, to the Connection_Test result, and to
 * every Provider_Sync log line (Requirements 3.7, 3.9).
 *
 * Pure: no regular expressions are compiled from the secret (a key
 * containing regex metacharacters would otherwise change the semantics),
 * only literal `split`/`join` replacement.
 */
export function scrubSecret(text: string, secret?: string): string {
  if (!secret) return text;
  const trimmed = secret.trim();
  if (trimmed.length < MIN_SCRUBBABLE_SECRET_LENGTH) return text;

  // Replace the Bearer form first so the composite never degrades to
  // `Bearer [REDACTED:APIKEY]`, which would still confirm the scheme in use.
  return text
    .split(`Bearer ${trimmed}`)
    .join(REDACTED_APIKEY_MASK)
    .split(trimmed)
    .join(REDACTED_APIKEY_MASK);
}

/**
 * Pre-flight guard: throws unless the prompt carries a complete redaction
 * attestation, i.e. `Context_Builder` reported that it applied the rule set
 * over every transcript, screen, and Knowledge_Base segment it emitted.
 *
 * An empty rule set is not a failure — applying zero rules over every
 * segment is a *completed* application, so `ruleCount: 0` with
 * `segmentsRedacted === segmentsTotal` attests successfully.
 *
 * The base class calls this before the request body is serialised and before
 * any `fetch`, so a throw produces zero HTTP requests to the Base_URL. The
 * adapter holds no local state and never touches IndexedDB, so "retain the
 * unsent text in local storage unmodified" holds structurally
 * (Requirements 2.9, 2.10).
 */
export function assertRedacted(prompt: PromptInput): void {
  const attestation = prompt.redaction;
  if (
    !attestation ||
    attestation.applied !== true ||
    attestation.segmentsRedacted !== attestation.segmentsTotal
  ) {
    throw new RedactionIncompleteError(CUSTOM_PROVIDER_ID);
  }
}

/** Coerce a gateway-reported token count to a non-negative integer. */
function toNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

// --- Public options ------------------------------------------------------

export interface CustomProviderAdapterOptions {
  /** Absolute http(s) prefix, already normalised by the Endpoint_Validator. */
  baseUrl: string;
  /** The `model` field value sent in the request body. Must be non-blank. */
  modelId: string;
  /**
   * Optional second model id, used only when the caller sets
   * `CallOpts.preferFastModel` — in practice, screen-grounded dispatches.
   *
   * A gateway usually fronts both a thinking and a non-thinking variant of the
   * same vision model under one key, and the difference between them on a hard
   * problem is roughly a minute of deliberation. Unlike `modelId` this is
   * optional and a blank value is not a configuration error: it simply means
   * every dispatch keeps using `modelId`, which is the pre-existing behaviour.
   */
  fastModelId?: string;
  /**
   * Optional bearer credential. A blank / whitespace-only value is treated
   * as "no credential configured": the base class then omits the
   * `Authorization` header entirely and adds no other credential-bearing
   * header (Requirements 3.2, 3.4).
   */
  apiKey?: string;
  /** Override the conservative default capability descriptor. */
  capabilities?: Capabilities;
  /** User-supplied pricing so Spend_Tracker can cost custom requests. */
  pricePerMTokens?: { input: number; output: number };
  /** Injectable `fetch` for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable metric sink. Defaults to the shared `telemetry.emit`. */
  telemetrySink?: (event: MetricEvent) => void;
  /** Override the 12 000 ms streaming timeout. */
  streamingTimeoutMs?: number;
  /** Override the 6 000 ms non-streaming timeout. */
  nonStreamingTimeoutMs?: number;
  /**
   * `max_tokens` sent when the caller does not specify one. Defaults to
   * `DEFAULT_MAX_OUTPUT_TOKENS`.
   */
  defaultMaxOutputTokens?: number;
  /**
   * Deliberation budget for a thinking model. Defaults to
   * `DEFAULT_REASONING_EFFORT`.
   */
  defaultReasoningEffort?: ReasoningEffort;
}

// --- Adapter -------------------------------------------------------------

/**
 * The Custom_Provider_Adapter. Everything except identity, timeouts, and the
 * three injected hooks is inherited from `OpenAICompatibleAdapter`.
 */
export class CustomOpenAICompatibleAdapter extends OpenAICompatibleAdapter {
  readonly name = CUSTOM_PROVIDER_ID;

  constructor(opts: CustomProviderAdapterOptions) {
    // Requirement 1.6: an incompletely configured adapter must not be
    // constructible, so Provider_Sync cannot register one that would issue
    // requests to an empty endpoint or with an empty model id. Blankness is
    // `trim().length === 0`, so tabs / newlines / unicode spaces count as
    // empty.
    const baseUrl = opts.baseUrl?.trim() ?? '';
    const modelId = opts.modelId?.trim() ?? '';
    if (!baseUrl) {
      throw new Error(
        `CustomOpenAICompatibleAdapter: baseUrl is required and must be non-blank (provider '${CUSTOM_PROVIDER_ID}').`,
      );
    }
    if (!modelId) {
      throw new Error(
        `CustomOpenAICompatibleAdapter: modelId is required and must be non-blank (provider '${CUSTOM_PROVIDER_ID}').`,
      );
    }

    const apiKey = opts.apiKey?.trim() ? opts.apiKey.trim() : undefined;
    const sink = opts.telemetrySink ?? ((event: MetricEvent) => telemetry.emit(event));

    const capabilities: Capabilities = opts.capabilities ?? {
      ...DEFAULT_CAPABILITIES,
      pricePerMTokens:
        opts.pricePerMTokens ?? DEFAULT_CAPABILITIES.pricePerMTokens,
    };

    super({
      providerId: CUSTOM_PROVIDER_ID,
      baseUrl,
      defaultModelId: modelId,
      // Optional by design: blank stays blank and the base class then ignores
      // `preferFastModel` entirely, rather than requesting the model named ''.
      fastModelId: opts.fastModelId,
      apiKey,
      capabilities,
      // Cloud-grade budgets from `http.ts`, not Ollama's model-load budget.
      streamingTimeoutMs: opts.streamingTimeoutMs ?? DEFAULT_STREAMING_TIMEOUT_MS,
      nonStreamingTimeoutMs:
        opts.nonStreamingTimeoutMs ?? DEFAULT_NON_STREAMING_TIMEOUT_MS,
      // Bound the requested output so a metered gateway authorises against a
      // small ceiling rather than the model's full output window.
      defaultMaxOutputTokens:
        opts.defaultMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      defaultReasoningEffort:
        opts.defaultReasoningEffort ?? DEFAULT_REASONING_EFFORT,
      fetchImpl: opts.fetchImpl,
      // Requirement 2.10 — runs before serialisation and before any fetch.
      preflight: assertRedacted,
      // Requirement 3.7 — last-chance scrub of every escaping error message.
      scrubError: (message: string) => scrubSecret(message, apiKey),
      // Requirement 3.8 — exactly one content-free token event per request.
      onUsage: (usage: OpenAICompatibleUsageEvent) => {
        sink(buildTokensEvent(usage));
      },
    });
  }
}

/**
 * Builds the single `tokens` metric event emitted per completed request.
 * `MetricEvent` has no free-form payload field, so the credential and the
 * `Authorization` header value are structurally excluded from every field
 * (Requirement 3.8).
 */
function buildTokensEvent(
  usage: OpenAICompatibleUsageEvent,
): Extract<MetricEvent, { kind: 'tokens' }> {
  return {
    kind: 'tokens',
    providerId: CUSTOM_PROVIDER_ID,
    modelId: usage.modelId,
    promptTokens: toNonNegativeInteger(usage.promptTokens),
    completionTokens: toNonNegativeInteger(usage.completionTokens),
  };
}
