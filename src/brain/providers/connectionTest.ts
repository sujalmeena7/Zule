// ============================================
// Zule AI — Connection_Test for the Custom (OpenAI-compatible) provider
// ============================================
//
// A single, non-streaming probe that verifies a Custom_Provider configuration
// before the User relies on it (design.md §9. Connection_Test).
//
// Three properties of this module are load-bearing:
//
//   1. **One request, no retries.** The probe uses `fetchWithTimeout` with the
//      6 000 ms non-streaming budget and deliberately does NOT wrap the call in
//      `retryWithJitter`: a configuration probe must report the *first* failure
//      rather than retry into it, so the User sees the actual misconfiguration.
//
//   2. **No User data.** The request body is the fixed literal `'ping'`. It
//      carries zero transcript, screen, or Knowledge_Base content, so it is not
//      subject to the redaction attestation and needs neither the vault-locked
//      nor the offline gate — it does not go through AI_Provider_Router at all.
//
//   3. **No credential on any surface.** The API_Key travels only in the
//      `Authorization: Bearer` header — never in the path, query string, or
//      fragment (Requirement 3.3). `detail` is a short classification string
//      (`HTTP 401`, `Network request failed`, …) passed through `scrubSecret`,
//      never the raw response body and never the URL, so a gateway that echoes
//      the `Authorization` header back inside a 4xx body cannot surface it in
//      the UI (Requirement 3.9).
//
// Requirements: 3.3, 3.9

import { scrubSecret } from './custom';
import { normalizeBaseUrl } from './endpointValidator';
import { DEFAULT_NON_STREAMING_TIMEOUT_MS, fetchWithTimeout } from './http';

/** The fixed probe prompt. Contains no User content of any kind. */
const PROBE_CONTENT = 'ping';

export type ConnectionTestFailure =
  | 'invalid-url'
  | 'missing-model'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'rate-limited'
  | 'server-error'
  | 'network'
  | 'timeout'
  | 'bad-response';

export type ConnectionTestResult =
  | { ok: true; latencyMs: number; modelEcho?: string }
  | { ok: false; category: ConnectionTestFailure; status?: number; detail: string };

export interface ConnectionTestInput {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  /** Injectable `fetch` for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Defaults to the 6 000 ms non-streaming budget. */
  timeoutMs?: number;
}

/** Short, credential-free explanation for each Base_URL rejection reason. */
const BASE_URL_DETAIL: Record<'empty' | 'too-long' | 'unparseable' | 'unsupported-scheme', string> = {
  empty: 'Base URL is required',
  'too-long': 'Base URL is too long',
  unparseable: 'Base URL is not a valid absolute URL',
  'unsupported-scheme': 'Base URL must use http or https',
};

/**
 * Classifies a non-OK HTTP status into a failure category. Statuses outside the
 * enumerated set fall back to `server-error` for 5xx and `bad-response` for
 * everything else, so the mapping is total.
 */
function categorizeStatus(status: number): ConnectionTestFailure {
  switch (status) {
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not-found';
    case 429:
      return 'rate-limited';
    default:
      return status >= 500 ? 'server-error' : 'bad-response';
  }
}

/** True for a per-request timeout or a caller/underlying abort. */
function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  return Boolean(err) && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError';
}

/**
 * Issues a single non-streaming `POST {normalised baseUrl}/chat/completions`
 * probe and maps the outcome onto the `ConnectionTestFailure` categories.
 *
 * Never throws: every failure path — invalid configuration, transport error,
 * timeout, HTTP error, unparseable body — is returned as
 * `{ ok: false, category, detail }` with a scrubbed, credential-free `detail`.
 */
