// ============================================
// Tests for AnthropicAdapter
// ============================================
//
// These tests exercise the adapter's contract with a mocked `fetch` impl.
// Property 11 (API keys never appear in URLs) gets its own dedicated
// property test in task 8.8 across all providers; here we assert the
// example-level invariant for Anthropic specifically alongside the
// streaming, error-path, and request-shape checks.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnthropicAdapter } from './anthropic';
import type {
  CallOpts,
  PromptInput,
  ProviderHttpError,
  StreamCallbacks,
} from './types';

// --- Helpers -------------------------------------------------------------

const TEST_API_KEY = 'sk-ant-test-abc123-not-a-real-key';

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

describe('AnthropicAdapter — construction', () => {
  it('rejects an empty API key', () => {
    expect(() => new AnthropicAdapter({ apiKey: '' })).toThrow();
    expect(() => new AnthropicAdapter({ apiKey: '   ' })).toThrow();
  });

  it('exposes streaming/imageInput/toolUse capabilities by default', () => {
    const a = new AnthropicAdapter({ apiKey: TEST_API_KEY });
    expect(a.name).toBe('anthropic');
    expect(a.capabilities.streaming).toBe(true);
    expect(a.capabilities.imageInput).toBe(true);
    expect(a.capabilities.toolUse).toBe(true);
    expect(a.capabilities.maxInputTokens).toBe(200_000);
    expect(a.capabilities.pricePerMTokens).toEqual({ input: 3.0, output: 15.0 });
  });
});

// --- countTokens ---------------------------------------------------------

describe('AnthropicAdapter.countTokens', () => {
  const adapter = new AnthropicAdapter({ apiKey: TEST_API_KEY });

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

describe('AnthropicAdapter — header-based authentication (Requirement 4.6)', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('passes the API key in `x-api-key` and never in the URL — complete()', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({
        content: [{ type: 'text', text: 'four' }],
        usage: { input_tokens: 12, output_tokens: 3 },
      }),
    );
    const adapter = new AnthropicAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    const res = await adapter.complete(PROMPT, NO_OPTS);

    expect(res.text).toBe('four');
    expect(res.providerId).toBe('anthropic');
    expect(res.isSimulated).toBe(false);
    expect(res.status).toBe(200);
    expect(res.promptTokens).toBe(12);
    expect(res.completionTokens).toBe(3);
    expect(res.modelId).toBe('claude-3-5-sonnet-20241022');

    expect(calls).toHaveLength(1);
    const url = String(calls[0].input);
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(url).not.toContain(TEST_API_KEY);
    expect(url).not.toContain('key=');

    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('x-api-key')).toBe(TEST_API_KEY);
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(headers.get('content-type')).toBe('application/json');
    // Never set Authorization — Anthropic uses x-api-key.
    expect(headers.get('authorization')).toBeNull();
  });

  it('passes the API key in `x-api-key` and never in the URL — streamGenerate()', async () => {
    const sse =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":0}}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';
    const { impl, calls } = makeRecordingFetch(() => makeStreamResponse([sse]));
    const adapter = new AnthropicAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    const { cb } = makeStreamCallbacks();
    await adapter.streamGenerate(PROMPT, cb, NO_OPTS);

    expect(calls).toHaveLength(1);
    const url = String(calls[0].input);
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(url).not.toContain(TEST_API_KEY);
    expect(url).not.toContain('key=');

    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('x-api-key')).toBe(TEST_API_KEY);
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
  });

  it('selects the model id supplied in opts.modelId', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
    );
    const adapter = new AnthropicAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    const res = await adapter.complete(PROMPT, { modelId: 'claude-3-opus-20240229' });

    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.model).toBe('claude-3-opus-20240229');
    expect(res.modelId).toBe('claude-3-opus-20240229');
  });
});

// --- Streaming -----------------------------------------------------------

