// ============================================
// Tests for OllamaCompatibleAdapter
// ============================================
//
// These tests exercise the adapter's contract with a mocked `fetch` impl
// against the OpenAI-compatible `/v1/chat/completions` shape exposed by
// Ollama and LM Studio. Property 11 (API keys never appear in URLs) gets
// its own dedicated cross-provider property test in task 8.8; here we
// assert the example-level invariants for the local-runtime adapter:
// optional auth header, custom baseUrl, OpenAI streaming dialect, and
// graceful behaviour when no auth is configured.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OllamaCompatibleAdapter } from './ollama';
import type {
  CallOpts,
  PromptInput,
  ProviderHttpError,
  StreamCallbacks,
} from './types';

// --- Helpers -------------------------------------------------------------

const TEST_API_KEY = 'lmstudio-local-token-not-a-real-key';

const PROMPT: PromptInput = {
  systemPrompt: 'You are a helpful local assistant.',
  userText: 'What is 2 + 2?',
  fullPrompt: 'You are a helpful local assistant.\n\nWhat is 2 + 2?',
};

/** Builds a `Response` whose body streams the given chunks then closes. */
function makeStreamResponse(chunks: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(enc.encode(chunk));
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

describe('OllamaCompatibleAdapter — construction', () => {
  it('accepts no apiKey (vanilla Ollama happy path)', () => {
    const a = new OllamaCompatibleAdapter();
    expect(a.name).toBe('ollama');
    expect(a.capabilities.streaming).toBe(true);
    expect(a.capabilities.imageInput).toBe(false);
    expect(a.capabilities.toolUse).toBe(true);
    expect(a.capabilities.maxInputTokens).toBeGreaterThan(0);
    expect(a.capabilities.pricePerMTokens).toEqual({ input: 0, output: 0 });
  });

  it('treats whitespace-only apiKey as not configured', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }),
    );
    const adapter = new OllamaCompatibleAdapter({ apiKey: '   ', fetchImpl: impl });
    await adapter.complete(PROMPT, NO_OPTS);
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('authorization')).toBeNull();
  });
});

// --- countTokens ---------------------------------------------------------

describe('OllamaCompatibleAdapter.countTokens', () => {
  const adapter = new OllamaCompatibleAdapter();

  it('returns 0 for empty input and approximates ~4 chars/token (ceiling)', () => {
    expect(adapter.countTokens('')).toBe(0);
    expect(adapter.countTokens('1234')).toBe(1);
    expect(adapter.countTokens('12345')).toBe(2);
    expect(adapter.countTokens('a'.repeat(1000))).toBe(250);
  });
});

// --- URL / endpoint / auth ----------------------------------------------

