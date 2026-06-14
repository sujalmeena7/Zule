// ============================================
// Zule AI — SimulationAdapter
// ============================================
//
// Pluggable `Provider_Adapter` that produces plausible canned responses
// without making any network requests. Used as the offline fallback when
// no cloud API key is configured (and as the failover sink when every
// real provider has errored out — see `AI_Provider_Router`).
//
// Two invariants make this adapter different from the cloud ones:
//
//   1. Every `ProviderResponse` it emits sets `isSimulated: true`. The
//      `Response_Cache` refuses to store responses with `isSimulated`
//      true, so simulated answers never poison the persistent cache
//      (Requirements 4.9, 7.4). The `AI_Provider_Router` likewise
//      propagates this flag through to the UI badge.
//
//   2. The adapter never opens a network connection — there is no
//      `fetch` call here at all. That keeps Requirement 4.6 trivially
//      satisfied (no API key can possibly leak into a URL because there
//      is no URL).
//
// The streaming implementation honours `AbortSignal.aborted` per
// Requirement 4.7: word-sized tokens are emitted with a small simulated
// inter-token delay, the abort listener resolves the in-flight delay
// immediately, the loop re-checks `signal.aborted` between yields, and
// `onComplete` is never invoked after an abort.

import type {
  Capabilities,
  CallOpts,
  ProviderAdapter,
  ProviderResponse,
  PromptInput,
  StreamCallbacks,
} from './types';

// --- Constants -----------------------------------------------------------

/** Stable identifier used in `ProviderResponse.providerId` and routing. */
const PROVIDER_ID = 'simulation' as const;

/** Default model id reported in `ProviderResponse.modelId`. */
const DEFAULT_MODEL_ID = 'simulation-v1';

/**
 * Default delay between word-sized tokens during streaming. Small enough
 * that tests run quickly but large enough that an abort issued mid-stream
 * actually has tokens to interrupt.
 */
const DEFAULT_TOKEN_DELAY_MS = 12;

/**
 * Default capability descriptor. Matches the design (Requirement 4.2):
 * streaming is supported; imageInput and toolUse are not (the simulated
 * generator would need additional logic for either); the input cap is
 * the design's nominal 8 000-token Context_Builder budget; pricing is
 * zero across the board so cost telemetry stays honest.
 */
const DEFAULT_CAPABILITIES: Capabilities = {
  streaming: true,
  imageInput: false,
  toolUse: false,
  maxInputTokens: 8_000,
  pricePerMTokens: { input: 0, output: 0 },
};

/**
 * A small library of canned lead phrases for variety. Each response
 * starts with a stable "This is a simulated response." marker so the
 * UI badge and the user's eye can both spot offline output at a glance,
 * then continues with a content-agnostic continuation. The actual user
 * prompt is appended (truncated) so the simulated answer is not totally
 * detached from what was asked.
 */
const DEFAULT_CANNED_RESPONSES: readonly string[] = [
  "This is a simulated response. I'd approach this by breaking it into clear phases and validating early.",
  'This is a simulated response. Based on the context, a reasonable direction would be to summarize the key points and outline next steps.',
  "This is a simulated response. The honest answer depends on a few factors, but here's a plausible direction.",
  'This is a simulated response. A useful framing here is to identify the core question, then propose a concise plan.',
  'This is a simulated response. Drawing on what was shared, the most likely answer is to focus on the highest-impact item first.',
];

/** Maximum number of prompt characters echoed back into the synthetic response. */
const PROMPT_ECHO_CHARS = 200;

// --- Public options ------------------------------------------------------

export interface SimulationAdapterOptions {
  /** Override the default capability descriptor. */
  capabilities?: Capabilities;
  /** Override the default model id reported in responses. */
  defaultModelId?: string;
  /**
   * Inter-token delay during streaming, in ms. Tests can pass a tiny
   * value (or 0) to keep the suite fast while still exercising the
   * abort path.
   */
  tokenDelayMs?: number;
  /** Override the canned-response library. */
  cannedResponses?: readonly string[];
}

// --- Adapter -------------------------------------------------------------

/**
 * Offline-only implementation of the `ProviderAdapter` contract. Stable,
 * cheap, and content-agnostic.
 */
export class SimulationAdapter implements ProviderAdapter {
  readonly name = PROVIDER_ID;
  readonly capabilities: Capabilities;

  private readonly defaultModelId: string;
  private readonly tokenDelayMs: number;
  private readonly cannedResponses: readonly string[];
  /** Round-robin index into the canned-response library. */
  private nextResponseIndex = 0;

  constructor(opts: SimulationAdapterOptions = {}) {
    this.capabilities = opts.capabilities ?? DEFAULT_CAPABILITIES;
    this.defaultModelId = opts.defaultModelId ?? DEFAULT_MODEL_ID;
    this.tokenDelayMs = Math.max(0, opts.tokenDelayMs ?? DEFAULT_TOKEN_DELAY_MS);
    const lib = opts.cannedResponses ?? DEFAULT_CANNED_RESPONSES;
    this.cannedResponses =
      lib.length > 0 ? lib : ['This is a simulated response.'];
  }

