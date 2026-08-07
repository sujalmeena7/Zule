// ============================================
// Zule AI — Connection_Test example tests
// ============================================
//
// Example (non-property) tests for the Custom_Provider configuration probe.
// Two things are pinned here:
//
//   1. **Failure classification is total and correct.** Every canned outcome a
//      gateway can produce maps to exactly one `ConnectionTestFailure`
//      category, and the probe never throws — it always returns a result.
//   2. **The credential never reaches the URL.** The probe URL's path, query
//      string, and fragment exclude the API_Key; the key travels only in the
//      `Authorization: Bearer` header, and no `detail` string echoes it
//      (Requirements 3.3, 3.9).
//
// All cases use an injected `fetchImpl` spy — zero real network traffic.

import { describe, expect, it, vi } from 'vitest';

import { testCustomProviderConnection, testProviderConnection } from './connectionTest';


const BASE_URL = 'https://gateway.example.com/api/v1';
const MODEL_ID = 'meta-llama/llama-3.1-8b-instruct';
/** ≥ 8 characters so `scrubSecret` is active for this key. */
const API_KEY = 'sk-connection-test-secret-0123456789';

interface FetchCall {
  input: RequestInfo | URL;
  init: RequestInit | undefined;
}

function makeRecordingFetch(responder: (init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return responder(init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** A fetch that never resolves until its signal aborts — exercises the real timeout path. */
function makeHangingFetch() {
  const impl = vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        });
      }),
  ) as unknown as typeof fetch;
  return { impl };
}

function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.[name];
}