export async function testCustomProviderConnection(
  input: ConnectionTestInput,
): Promise<ConnectionTestResult> {
  const apiKey = input.apiKey ?? '';
  // Every `detail` this function returns goes through this, so a credential can
  // never reach the UI even if a future branch embeds gateway-supplied text.
  const scrub = (text: string): string => scrubSecret(text, apiKey);

  const base = normalizeBaseUrl(input.baseUrl ?? '');
  if (!base.ok) {
    return { ok: false, category: 'invalid-url', detail: scrub(BASE_URL_DETAIL[base.reason]) };
  }

  const modelId = (input.modelId ?? '').trim();
  if (modelId.length === 0) {
    return { ok: false, category: 'missing-model', detail: scrub('Model ID is required') };
  }

  // The credential is placed in the header below; the URL is built purely from
  // the normalised Base_URL and a fixed path segment (Requirement 3.3).
  const endpoint = `${base.url}/chat/completions`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // A blank or whitespace-only key means "no credential": omit the header
  // rather than sending `Bearer ` (mirrors the adapter's behaviour).
  if (apiKey.trim().length > 0) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const body = JSON.stringify({
    model: modelId,
    messages: [{ role: 'user', content: PROBE_CONTENT }],
    max_tokens: 1,
    stream: false,
  });

  const timeoutMs =
    typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? input.timeoutMs
      : DEFAULT_NON_STREAMING_TIMEOUT_MS;

  const startedAt = Date.now();

  let response: Response;
  try {
    // Single attempt — no `retryWithJitter` (design.md §9).
    response = await fetchWithTimeout(
      endpoint,
      { method: 'POST', headers, body },
      { timeoutMs, kind: 'non-streaming', fetchImpl: input.fetchImpl },
    );
  } catch (err) {
    if (isAbortError(err)) {
      return { ok: false, category: 'timeout', detail: scrub(`Timed out after ${timeoutMs} ms`) };
    }
    // Transport-level failure: DNS, TLS, connection reset, CORS, offline.
    // The underlying message may contain the URL, so it is never surfaced.
    return { ok: false, category: 'network', detail: scrub('Network request failed') };
  }

  const latencyMs = Math.max(0, Date.now() - startedAt);

  if (!response.ok) {
    // `HTTP <status>` only — never the response body.
    return {
      ok: false,
      category: categorizeStatus(response.status),
      status: response.status,
      detail: scrub(`HTTP ${response.status}`),
    };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return {
      ok: false,
      category: 'bad-response',
      status: response.status,
      detail: scrub('Response body was not valid JSON'),
    };
  }

  if (parsed === null || typeof parsed !== 'object') {
    return {
      ok: false,
      category: 'bad-response',
      status: response.status,
      detail: scrub('Response body was not a JSON object'),
    };
  }

  const echoed = (parsed as { model?: unknown }).model;
  const modelEcho = typeof echoed === 'string' && echoed.trim().length > 0 ? echoed : undefined;

  return modelEcho === undefined ? { ok: true, latencyMs } : { ok: true, latencyMs, modelEcho };
}