describe('OllamaCompatibleAdapter — URL and authentication', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('targets the default Ollama base URL and omits Authorization when no apiKey is set', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({
        choices: [{ message: { content: 'four' } }],
        usage: { prompt_tokens: 12, completion_tokens: 1 },
      }),
    );
    const adapter = new OllamaCompatibleAdapter({ fetchImpl: impl });

    const res = await adapter.complete(PROMPT, NO_OPTS);

    expect(res.text).toBe('four');
    expect(res.providerId).toBe('ollama');
    expect(res.isSimulated).toBe(false);
    expect(res.status).toBe(200);
    expect(res.promptTokens).toBe(12);
    expect(res.completionTokens).toBe(1);

    expect(calls).toHaveLength(1);
    const url = String(calls[0].input);
    expect(url).toBe('http://localhost:11434/v1/chat/completions');

    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('authorization')).toBeNull();
  });

  it('honours a custom baseUrl (LM Studio default) and trims trailing slashes', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    const adapter = new OllamaCompatibleAdapter({
      baseUrl: 'http://localhost:1234/v1///',
      fetchImpl: impl,
    });

    await adapter.complete(PROMPT, NO_OPTS);

    expect(String(calls[0].input)).toBe('http://localhost:1234/v1/chat/completions');
  });

  it('sends Authorization: Bearer <apiKey> when configured and never leaks the key into the URL', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    const adapter = new OllamaCompatibleAdapter({
      apiKey: TEST_API_KEY,
      fetchImpl: impl,
    });

    await adapter.complete(PROMPT, NO_OPTS);

    const url = String(calls[0].input);
    expect(url).not.toContain(TEST_API_KEY);
    expect(url).not.toContain('key=');
    expect(url).not.toContain('token=');

    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${TEST_API_KEY}`);
  });

  it('selects the model id supplied in opts.modelId and embeds it in the JSON body', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    const adapter = new OllamaCompatibleAdapter({ fetchImpl: impl });

    await adapter.complete(PROMPT, { modelId: 'qwen2.5:14b' });

    const url = String(calls[0].input);
    // Model travels in the body, not the URL.
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect(url).not.toContain('qwen2.5');

    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.model).toBe('qwen2.5:14b');
  });
});

// --- Streaming -----------------------------------------------------------

describe('OllamaCompatibleAdapter.streamGenerate', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('parses OpenAI-dialect SSE frames, accumulates delta.content, and respects [DONE]', async () => {
    const sse =
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":" "}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"world"}}],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n' +
      'data: [DONE]\n\n';
    const { impl, calls } = makeRecordingFetch(() => makeStreamResponse([sse]));
    const adapter = new OllamaCompatibleAdapter({ fetchImpl: impl });

    const { cb, tokens, errors, result } = makeStreamCallbacks();
    await adapter.streamGenerate(PROMPT, cb, NO_OPTS);

    expect(errors).toHaveLength(0);
    expect(tokens).toEqual(['Hello', 'Hello ', 'Hello world']);
    expect(result.value).not.toBeNull();
    expect(result.value?.text).toBe('Hello world');
    expect(result.value?.providerId).toBe('ollama');
    expect(result.value?.modelId).toBe('llama3.1');
    expect(result.value?.isSimulated).toBe(false);
    expect(result.value?.status).toBe(200);
    expect(result.value?.promptTokens).toBe(7);
    expect(result.value?.completionTokens).toBe(3);

    // Streaming requests carry `stream: true` in the body.
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.stream).toBe(true);
  });

  it('survives chunk boundaries that fall mid-frame', async () => {
    const frame = 'data: {"choices":[{"delta":{"content":"split"}}]}\n\n';
    const cut = 18;
    const { impl } = makeRecordingFetch(() =>
      makeStreamResponse([frame.slice(0, cut), frame.slice(cut)]),
    );
    const adapter = new OllamaCompatibleAdapter({ fetchImpl: impl });

    const { cb, tokens, errors, result } = makeStreamCallbacks();
    await adapter.streamGenerate(PROMPT, cb, NO_OPTS);

    expect(errors).toHaveLength(0);
    expect(tokens).toEqual(['split']);
    expect(result.value?.text).toBe('split');
  });

  it('falls back to the local estimator when the response omits usage', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"abcd"}}]}\n\n' +
      'data: [DONE]\n\n';
    const { impl } = makeRecordingFetch(() => makeStreamResponse([sse]));
    const adapter = new OllamaCompatibleAdapter({ fetchImpl: impl });

    const { cb, result } = makeStreamCallbacks();
    await adapter.streamGenerate(PROMPT, cb, NO_OPTS);

    // 'abcd' is 4 chars → 1 token via the ~4 chars/token estimator.
    expect(result.value?.completionTokens).toBe(1);
    expect(result.value?.promptTokens).toBe(adapter.countTokens(PROMPT.fullPrompt));
  });
});

// --- Error / retry classification ---------------------------------------

describe('OllamaCompatibleAdapter — error classification', () => {
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
      makeJsonResponse({ error: 'model not found' }, 404),
    );
    const adapter = new OllamaCompatibleAdapter({ fetchImpl: impl });

    let caught: ProviderHttpError | null = null;
    try {
      await adapter.complete(PROMPT, NO_OPTS);
    } catch (err) {
      caught = err as ProviderHttpError;
    }

    expect(caught).not.toBeNull();
    expect(caught?.status).toBe(404);
    expect(caught?.providerId).toBe('ollama');
    expect(calls).toHaveLength(1);
  });

  it('retries on transport-level TypeError (local server briefly unreachable)', async () => {
    let attempts = 0;
    const responder = () => {
      attempts++;
      if (attempts < 2) {
        throw new TypeError('Failed to fetch');
      }
      return makeJsonResponse({
        choices: [{ message: { content: 'recovered' } }],
      });
    };
    const { impl } = makeRecordingFetch(responder);
    const adapter = new OllamaCompatibleAdapter({ fetchImpl: impl });

    const res = await adapter.complete(PROMPT, NO_OPTS);
    expect(res.text).toBe('recovered');
    expect(attempts).toBe(2);
  }, 15_000);
});

// --- Request body shape -------------------------------------------------

describe('OllamaCompatibleAdapter — request body shape', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('emits OpenAI-dialect role-tagged messages with system + user + temperature + max_tokens', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    const adapter = new OllamaCompatibleAdapter({ fetchImpl: impl });

    await adapter.complete(PROMPT, { temperature: 0.3, maxOutputTokens: 128 });

    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.model).toBe('llama3.1');
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(128);
    expect(body.messages).toEqual([
      { role: 'system', content: PROMPT.systemPrompt },
      { role: 'user', content: PROMPT.fullPrompt },
    ]);
  });

  it('omits the system message when prompt.systemPrompt is empty', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    const adapter = new OllamaCompatibleAdapter({ fetchImpl: impl });

    await adapter.complete(
      { systemPrompt: '', userText: 'hi', fullPrompt: 'hi' },
      NO_OPTS,
    );

    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});
