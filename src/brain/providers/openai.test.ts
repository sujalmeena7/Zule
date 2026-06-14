// ============================================
// Tests for OpenAIAdapter
// ============================================
//
// These tests exercise the adapter's contract with a mocked `fetch`
// impl. Property 11 (API keys never appear in URLs) gets its own
// dedicated property test in task 8.8 across all providers; here we
// assert the example-level invariant for OpenAI specifically alongside
// the streaming and error-path checks.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenAIAdapter } from './openai';
import type {
  CallOpts,
  PromptInput,
  ProviderHttpError,
  StreamCallbacks,
} from './types';

// --- Helpers -------------------------------------------------------------

const TEST_API_KEY = 'sk-test-openai-not-a-real-key';

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
function makeJsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

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

describe('OpenAIAdapter — construction', () => {
  it('rejects an empty API key', () => {
    expect(() => new OpenAIAdapter({ apiKey: '' })).toThrow();
    expect(() => new OpenAIAdapter({ apiKey: '   ' })).toThrow();
  });

  it('exposes streaming/imageInput/toolUse capabilities by default', () => {
    const a = new OpenAIAdapter({ apiKey: TEST_API_KEY });
    expect(a.name).toBe('openai');
    expect(a.capabilities.streaming).toBe(true);
    expect(a.capabilities.imageInput).toBe(true);
    expect(a.capabilities.toolUse).toBe(true);
    expect(a.capabilities.maxInputTokens).toBe(128_000);
    expect(a.capabilities.pricePerMTokens).toEqual({ input: 0.15, output: 0.6 });
  });
});

// --- countTokens ---------------------------------------------------------

describe('OpenAIAdapter.countTokens', () => {
  const adapter = new OpenAIAdapter({ apiKey: TEST_API_KEY });

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

describe('OpenAIAdapter — header-based authentication (Requirement 4.6)', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('passes the API key in `Authorization: Bearer` and never in the URL — complete()', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({
        choices: [{ message: { role: 'assistant', content: 'four' } }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }),
    );
    const adapter = new OpenAIAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    const res = await adapter.complete(PROMPT, NO_OPTS);

    expect(res.text).toBe('four');
    expect(res.providerId).toBe('openai');
    expect(res.modelId).toBe('gpt-4o-mini');
    expect(res.isSimulated).toBe(false);
    expect(res.status).toBe(200);
    expect(res.promptTokens).toBe(12);
    expect(res.completionTokens).toBe(3);

    expect(calls).toHaveLength(1);
    const url = String(calls[0].input);
    expect(url).not.toContain(TEST_API_KEY);
    expect(url).not.toContain('key=');
    expect(url).toContain('/chat/completions');

    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${TEST_API_KEY}`);
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('passes the API key in `Authorization: Bearer` and never in the URL — streamGenerate()', async () => {
    const sse =
      'data: {"choices":[{"delta":{"role":"assistant","content":"Hi"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":" there"}}]}\n\n' +
      'data: [DONE]\n\n';
    const { impl, calls } = makeRecordingFetch(() => makeStreamResponse([sse]));
    const adapter = new OpenAIAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    const { cb } = makeStreamCallbacks();
    await adapter.streamGenerate(PROMPT, cb, NO_OPTS);

    expect(calls).toHaveLength(1);
    const url = String(calls[0].input);
    expect(url).not.toContain(TEST_API_KEY);
    expect(url).not.toContain('key=');
    expect(url).toContain('/chat/completions');

    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${TEST_API_KEY}`);
  });

  it('forwards the OpenAI-Organization header when supplied', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }),
    );
    const adapter = new OpenAIAdapter({
      apiKey: TEST_API_KEY,
      organization: 'org-123',
      fetchImpl: impl,
    });

    await adapter.complete(PROMPT, NO_OPTS);

    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('openai-organization')).toBe('org-123');
  });

  it('selects the model id supplied in opts.modelId via the request body', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    const adapter = new OpenAIAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    await adapter.complete(PROMPT, { modelId: 'gpt-4o' });

    // Model id rides the body, not the URL — the URL is constant.
    const url = String(calls[0].input);
    expect(url).toContain('/chat/completions');
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.model).toBe('gpt-4o');
  });
});

// --- Streaming -----------------------------------------------------------

