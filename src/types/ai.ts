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
}

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
 */
export interface StreamCallbacks {
  onToken: (cumulativeText: string) => void;
  onComplete: (response: ProviderResponse) => void;
  onError: (err: Error) => void;
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
  | 'simulation';