export interface ProviderConnectionTestInput {
  providerId: string;
  apiKey?: string;
  baseUrl?: string;
  modelId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Universal connection test that routes to the appropriate provider-specific probe.
 * Supports gemini, openai, anthropic, ollama, and custom.
 */
export async function testProviderConnection(
  input: ProviderConnectionTestInput,
): Promise<ConnectionTestResult> {
  const { providerId, apiKey = '', baseUrl = '', modelId = '', fetchImpl, timeoutMs } = input;
  const scrub = (text: string): string => scrubSecret(text, apiKey);
  const timeout =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_NON_STREAMING_TIMEOUT_MS;

  switch (providerId) {
    case 'gemini': {
      if (!apiKey.trim()) {
        return { ok: false, category: 'unauthorized', detail: scrub('API key is required') };
      }
      const geminiModel = modelId.trim() || 'gemini-2.0-flash';
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey.trim(),
      };
      const body = JSON.stringify({
        contents: [{ parts: [{ text: PROBE_CONTENT }] }],
        generationConfig: { maxOutputTokens: 1 },
      });
      const startedAt = Date.now();
      try {
        const response = await fetchWithTimeout(
          endpoint,
          { method: 'POST', headers, body },
          { timeoutMs: timeout, kind: 'non-streaming', fetchImpl },
        );
        let latencyMs = Math.max(0, Date.now() - startedAt);

        // Fallback across standard Google Gemini model endpoints on 429 or 404
        if (!response.ok && (response.status === 429 || response.status === 404)) {
          const fallbacks = [
            'gemini-2.0-flash',
            'gemini-1.5-flash',
            'gemini-1.5-pro',
            'gemini-2.0-flash-lite',
          ].filter((m) => m !== geminiModel);
          for (const fallbackModel of fallbacks) {
            const fallbackEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${fallbackModel}:generateContent`;
            const fallbackStarted = Date.now();
            try {
              const fallbackRes = await fetchWithTimeout(
                fallbackEndpoint,
                { method: 'POST', headers, body },
                { timeoutMs: timeout, kind: 'non-streaming', fetchImpl },
              );
              if (fallbackRes.ok) {
                latencyMs = Math.max(0, Date.now() - fallbackStarted);
                return { ok: true, latencyMs, modelEcho: fallbackModel };
              }
            } catch {
              // Ignore fallback network error and try next
            }
          }
        }



        if (!response.ok) {
          return {
            ok: false,
            category: categorizeStatus(response.status),
            status: response.status,
            detail: scrub(`HTTP ${response.status}`),
          };
        }
        return { ok: true, latencyMs, modelEcho: geminiModel };
      } catch (err) {
        if (isAbortError(err)) {
          return { ok: false, category: 'timeout', detail: scrub(`Timed out after ${timeout} ms`) };
        }
        return { ok: false, category: 'network', detail: scrub('Network request failed') };
      }
    }



    case 'openai': {
      if (!apiKey.trim()) {
        return { ok: false, category: 'unauthorized', detail: scrub('API key is required') };
      }
      const openaiModel = modelId.trim() || 'gpt-4o-mini';
      return testCustomProviderConnection({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: apiKey.trim(),
        modelId: openaiModel,
        fetchImpl,
        timeoutMs: timeout,
      });
    }

    case 'anthropic': {
      if (!apiKey.trim()) {
        return { ok: false, category: 'unauthorized', detail: scrub('API key is required') };
      }
      const anthropicModel = modelId.trim() || 'claude-3-5-sonnet-20241022';
      let endpoint = 'https://api.anthropic.com/v1/messages';
      if (baseUrl.trim().length > 0) {
        const normalized = normalizeBaseUrl(baseUrl.trim());
        if (normalized.ok) {
          endpoint = normalized.url.endsWith('/messages')
            ? normalized.url
            : `${normalized.url}/messages`;
        }
      }
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey.trim(),
        'anthropic-version': '2023-06-01',
      };
      const body = JSON.stringify({
        model: anthropicModel,
        messages: [{ role: 'user', content: PROBE_CONTENT }],
        max_tokens: 1,
      });
      const startedAt = Date.now();
      try {
        const response = await fetchWithTimeout(
          endpoint,
          { method: 'POST', headers, body },
          { timeoutMs: timeout, kind: 'non-streaming', fetchImpl },
        );
        const latencyMs = Math.max(0, Date.now() - startedAt);
        if (!response.ok) {
          return {
            ok: false,
            category: categorizeStatus(response.status),
            status: response.status,
            detail: scrub(`HTTP ${response.status}`),
          };
        }
        return { ok: true, latencyMs, modelEcho: anthropicModel };
      } catch (err) {
        if (isAbortError(err)) {
          return { ok: false, category: 'timeout', detail: scrub(`Timed out after ${timeout} ms`) };
        }
        return { ok: false, category: 'network', detail: scrub('Network request failed') };
      }
    }

    case 'ollama': {
      const rawUrl = baseUrl.trim() || 'http://localhost:11434';
      const base = normalizeBaseUrl(rawUrl);
      if (!base.ok) {
        return { ok: false, category: 'invalid-url', detail: scrub(BASE_URL_DETAIL[base.reason]) };
      }
      const endpoint = `${base.url.replace(/\/v1\/?$/, '')}/api/tags`;
      const startedAt = Date.now();
      try {
        const response = await fetchWithTimeout(
          endpoint,
          { method: 'GET' },
          { timeoutMs: timeout, kind: 'non-streaming', fetchImpl },
        );
        const latencyMs = Math.max(0, Date.now() - startedAt);
        if (!response.ok) {
          return {
            ok: false,
            category: categorizeStatus(response.status),
            status: response.status,
            detail: scrub(`HTTP ${response.status}`),
          };
        }
        return { ok: true, latencyMs };
      } catch (err) {
        if (isAbortError(err)) {
          return { ok: false, category: 'timeout', detail: scrub(`Timed out after ${timeout} ms`) };
        }
        return { ok: false, category: 'network', detail: scrub('Could not connect to Ollama server') };
      }
    }

    case 'custom':
    default: {
      return testCustomProviderConnection({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        modelId: modelId.trim(),
        fetchImpl,
        timeoutMs: timeout,
      });
    }
  }
}

