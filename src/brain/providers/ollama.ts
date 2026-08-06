// ============================================
// Zule AI — OllamaCompatibleAdapter
// ============================================
//
// Thin subclass of the provider-agnostic `OpenAICompatibleAdapter`
// (`./openAICompatible.ts`), pinned to local OpenAI-compatible runtimes
// such as Ollama (`http://localhost:11434/v1`) and LM Studio
// (`http://localhost:1234/v1`). Both expose the OpenAI Chat Completions
// wire format, so the shared transport serves both.
//
// The whole transport — request-body assembly, timeout / abort / retry
// delegation to `./http.ts`, chunk-boundary-safe SSE parsing via
// `../sse.ts`, the `data: [DONE]` sentinel, error classification, and the
// token-usage fallback estimator — lives in the base class. This module
// only pins the local-runtime identity and defaults:
//
//   - `providerId: 'ollama'` — the local-provider identity that
//     `AI_Provider_Router`'s `LOCAL_PROVIDER_NAMES` allowlist exempts from
//     the vault-locked and offline gates. A remote gateway must never be
//     registered under it; that is what `custom.ts` exists for.
//   - Base URL `http://localhost:11434/v1`, model `llama3.1`.
//   - 120 000 ms timeouts both ways, because Ollama may need to load the
//     model into VRAM on first request (~15-60 s) on consumer GPUs. There
//     is no network latency concern — only compute time.
//   - Capabilities advertise `imageInput: true` and `toolUse: true`: the
//     OpenAI-compatible `/v1/chat/completions` endpoint supports multimodal
//     content parts for vision models (llava, llama3.2-vision, bakllava)
//     and modern models (llama3.1, qwen2.5) accept the OpenAI-style `tools`
//     field. Non-capable models gracefully ignore both. Zero pricing —
//     local inference is free at the wire level.
//
// No API key is required for vanilla Ollama. LM Studio (and some
// reverse-proxied deployments) optionally accept a bearer token; the base
// class sends `Authorization: Bearer ${apiKey}` only when one is
// configured, and the secret travels in a header, never in the URL.
//
// Requirements: 2.2

import { OpenAICompatibleAdapter } from './openAICompatible';
import type { Capabilities } from './types';

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
 * the same surface). Inherits `streamGenerate`, `complete`, and
 * `countTokens` from `OpenAICompatibleAdapter`.
 */
export class OllamaCompatibleAdapter extends OpenAICompatibleAdapter {
  constructor(opts: OllamaCompatibleAdapterOptions = {}) {
    super({
      providerId: PROVIDER_ID,
      baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL,
      defaultModelId: opts.defaultModelId ?? DEFAULT_MODEL_ID,
      apiKey: opts.apiKey,
      capabilities: opts.capabilities ?? DEFAULT_CAPABILITIES,
      streamingTimeoutMs: LOCAL_STREAMING_TIMEOUT_MS,
      nonStreamingTimeoutMs: LOCAL_NON_STREAMING_TIMEOUT_MS,
      fetchImpl: opts.fetchImpl,
    });
  }
}
