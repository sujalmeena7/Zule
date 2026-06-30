// ============================================
// Tests for GeminiAdapter
// ============================================
//
// These tests exercise the adapter's contract with a mocked `fetch` impl.
// Property 11 (API keys never appear in URLs) gets its own dedicated
// property test in task 8.8 across all providers; here we assert the
// example-level invariant for Gemini specifically alongside the streaming
// and error-path checks.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GeminiAdapter } from './gemini';
import type {
  CallOpts,
  PromptInput,
  ProviderHttpError,
  StreamCallbacks,
} from './types';

// --- Helpers -------------------------------------------------------------

const TEST_API_KEY = 'sk-test-abc123-not-a-real-key';

const PROMPT: PromptInput = {
  systemPrompt: 'You are a helpful assistant.',
  userText: 'What is 2 + 2?',
  fullPrompt: 'You are a helpful assistant.\n\nWhat is 2 + 2?',
};

/** Builds a `Response` whose body streams the given chunks then closes. */
function makeStreamResponse(chunks: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(enc.encode(chunk));
        // Yield to the microtask queue so the consumer's first read()
        // observes the boundary between chunks (relevant for the
        // chunk-boundary regression check).
        await new Promise((r) => setTimeout(r, 0));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** Builds a non-streaming JSON response. */
function makeJsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

/** Captures all fetch calls so tests can inspect URLs and headers. */
interface FetchCall {
  input: RequestInfo | URL;
  init: RequestInit | undefined;
}

function makeRecordingFetch(
  responder: (call: FetchCall, attempt: number) => Response | Promise<Response>,
) {
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = { input, init };
    calls.push(call);
    return responder(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

type StreamRecorder = {
  cb: StreamCallbacks;
  tokens: string[];
  errors: Error[];
  /** Box object so the latest value is observable without re-fetching from a getter. */
  result: { value: Parameters<StreamCallbacks['onComplete']>[0] | null };
};

function makeStreamCallbacks(): StreamRecorder {
  const tokens: string[] = [];
  const errors: Error[] = [];
  const result: StreamRecorder['result'] = { value: null };
  const cb: StreamCallbacks = {
    onToken: (t) => {
      tokens.push(t);
    },
    onComplete: (r) => {
      result.value = r;
    },
    onError: (e) => {
      errors.push(e);
    },
  };
  return { cb, tokens, errors, result };
}

const NO_OPTS: CallOpts = {};

// --- Construction --------------------------------------------------------

describe('GeminiAdapter — construction', () => {
  it('rejects an empty API key', () => {
    expect(() => new GeminiAdapter({ apiKey: '' })).toThrow();
    expect(() => new GeminiAdapter({ apiKey: '   ' })).toThrow();
  });

  it('exposes streaming/imageInput capabilities by default', () => {
    const a = new GeminiAdapter({ apiKey: TEST_API_KEY });
    expect(a.name).toBe('gemini');
    expect(a.capabilities.streaming).toBe(true);
    expect(a.capabilities.imageInput).toBe(true);
    expect(a.capabilities.toolUse).toBe(false);
    expect(a.capabilities.maxInputTokens).toBeGreaterThan(0);
  });
});

// --- countTokens ---------------------------------------------------------

describe('GeminiAdapter.countTokens', () => {
  const adapter = new GeminiAdapter({ apiKey: TEST_API_KEY });

  it('returns 0 for empty input', () => {
    expect(adapter.countTokens('')).toBe(0);
  });

  it('approximates ~4 chars/token (ceiling)', () => {
    expect(adapter.countTokens('1234')).toBe(1);
    expect(adapter.countTokens('12345')).toBe(2);
    expect(adapter.countTokens('a'.repeat(1000))).toBe(250);
  });
});

// --- Auth: header, never URL --------------------------------------------

describe('GeminiAdapter — header-based authentication (Requirement 4.6)', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('passes the API key in `x-goog-api-key` and never in the URL — complete()', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({
        candidates: [{ content: { parts: [{ text: 'four' }] } }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 },
      }),
    );
    const adapter = new GeminiAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    const res = await adapter.complete(PROMPT, NO_OPTS);

    expect(res.text).toBe('four');
    expect(res.providerId).toBe('gemini');
    expect(res.isSimulated).toBe(false);
    expect(res.status).toBe(200);
    expect(res.promptTokens).toBe(12);
    expect(res.completionTokens).toBe(3);

    expect(calls).toHaveLength(1);
    const url = String(calls[0].input);
    expect(url).not.toContain(TEST_API_KEY);
    expect(url).not.toContain('key=');
    expect(url).toContain(':generateContent');

    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('x-goog-api-key')).toBe(TEST_API_KEY);
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('passes the API key in `x-goog-api-key` and never in the URL — streamGenerate()', async () => {
    const sse =
      'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}\n\n' +
      'data: {"candidates":[{"content":{"parts":[{"text":" there"}]}}]}\n\n';
    const { impl, calls } = makeRecordingFetch(() => makeStreamResponse([sse]));
    const adapter = new GeminiAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    const { cb } = makeStreamCallbacks();
    await adapter.streamGenerate(PROMPT, cb, NO_OPTS);

    expect(calls).toHaveLength(1);
    const url = String(calls[0].input);
    expect(url).not.toContain(TEST_API_KEY);
    expect(url).not.toContain('key=');
    expect(url).toContain(':streamGenerateContent');
    expect(url).toContain('alt=sse');

    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('x-goog-api-key')).toBe(TEST_API_KEY);
  });

  it('selects the model id supplied in opts.modelId', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    );
    const adapter = new GeminiAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    await adapter.complete(PROMPT, { modelId: 'gemini-1.5-pro' });

    const url = String(calls[0].input);
    expect(url).toContain('gemini-1.5-pro');
    expect(url).not.toContain('gemini-1.5-flash');
  });
});