describe('AnthropicAdapter.streamGenerate', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('accumulates content_block_delta text and finalises on message_stop', async () => {
    const sse =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":0}}}\n\n' +
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" "}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}\n\n' +
      'event: content_block_stop\n' +
      'data: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_delta\n' +
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';
    const { impl } = makeRecordingFetch(() => makeStreamResponse([sse]));
    const adapter = new AnthropicAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    const { cb, tokens, errors, result } = makeStreamCallbacks();
    await adapter.streamGenerate(PROMPT, cb, NO_OPTS);

    expect(errors).toHaveLength(0);
    expect(tokens).toEqual(['Hello', 'Hello ', 'Hello world']);
    expect(result.value).not.toBeNull();
    expect(result.value?.text).toBe('Hello world');
    expect(result.value?.providerId).toBe('anthropic');
    expect(result.value?.modelId).toBe('claude-3-5-sonnet-20241022');
    expect(result.value?.isSimulated).toBe(false);
    expect(result.value?.status).toBe(200);
    expect(result.value?.promptTokens).toBe(7);
    expect(result.value?.completionTokens).toBe(3);
  });

  it('ignores non-text_delta content_block_delta frames', async () => {
    // Anthropic emits `input_json_delta` for tool-use blocks; those must
    // NOT be appended to the visible text stream.
    const sse =
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"visible"}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"x\\":1}"}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';
    const { impl } = makeRecordingFetch(() => makeStreamResponse([sse]));
    const adapter = new AnthropicAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    const { cb, tokens, result } = makeStreamCallbacks();
    await adapter.streamGenerate(PROMPT, cb, NO_OPTS);

    expect(tokens).toEqual(['visible']);
    expect(result.value?.text).toBe('visible');
  });

  it('survives chunk boundaries that fall mid-frame', async () => {
    const frame =
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"split"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const cut = 35; // arbitrary mid-frame split
    const { impl } = makeRecordingFetch(() =>
      makeStreamResponse([frame.slice(0, cut), frame.slice(cut)]),
    );
    const adapter = new AnthropicAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    const { cb, tokens, errors, result } = makeStreamCallbacks();
    await adapter.streamGenerate(PROMPT, cb, NO_OPTS);

    expect(errors).toHaveLength(0);
    expect(tokens).toEqual(['split']);
    expect(result.value?.text).toBe('split');
  });

  it('does not invoke onComplete when caller pre-aborts the signal', async () => {
    const sse =
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ignored"}}\n\n';
    const { impl } = makeRecordingFetch(() => makeStreamResponse([sse]));
    const adapter = new AnthropicAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    const controller = new AbortController();
    controller.abort();

    const { cb, result } = makeStreamCallbacks();
    // The fetch may reject because the signal is already aborted; that
    // is a legal termination per Requirement 4.7. Either way,
    // onComplete must not fire.
    await adapter
      .streamGenerate(PROMPT, cb, { signal: controller.signal })
      .catch(() => {});

    expect(result.value).toBeNull();
  });

  it('falls back to the local estimator when the stream omits usage', async () => {
    const sse =
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"abcd"}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';
    const { impl } = makeRecordingFetch(() => makeStreamResponse([sse]));
    const adapter = new AnthropicAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    const { cb, result } = makeStreamCallbacks();
    await adapter.streamGenerate(PROMPT, cb, NO_OPTS);

    // 'abcd' is 4 chars → 1 token via the ~4 chars/token estimator.
    expect(result.value?.completionTokens).toBe(1);
    expect(result.value?.promptTokens).toBe(adapter.countTokens(PROMPT.fullPrompt));
  });
});

// --- Error / retry classification ---------------------------------------

describe('AnthropicAdapter — error classification', () => {
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
      makeJsonResponse({ error: { type: 'invalid_request_error', message: 'bad' } }, 400),
    );
    const adapter = new AnthropicAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    let caught: ProviderHttpError | null = null;
    try {
      await adapter.complete(PROMPT, NO_OPTS);
    } catch (err) {
      caught = err as ProviderHttpError;
    }

    expect(caught).not.toBeNull();
    expect(caught?.status).toBe(400);
    expect(caught?.providerId).toBe('anthropic');
    expect(calls).toHaveLength(1);
  });

  it('retries on 503 and eventually throws after the attempt budget is exhausted', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ error: { type: 'overloaded_error' } }, 503, {
        'retry-after': '0',
      }),
    );
    const adapter = new AnthropicAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    let caught: ProviderHttpError | null = null;
    try {
      await adapter.complete(PROMPT, NO_OPTS);
    } catch (err) {
      caught = err as ProviderHttpError;
    }

    expect(caught).not.toBeNull();
    expect(caught?.status).toBe(503);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.length).toBeLessThanOrEqual(3);
  }, 15_000);

  it('propagates the non-2xx body excerpt in the error message', async () => {
    const { impl } = makeRecordingFetch(() =>
      makeJsonResponse(
        { error: { type: 'authentication_error', message: 'invalid x-api-key' } },
        401,
      ),
    );
    const adapter = new AnthropicAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    await expect(adapter.complete(PROMPT, NO_OPTS)).rejects.toThrow(/401/);
  });
});

// --- Request body shape -------------------------------------------------

describe('AnthropicAdapter — request body shape', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('puts systemPrompt at the top level and user text in messages[0].content', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
    );
    const adapter = new AnthropicAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    await adapter.complete(PROMPT, { temperature: 0.3, maxOutputTokens: 128 });

    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.model).toBe('claude-3-5-sonnet-20241022');
    expect(body.system).toBe(PROMPT.systemPrompt);
    expect(body.messages).toEqual([
      { role: 'user', content: PROMPT.fullPrompt },
    ]);
    expect(body.max_tokens).toBe(128);
    expect(body.temperature).toBe(0.3);
    expect(body.stream).toBe(false);
  });

  it('defaults max_tokens to 4096 and stream:true on streamGenerate', async () => {
    const sse =
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const { impl, calls } = makeRecordingFetch(() => makeStreamResponse([sse]));
    const adapter = new AnthropicAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    const { cb } = makeStreamCallbacks();
    await adapter.streamGenerate(PROMPT, cb, NO_OPTS);

    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(4096);
    expect(body.temperature).toBe(0.7);
  });

  it('encodes images as content blocks with base64 source', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
    );
    const adapter = new AnthropicAdapter({ apiKey: TEST_API_KEY, fetchImpl: impl });

    await adapter.complete(
      {
        ...PROMPT,
        images: [{ mimeType: 'image/png', base64: 'iVBORw0KGgo=' }],
      },
      NO_OPTS,
    );

    const body = JSON.parse(String(calls[0].init?.body));
    expect(Array.isArray(body.messages[0].content)).toBe(true);
    expect(body.messages[0].content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
    });
    expect(body.messages[0].content[1]).toEqual({
      type: 'text',
      text: PROMPT.fullPrompt,
    });
  });
});
