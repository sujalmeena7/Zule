// ============================================
// Zule AI — Provider adapter types
// ============================================
//
// Canonical interfaces for the `AI_Provider_Router` and its pluggable
// `Provider_Adapter` implementations (see design.md §Components and
// Interfaces > 3. AI_Provider_Router).
//
// These are the contracts that every adapter (Gemini, OpenAI, Anthropic,
// OllamaCompatible, Simulation) must satisfy. The router is a thin
// orchestrator that handles timeout, retry, abort, and failover concerns
// across adapters.

/**
 * Static capability descriptor reported by an adapter. Used by the router
 * for model selection (Requirements 4.10, 29.2 – 29.4) and by the UI for
 * feature gating (e.g. image input in `Context_Builder`, tool use in
 * future modes).
 */
export interface Capabilities {
  streaming: boolean;
  imageInput: boolean;
  toolUse: boolean;
  maxInputTokens: number;
  pricePerMTokens?: { input: number; output: number };
}

/**
 * `Context_Builder`'s report of what redaction it performed while
 * assembling a prompt (see design.md §Redaction attestation).
 *
 * `Context_Builder` is the single redaction site, so adapters cannot see
 * the segment structure themselves; instead the builder attests to its
 * own work and egress-sensitive adapters (the custom OpenAI-compatible
 * provider) refuse to transmit an unattested prompt.
 *
 * An empty rule set is *not* a failure: applying an empty User rule set
 * over every segment is a completed application, so `ruleCount: 0` with
 * `segmentsRedacted === segmentsTotal` attests successfully.
 */
export interface RedactionAttestation {
  /** True only when every section passed through the Redaction_Engine. */
  applied: boolean;
  /** Number of User-defined + built-in rules applied (0 is legitimate). */
  ruleCount: number;
  /** Number of `ContextSection`s emitted into the prompt. */
  segmentsTotal: number;
  /** Number of those sections passed through `redactText`. */
  segmentsRedacted: number;
}

/**
 * The structured prompt handed to an adapter. `fullPrompt` is the
 * already-assembled, redacted, citation-tagged text emitted by
 * `Context_Builder`; `systemPrompt` and `userText` are kept separate so
 * adapters that prefer role-tagged messages (OpenAI chat, Anthropic
 * messages) can compose their own envelope without re-parsing.
 *
 * `images` carries the optional downscaled keyframe used when the
 * configured adapter has `capabilities.imageInput` and the user has
 * opted in (see design.md §Context_Builder, Requirement 23.3).
 */
export interface PromptInput {
  /** Mode-derived system prompt (with style + language directives). */
  systemPrompt: string;
  /** The user query (explicit or implicitly derived). */
  userText: string;
  /** Fully assembled prompt text (redacted, citation-tagged). */
  fullPrompt: string;
  /** Optional image attachments for adapters with `imageInput`. */
  images?: Array<{ mimeType: string; base64: string }>;
  /**
   * Stamped by `Context_Builder`; required by the custom
   * OpenAI-compatible adapter, which issues zero HTTP requests when it is
   * absent, reports `applied: false`, or reports fewer redacted segments
   * than total segments. Optional so existing construction sites (and
   * local-only paths) keep compiling.
   */
  redaction?: RedactionAttestation;
}

/**
 * How much deliberation to request from a *thinking* model.
 *
 * These models spend a hidden reasoning phase before emitting a single answer
 * token, and its length dominates wall-clock latency: a hard problem can burn
 * 3000+ reasoning tokens at ~60 tok/s, so the answer starts around the
 * 50-second mark. Capping the effort trades a little accuracy on genuinely hard
 * problems for a large, predictable latency win, which is the right trade for a
 * live-interview copilot where an answer after the interviewer has moved on is
 * worth nothing.
 *
 * `'none'` asks to skip reasoning entirely. Not all models honour it — a
 * variant with thinking baked into its weights (`…-thinking`) reasons
 * regardless — so it is a request, not a guarantee.
 */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

/**
 * Per-call options. Timeouts and abort handling are honoured by the
 * shared HTTP utility (Requirements 4.4, 4.7).
 */