describe('testCustomProviderConnection — failure classification', () => {
  const statusCases: Array<[number, string]> = [
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not-found'],
    [429, 'rate-limited'],
    [500, 'server-error'],
  ];

  for (const [status, category] of statusCases) {
    it(`maps HTTP ${status} to ${category}`, async () => {
      // A gateway echoing the Authorization header back in the error body is the
      // exact hazard `detail` is built to avoid.
      const { impl, calls } = makeRecordingFetch(
        () => new Response(`denied for Bearer ${API_KEY}`, { status }),
      );

      const result = await testCustomProviderConnection({
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        modelId: MODEL_ID,
        fetchImpl: impl,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe(category);
      expect(result.status).toBe(status);
      expect(result.detail).toBe(`HTTP ${status}`);
      expect(result.detail).not.toContain(API_KEY);
      expect(calls).toHaveLength(1);
    });
  }

  it('maps a transport-level throw to network', async () => {
    const impl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    const result = await testCustomProviderConnection({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      modelId: MODEL_ID,
      fetchImpl: impl,
    });

    expect(result).toEqual({
      ok: false,
      category: 'network',
      detail: 'Network request failed',
    });
  });

  it('maps an elapsed per-request timeout to timeout', async () => {
    const { impl } = makeHangingFetch();

    const result = await testCustomProviderConnection({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      modelId: MODEL_ID,
      fetchImpl: impl,
      timeoutMs: 10,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.category).toBe('timeout');
    expect(result.detail).toBe('Timed out after 10 ms');
  });

  it('maps a non-JSON 200 body to bad-response', async () => {
    const { impl } = makeRecordingFetch(
      () => new Response('<html>gateway landing page</html>', { status: 200 }),
    );

    const result = await testCustomProviderConnection({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      modelId: MODEL_ID,
      fetchImpl: impl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.category).toBe('bad-response');
    expect(result.status).toBe(200);
    expect(result.detail).toBe('Response body was not valid JSON');
  });

  it('maps an invalid Base_URL to invalid-url with zero requests', async () => {
    const { impl, calls } = makeRecordingFetch(() => new Response('{}', { status: 200 }));

    const result = await testCustomProviderConnection({
      baseUrl: 'ftp://gateway.example.com/v1',
      apiKey: API_KEY,
      modelId: MODEL_ID,
      fetchImpl: impl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.category).toBe('invalid-url');
    expect(result.detail).toBe('Base URL must use http or https');
    expect(calls).toHaveLength(0);
  });

  it('maps a blank Model_ID to missing-model with zero requests', async () => {
    const { impl, calls } = makeRecordingFetch(() => new Response('{}', { status: 200 }));

    const result = await testCustomProviderConnection({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      modelId: '   \t\n ',
      fetchImpl: impl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.category).toBe('missing-model');
    expect(result.detail).toBe('Model ID is required');
    expect(calls).toHaveLength(0);
  });
});

describe('testCustomProviderConnection — credential placement (Requirement 3.3)', () => {
  it('excludes the API_Key from the probe URL path, query string, and fragment', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      new Response(JSON.stringify({ model: MODEL_ID, choices: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await testCustomProviderConnection({
      // Trailing slashes are normalised away by the Endpoint_Validator.
      baseUrl: `${BASE_URL}//`,
      apiKey: API_KEY,
      modelId: MODEL_ID,
      fetchImpl: impl,
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);

    const url = new URL(String(calls[0].input));
    expect(url.href).toBe(`${BASE_URL}/chat/completions`);
    expect(url.pathname).not.toContain(API_KEY);
    expect(url.search).toBe('');
    expect(url.search).not.toContain(API_KEY);
    expect(url.hash).toBe('');
    expect(url.hash).not.toContain(API_KEY);
    expect(url.href).not.toContain(API_KEY);

    // The credential travels only in the Authorization header.
    expect(headerValue(calls[0].init, 'Authorization')).toBe(`Bearer ${API_KEY}`);
    expect(String(calls[0].init?.body)).not.toContain(API_KEY);
  });

  it('omits the Authorization header entirely when no API_Key is configured', async () => {
    const { impl, calls } = makeRecordingFetch(() => new Response('{}', { status: 200 }));

    await testCustomProviderConnection({
      baseUrl: BASE_URL,
      apiKey: '   ',
      modelId: MODEL_ID,
      fetchImpl: impl,
    });

    expect(calls).toHaveLength(1);
    expect(String(calls[0].input)).toBe(`${BASE_URL}/chat/completions`);
    expect(headerValue(calls[0].init, 'Authorization')).toBeUndefined();
  });
});

describe('testProviderConnection — multi-provider dispatcher', () => {
  it('tests Gemini connection with x-goog-api-key header', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'pong' }] } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await testProviderConnection({
      providerId: 'gemini',
      apiKey: API_KEY,
      fetchImpl: impl,
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(String(calls[0].input)).toContain('generativelanguage.googleapis.com');
    expect(headerValue(calls[0].init, 'x-goog-api-key')).toBe(API_KEY);
  });

  it('rejects Gemini when API key is empty', async () => {
    const result = await testProviderConnection({
      providerId: 'gemini',
      apiKey: '   ',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.category).toBe('unauthorized');
    }
  });

  it('tests OpenAI connection', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      new Response(JSON.stringify({ model: 'gpt-4o-mini', choices: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await testProviderConnection({
      providerId: 'openai',
      apiKey: API_KEY,
      fetchImpl: impl,
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(String(calls[0].input)).toBe('https://api.openai.com/v1/chat/completions');
    expect(headerValue(calls[0].init, 'Authorization')).toBe(`Bearer ${API_KEY}`);
  });

  it('tests Anthropic connection with x-api-key and anthropic-version headers', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      new Response(JSON.stringify({ id: 'msg_123', type: 'message', content: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await testProviderConnection({
      providerId: 'anthropic',
      apiKey: API_KEY,
      fetchImpl: impl,
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(String(calls[0].input)).toBe('https://api.anthropic.com/v1/messages');
    expect(headerValue(calls[0].init, 'x-api-key')).toBe(API_KEY);
    expect(headerValue(calls[0].init, 'anthropic-version')).toBe('2023-06-01');
  });

  it('tests Ollama connection via GET /api/tags', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await testProviderConnection({
      providerId: 'ollama',
      baseUrl: 'http://localhost:11434',
      fetchImpl: impl,
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(String(calls[0].input)).toBe('http://localhost:11434/api/tags');
  });
});

