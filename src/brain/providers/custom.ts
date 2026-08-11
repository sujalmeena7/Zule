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
import type { Capabilities, PromptInput } from './types';

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
 * anything. A copilot suggestion is a few hundred tokens, so this ceiling is
 * generous for the use case while keeping the authorisation small enough that
 * a nearly-exhausted balance still works. Overridable per configuration.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

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