export interface CallOpts {
  /** Caller's abort signal; the underlying `fetch` is aborted within 200 ms of `signal.aborted`. */
  signal?: AbortSignal;
  /** Override the default per-request timeout. */
  timeoutMs?: number;
  /** Selected model id; resolved by the router via `selectModel` when omitted. */
  modelId?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Restrict failover to adapters whose `capabilities.imageInput` is true.
   *
   * Set when the prompt's only grounding is an image — a screen capture, a
   * phone photo — so the question exists in the pixels and nowhere else. Without
   * this the router walks its normal priority order, hands the prompt to
   * whichever adapter is first, and a text-only model has the image stripped and
   * answers that it was given no context. Skipping those adapters is not a
   * preference, it is the difference between an answer and a non-answer.
   *
   * When no registered adapter can accept images the router raises
   * `NoVisionProviderError` rather than silently degrading, so the caller can
   * fall back to OCR (slow but local) or tell the User which setting to change.
   */
  requireImageInput?: boolean;
  /**
   * Deliberation budget for a thinking model. Overrides the adapter's own
   * default; omitted from the request entirely when neither is set, so a
   * provider applies whatever it does normally.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Ask each adapter for its *fastest* model rather than its best one.
   *
   * Set on screen-grounded dispatches, where latency is the whole product: the
   * question is on screen in front of an interviewer, and an answer that arrives
   * after they have moved on is worth nothing regardless of its quality. A
   * thinking model spends its first minute deliberating before it emits a single
   * answer token, so on this path the right model is a different model, not the
   * same one asked more nicely.
   *
   * A boolean rather than a model id on purpose. The router fails over between
   * providers, and a model id is only meaningful to the provider that hosts it —
   * threading one through would send `qwen/…-instruct` to Anthropic on the
   * second attempt. Each adapter instead answers for itself and ignores the flag
   * when it has no fast model configured, so the fallback is always "behave
   * exactly as before".
   */
  preferFastModel?: boolean;
}

/**
 * The successful (or simulated) response from an adapter. `isSimulated`
 * propagates to `Response_Cache`, which refuses to store simulated
 * answers (Requirements 4.9, 7.4). `status` is the underlying HTTP
 * status; the cache also rejects entries whose status is non-2xx.
 */
export interface ProviderResponse {
  text: string;
  promptTokens: number;
  completionTokens: number;
  modelId: string;
  providerId: string;
  isSimulated: boolean;
  /** HTTP status of the originating request (200 for simulated). */
  status: number;
}

/**
 * Streaming callbacks. `onToken` receives the cumulative text on each
 * token so consumers do not need to concatenate; `onComplete` is invoked
 * at most once and never after `signal.aborted` (Requirement 4.7).
 * `onMetrics` is optional and emitted by the router with TTFT/total
 * latency, retry count, and the resolved model id (Requirement 14).
 *
 * `onReasoning` carries a *thinking* model's chain-of-thought, which arrives
 * on a separate delta field (`reasoning` / `reasoning_content`) and is not
 * part of the answer. It exists because on a hard problem that phase can run
 * for a minute while `onToken` is never called once, so a consumer with only
 * `onToken` has no way to distinguish "still working" from "hung". Optional:
 * adapters for non-reasoning models never call it.
 */
export interface StreamCallbacks {
  onToken: (cumulativeText: string) => void;
  onComplete: (response: ProviderResponse) => void;
  onError: (err: Error) => void;
  onReasoning?: (cumulativeReasoning: string) => void;
  onMetrics?: (m: {
    ttftMs: number;
    totalMs: number;
    retries: number;
    modelId: string;
  }) => void;
}

/**
 * The pluggable contract every cloud or local adapter implements
 * (Requirement 4.1). Adapters are pure data-plane shims: authentication
 * lives in HTTP headers (Requirement 4.6), and the router supplies
 * timeout, retry, abort, and failover behaviour.
 */
export interface ProviderAdapter {
  /** Stable identifier (`'gemini' | 'openai' | …`). */
  name: string;
  /** Static capability descriptor used by `selectModel`. */
  capabilities: Capabilities;
  /** Adapter-specific tokenizer used by `Context_Builder`. */
  countTokens(text: string): number;
  /** Non-streaming completion; bounded by `opts.timeoutMs` (default 6 000 ms). */
  complete(prompt: PromptInput, opts: CallOpts): Promise<ProviderResponse>;
  /** Streaming completion via SSE; bounded by `opts.timeoutMs` (default 12 000 ms). */
  streamGenerate(
    prompt: PromptInput,
    cb: StreamCallbacks,
    opts: CallOpts,
  ): Promise<void>;
}

/** Stable identifiers for the in-tree adapters. */
export type ProviderId =
  | 'gemini'
  | 'openai'
  | 'anthropic'
  | 'ollama'
  | 'simulation'
  /** User-configured OpenAI-compatible endpoint (opt-in, disabled by default). */
  | 'custom';