// --- Streaming -----------------------------------------------------------

describe('GeminiAdapter.streamGenerate', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('parses SSE frames, calls onToken with cumulative text, and onComplete once', async () => {
    const sse =
      'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n' +
      'data: {"candidates":[{"content":{"parts":[{"text":" "}]}}]}\n\n' +
      'data: {"candidates":[{"content":{"parts":[{"text":"world"}]}}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3}}\n\n';
    const { impl } = makeRecordingFetch(() => makeStreamResponse([sse]));
    const adapter = new GeminiAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    const { cb, tokens, errors, result } = makeStreamCallbacks();
    await adapter.streamGenerate(PROMPT, cb, NO_OPTS);

    expect(errors).toHaveLength(0);
    expect(tokens).toEqual(['Hello', 'Hello ', 'Hello world']);
    expect(result.value).not.toBeNull();
    expect(result.value?.text).toBe('Hello world');
    expect(result.value?.providerId).toBe('gemini');
    expect(result.value?.modelId).toBe('gemini-2.0-flash');
    expect(result.value?.isSimulated).toBe(false);
    expect(result.value?.status).toBe(200);
    expect(result.value?.promptTokens).toBe(7);
    expect(result.value?.completionTokens).toBe(3);
  });

  it('survives chunk boundaries that fall mid-frame', async () => {
    // Single frame, but emitted as two chunks split mid-`data:` line.
    const frame =
      'data: {"candidates":[{"content":{"parts":[{"text":"split"}]}}]}\n\n';
    const cut = 25; // arbitrary mid-frame split
    const { impl } = makeRecordingFetch(() =>
      makeStreamResponse([frame.slice(0, cut), frame.slice(cut)]),
    );
    const adapter = new GeminiAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    const { cb, tokens, errors, result } = makeStreamCallbacks();
    await adapter.streamGenerate(PROMPT, cb, NO_OPTS);

    expect(errors).toHaveLength(0);
    expect(tokens).toEqual(['split']);
    expect(result.value?.text).toBe('split');
  });

  it('does not invoke onComplete when caller pre-aborts the signal', async () => {
    const sse = 'data: {"candidates":[{"content":{"parts":[{"text":"ignored"}]}}]}\n\n';
    const { impl } = makeRecordingFetch(() => makeStreamResponse([sse]));
    const adapter = new GeminiAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    const controller = new AbortController();
    controller.abort();

    const { cb, tokens, errors, result } = makeStreamCallbacks();
    // The fetch may reject because the signal is already aborted; that's
    // a legal termination per Requirement 4.7. Either way, onComplete must
    // not fire.
    await adapter
      .streamGenerate(PROMPT, cb, { signal: controller.signal })
      .catch(() => {});

    expect(result.value).toBeNull();
    // Either no tokens emitted, or any partial tokens are tolerated; the
    // strict invariant is just "no onComplete after abort".
    void tokens;
    void errors;
  });

  it('falls back to the local estimator when the response omits usageMetadata', async () => {
    const sse = 'data: {"candidates":[{"content":{"parts":[{"text":"abcd"}]}}]}\n\n';
    const { impl } = makeRecordingFetch(() => makeStreamResponse([sse]));
    const adapter = new GeminiAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    const { cb, result } = makeStreamCallbacks();
    await adapter.streamGenerate(PROMPT, cb, NO_OPTS);

    // 'abcd' is 4 chars → 1 token via the ~4 chars/token estimator.
    expect(result.value?.completionTokens).toBe(1);
    // Prompt token count uses the local estimator over fullPrompt.
    expect(result.value?.promptTokens).toBe(adapter.countTokens(PROMPT.fullPrompt));
  });
});