  /**
   * Same ~4-chars-per-token approximation the Gemini adapter uses. The
   * router calls this from `Context_Builder` to bound prompt assembly,
   * so it must be cheap and conservative; over-counting on dense text
   * is the safe direction.
   */
  countTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Non-streaming variant. Resolves synchronously (apart from the
   * Promise micro-task) with a synthetic response. Pre-aborted signals
   * reject with `AbortError` so the router can surface cancellation
   * uniformly across adapters.
   */
  async complete(prompt: PromptInput, opts: CallOpts): Promise<ProviderResponse> {
    if (opts.signal?.aborted) {
      throw makeAbortError();
    }

    const modelId = opts.modelId ?? this.defaultModelId;
    const text = this.synthesizeText(prompt);
    const promptText = promptTextOf(prompt);

    return {
      text,
      promptTokens: this.countTokens(promptText),
      completionTokens: this.countTokens(text),
      modelId,
      providerId: PROVIDER_ID,
      isSimulated: true,
      status: 200,
    };
  }

  /**
   * Streaming variant. Emits word-sized chunks with an inter-token
   * delay, calling `onToken(cumulativeText)` after each chunk and
   * `onComplete(response)` exactly once when the canned text is
   * exhausted. Honours `AbortSignal.aborted` per Requirement 4.7:
   *
   *   - If the signal is already aborted on entry, the method returns
   *     immediately without emitting any callback.
   *   - If the signal aborts mid-stream, the in-flight delay resolves
   *     immediately, the loop re-checks `signal.aborted`, and the
   *     method returns without invoking `onComplete`. Any tokens emitted
   *     before the abort are kept (the receiver is expected to discard
   *     them on its end — that's what `useEffect` cleanup does).
   */
  async streamGenerate(
    prompt: PromptInput,
    cb: StreamCallbacks,
    opts: CallOpts,
  ): Promise<void> {
    if (opts.signal?.aborted) return;

    const modelId = opts.modelId ?? this.defaultModelId;
    const text = this.synthesizeText(prompt);
    const promptText = promptTextOf(prompt);
    const startTs = nowMs();
    let firstTokenTs: number | null = null;

    const chunks = splitIntoWordChunks(text);
    let cumulative = '';

    try {
      for (const chunk of chunks) {
        if (opts.signal?.aborted) return;
        await delay(this.tokenDelayMs, opts.signal);
        if (opts.signal?.aborted) return;
        cumulative += chunk;
        if (firstTokenTs === null) firstTokenTs = nowMs();
        cb.onToken(cumulative);
      }
    } catch (err) {
      if (opts.signal?.aborted) return;
      cb.onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    // Final abort check: the signal may have fired between the last
    // `onToken` and here. Per Requirement 4.7, `onComplete` MUST NOT be
    // invoked after the abort.
    if (opts.signal?.aborted) return;

    const endTs = nowMs();
    const response: ProviderResponse = {
      text: cumulative,
      promptTokens: this.countTokens(promptText),
      completionTokens: this.countTokens(cumulative),
      modelId,
      providerId: PROVIDER_ID,
      isSimulated: true,
      status: 200,
    };

    cb.onComplete(response);
    cb.onMetrics?.({
      ttftMs: firstTokenTs !== null ? firstTokenTs - startTs : 0,
      totalMs: endTs - startTs,
      retries: 0,
      modelId,
    });
  }

  // --- Internal --------------------------------------------------------

  /** Builds the synthetic answer text from a canned lead plus a prompt echo. */
  private synthesizeText(prompt: PromptInput): string {
    const lead = this.pickCannedResponse();
    const promptText = promptTextOf(prompt).trim();
    if (!promptText) return lead;
    const echo = promptText.slice(0, PROMPT_ECHO_CHARS);
    return `${lead} (re: ${echo})`;
  }

  /** Round-robins through the canned-response library for variety. */
  private pickCannedResponse(): string {
    const idx = this.nextResponseIndex % this.cannedResponses.length;
    this.nextResponseIndex = (this.nextResponseIndex + 1) % this.cannedResponses.length;
    return this.cannedResponses[idx]!;
  }
}

// --- Helpers (module-private) -------------------------------------------

/** Prefer the fully-assembled prompt; fall back to the bare user text. */
function promptTextOf(prompt: PromptInput): string {
  return prompt.fullPrompt || prompt.userText || '';
}

/**
 * Splits `text` into word-sized chunks where each chunk is one
 * non-whitespace run plus its trailing whitespace, so concatenating the
 * chunks faithfully reconstructs the original string. Returns a single-
 * element array containing `text` as a fallback when no word boundaries
 * exist (e.g., a very short response without spaces).
 */
function splitIntoWordChunks(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const re = /\S+\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m[0]);
  }
  if (out.length === 0) out.push(text);
  return out;
}

/**
 * Awaitable delay that resolves early if the supplied `signal` aborts.
 * The pending `setTimeout` is cleared on abort so we don't leak a timer
 * past the natural lifetime of the call.
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (signal && abortListener) {
        signal.removeEventListener('abort', abortListener);
      }
      resolve();
    }, ms);
    let abortListener: (() => void) | undefined;
    if (signal) {
      abortListener = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', abortListener, { once: true });
    }
  });
}

/** Monotonic-ish clock; falls back to `Date.now` when `performance` is absent. */
function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/** Builds a DOMException-shaped abort error compatible with cancellable APIs. */
function makeAbortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('The operation was aborted.', 'AbortError');
  }
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}