describe('OpenAIAdapter.streamGenerate', () => {
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
      'data: {"choices":[{"delta":{"role":"assistant","content":"Hello"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":" "}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"world"}}],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n' +
      'data: [DONE]\n\n';
    const { impl } = makeRecordingFetch(() => makeStreamResponse([sse]));
    const adapter = new OpenAIAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    const { cb, tokens, errors, result } = makeStreamCallbacks();
    await adapter.streamGenerate(PROMPT, cb, NO_OPTS);

    expect(errors).toHaveLength(0);
    expect(tokens).toEqual(['Hello', 'Hello ', 'Hello world']);
    expect(result.value).not.toBeNull();
    expect(result.value?.text).toBe('Hello world');
    expect(result.value?.providerId).toBe('openai');
    expect(result.value?.modelId).toBe('gpt-4o-mini');
    expect(result.value?.isSimulated).toBe(false);
    expect(result.value?.status).toBe(200);
    expect(result.value?.promptTokens).toBe(7);
    expect(result.value?.completionTokens).toBe(3);
  });

  it('survives chunk boundaries that fall mid-frame', async () => {
    const frame =
      'data: {"choices":[{"delta":{"content":"split"}}]}\n\n' +
      'data: [DONE]\n\n';
    const cut = 25; // arbitrary mid-frame split
    const { impl } = makeRecordingFetch(() =>
      makeStreamResponse([frame.slice(0, cut), frame.slice(cut)]),
    );
    const adapter = new OpenAIAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    const { cb, tokens, errors, result } = makeStreamCallbacks();
    await adapter.streamGenerate(PROMPT, cb, NO_OPTS);

    expect(errors).toHaveLength(0);
    expect(tokens).toEqual(['split']);
    expect(result.value?.text).toBe('split');
  });

  it('does not invoke onComplete when caller pre-aborts the signal', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"ignored"}}]}\n\n' +
      'data: [DONE]\n\n';
    const { impl } = makeRecordingFetch(() => makeStreamResponse([sse]));
    const adapter = new OpenAIAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    const controller = new AbortController();
    controller.abort();

    const { cb, result } = makeStreamCallbacks();
    await adapter
      .streamGenerate(PROMPT, cb, { signal: controller.signal })
      .catch(() => {});

    expect(result.value).toBeNull();
  });

  it('falls back to the local estimator when the response omits usage', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"abcd"}}]}\n\n' +
      'data: [DONE]\n\n';
    const { impl } = makeRecordingFetch(() => makeStreamResponse([sse]));
    const adapter = new OpenAIAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    const { cb, result } = makeStreamCallbacks();
    await adapter.streamGenerate(PROMPT, cb, NO_OPTS);

    // 'abcd' is 4 chars → 1 token via the ~4 chars/token estimator.
    expect(result.value?.completionTokens).toBe(1);
    expect(result.value?.promptTokens).toBe(adapter.countTokens(PROMPT.fullPrompt));
  });

  it('ignores the [DONE] sentinel without emitting an error', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
      'data: [DONE]\n\n';
    const { impl } = makeRecordingFetch(() => makeStreamResponse([sse]));
    const adapter = new OpenAIAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    const { cb, errors, result } = makeStreamCallbacks();
    await adapter.streamGenerate(PROMPT, cb, NO_OPTS);

    expect(errors).toHaveLength(0);
    expect(result.value?.text).toBe('ok');
  });
});

// --- Error / retry classification ---------------------------------------

describe('OpenAIAdapter — error classification', () => {
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
      makeJsonResponse({ error: { message: 'invalid api key' } }, 401),
    );
    const adapter = new OpenAIAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    let caught: ProviderHttpError | null = null;
    try {
      await adapter.complete(PROMPT, NO_OPTS);
    } catch (err) {
      caught = err as ProviderHttpError;
    }

    expect(caught).not.toBeNull();
    expect(caught?.status).toBe(401);
    expect(caught?.providerId).toBe('openai');
    expect(calls).toHaveLength(1);
  });

  it('retries on 429 and recovers on a follow-up 200', async () => {
    let attempts = 0;
    const responder = () => {
      attempts++;
      if (attempts < 2) {
        return makeJsonResponse({ error: 'rate limited' }, 429, {
          'retry-after': '0',
        });
      }
      return makeJsonResponse({
        choices: [{ message: { content: 'recovered' } }],
      });
    };
    const { impl } = makeRecordingFetch(responder);
    const adapter = new OpenAIAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    const res = await adapter.complete(PROMPT, NO_OPTS);
    expect(res.text).toBe('recovered');
    expect(attempts).toBe(2);
  }, 15_000);
});

// --- Request body shape -------------------------------------------------

describe('OpenAIAdapter — request body shape', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('builds a system + user message envelope for chat completions', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    const adapter = new OpenAIAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    await adapter.complete(PROMPT, { temperature: 0.3, maxOutputTokens: 128 });

    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(128);
    expect(body.messages).toEqual([
      { role: 'system', content: PROMPT.systemPrompt },
      { role: 'user', content: PROMPT.fullPrompt },
    ]);
  });

  it('switches to multi-modal user content when prompt.images is set', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    const adapter = new OpenAIAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    await adapter.complete(
      {
        ...PROMPT,
        images: [{ mimeType: 'image/png', base64: 'iVBORw0KGgo=' }],
      },
      NO_OPTS,
    );

    const body = JSON.parse(String(calls[0].init?.body));
    const userMsg = body.messages.find((m: { role: string }) => m.role === 'user');
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content[0]).toEqual({ type: 'text', text: PROMPT.fullPrompt });
    expect(userMsg.content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
    });
  });

  it('uses max_completion_tokens and omits temperature for o-series models', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    const adapter = new OpenAIAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    await adapter.complete(PROMPT, {
      modelId: 'o1-mini',
      temperature: 0.5,
      maxOutputTokens: 256,
    });

    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.model).toBe('o1-mini');
    expect(body.max_completion_tokens).toBe(256);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
    expect(body.stream).toBe(false);
  });

  it('sets stream:true on streamGenerate requests', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n' + 'data: [DONE]\n\n';
    const { impl, calls } = makeRecordingFetch(() => makeStreamResponse([sse]));
    const adapter = new OpenAIAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    const { cb } = makeStreamCallbacks();
    await adapter.streamGenerate(PROMPT, cb, NO_OPTS);

    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.stream).toBe(true);
  });
});