// --- Error / retry classification ---------------------------------------

describe('GeminiAdapter — error classification', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('does not retry on 4xx (non-429) and surfaces a ProviderHttpError with status', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ error: 'bad request' }, 400),
    );
    const adapter = new GeminiAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    let caught: ProviderHttpError | null = null;
    try {
      await adapter.complete(PROMPT, NO_OPTS);
    } catch (err) {
      caught = err as ProviderHttpError;
    }

    expect(caught).not.toBeNull();
    expect(caught?.status).toBe(400);
    expect(caught?.providerId).toBe('gemini');
    // Only one fetch attempt: the default retry classifier excludes 4xx.
    expect(calls).toHaveLength(1);
  });

  it('retries on 503 and eventually throws after the attempt budget is exhausted', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ error: 'unavailable' }, 503, { 'retry-after': '0' }),
    );
    const adapter = new GeminiAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    let caught: ProviderHttpError | null = null;
    try {
      await adapter.complete(PROMPT, NO_OPTS);
    } catch (err) {
      caught = err as ProviderHttpError;
    }

    expect(caught).not.toBeNull();
    expect(caught?.status).toBe(503);
    // The default RETRY_MAX_ATTEMPTS is 3 (initial + 2 retries).
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.length).toBeLessThanOrEqual(3);
  }, 15_000);

  it('retries on transport-level TypeError (fetch rejects)', async () => {
    let attempts = 0;
    const responder = () => {
      attempts++;
      if (attempts < 2) {
        // Simulate a fetch transport failure on the first attempt.
        throw new TypeError('Failed to fetch');
      }
      return makeJsonResponse({
        candidates: [{ content: { parts: [{ text: 'recovered' }] } }],
      });
    };
    const { impl } = makeRecordingFetch(responder);
    const adapter = new GeminiAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    const res = await adapter.complete(PROMPT, NO_OPTS);
    expect(res.text).toBe('recovered');
    expect(attempts).toBe(2);
  }, 15_000);

  it('propagates the non-2xx body excerpt in the error message', async () => {
    const { impl } = makeRecordingFetch(() =>
      makeJsonResponse({ error: { message: 'invalid api key' } }, 401),
    );
    const adapter = new GeminiAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    await expect(adapter.complete(PROMPT, NO_OPTS)).rejects.toThrow(/401/);
  });
});

// --- Request body shape -------------------------------------------------

describe('GeminiAdapter — request body shape', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('includes systemInstruction when prompt.systemPrompt is set', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    );
    const adapter = new GeminiAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    await adapter.complete(PROMPT, { temperature: 0.3, maxOutputTokens: 128 });

    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.contents[0].role).toBe('user');
    expect(body.contents[0].parts[0].text).toBe(PROMPT.fullPrompt);
    expect(body.systemInstruction).toEqual({
      parts: [{ text: PROMPT.systemPrompt }],
    });
    expect(body.generationConfig.temperature).toBe(0.3);
    expect(body.generationConfig.maxOutputTokens).toBe(128);
  });

  it('appends inlineData parts when prompt.images is set', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    );
    const adapter = new GeminiAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    await adapter.complete(
      {
        ...PROMPT,
        images: [{ mimeType: 'image/png', base64: 'iVBORw0KGgo=' }],
      },
      NO_OPTS,
    );

    const body = JSON.parse(String(calls[0].init?.body));
    const parts = body.contents[0].parts;
    expect(parts).toHaveLength(2);
    expect(parts[1]).toEqual({
      inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' },
    });
  });
});
