// ============================================
// Tests for OpenAICompatibleAdapter (provider-agnostic base)
// ============================================
//
// The transport behaviour itself is pinned by `ollama.test.ts`, which must
// keep passing unmodified across the extraction. These example tests cover
// only what is *new* at the base-class level: constructor-injected identity,
// the `preflight` guard (zero fetches on a throw), the `scrubError` hook on
// HTTP failures, the `onUsage` callback, and the "append only
// /chat/completions, never synthesise /v1" endpoint rule.

import { describe, expect, it, vi } from 'vitest';

import { OpenAICompatibleAdapter } from './openAICompatible';
import type { CallOpts, PromptInput, ProviderHttpError } from './types';

const PROMPT: PromptInput = {
  systemPrompt: 'You are a helpful assistant.',
  userText: 'What is 2 + 2?',
  fullPrompt: 'You are a helpful assistant.\n\nWhat is 2 + 2?',
};

const NO_OPTS: CallOpts = {};

interface FetchCall {
  input: RequestInfo | URL;
  init: RequestInit | undefined;
}

function makeRecordingFetch(responder: () => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return responder();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OpenAICompatibleAdapter', () => {
  it('takes its identity from providerId and reports it on the response', async () => {
    const { impl } = makeRecordingFetch(() =>
      makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    const adapter = new OpenAICompatibleAdapter({
      providerId: 'gateway-x',
      baseUrl: 'https://example.com/v1',
      defaultModelId: 'some-model',
      fetchImpl: impl,
    });

    expect(adapter.name).toBe('gateway-x');
    const res = await adapter.complete(PROMPT, NO_OPTS);
    expect(res.providerId).toBe('gateway-x');
    expect(res.modelId).toBe('some-model');
  });

  it('appends only /chat/completions to the baseUrl and strips trailing slashes', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    const adapter = new OpenAICompatibleAdapter({
      providerId: 'gateway-x',
      baseUrl: 'https://example.com/v1//',
      defaultModelId: 'some-model',
      fetchImpl: impl,
    });

    await adapter.complete(PROMPT, NO_OPTS);
    expect(String(calls[0].input)).toBe('https://example.com/v1/chat/completions');
  });

  it('does not synthesise a /v1 segment for a versionless baseUrl', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    const adapter = new OpenAICompatibleAdapter({
      providerId: 'gateway-x',
      baseUrl: 'https://example.com/openai',
      defaultModelId: 'some-model',
      fetchImpl: impl,
    });

    await adapter.complete(PROMPT, NO_OPTS);
    expect(String(calls[0].input)).toBe('https://example.com/openai/chat/completions');
  });

  it('runs preflight before any fetch, so a throw produces zero HTTP requests', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    const adapter = new OpenAICompatibleAdapter({
      providerId: 'gateway-x',
      baseUrl: 'https://example.com/v1',
      defaultModelId: 'some-model',
      fetchImpl: impl,
      preflight: () => {
        throw new Error('blocked');
      },
    });

    await expect(adapter.complete(PROMPT, NO_OPTS)).rejects.toThrow('blocked');
    await expect(
      adapter.streamGenerate(
        PROMPT,
        { onToken: () => {}, onComplete: () => {}, onError: () => {} },
        NO_OPTS,
      ),
    ).rejects.toThrow('blocked');
    expect(calls).toHaveLength(0);
  });

  it('passes the assembled HTTP error message through scrubError', async () => {
    const secret = 'super-secret-token';
    const { impl } = makeRecordingFetch(
      () => new Response(`unauthorized: Bearer ${secret}`, { status: 401 }),
    );
    const adapter = new OpenAICompatibleAdapter({
      providerId: 'gateway-x',
      baseUrl: 'https://example.com/v1',
      defaultModelId: 'some-model',
      apiKey: secret,
      fetchImpl: impl,
      scrubError: (message) => message.split(secret).join('[REDACTED:APIKEY]'),
    });

    const err = await adapter
      .complete(PROMPT, NO_OPTS)
      .then(() => null)
      .catch((e: ProviderHttpError) => e);

    expect(err).not.toBeNull();
    expect(err?.status).toBe(401);
    expect(err?.providerId).toBe('gateway-x');
    expect(err?.message).not.toContain(secret);
    expect(err?.message).toContain('[REDACTED:APIKEY]');
  });

  it('invokes onUsage once per completed non-streaming request', async () => {
    const onUsage = vi.fn();
    const { impl } = makeRecordingFetch(() =>
      makeJsonResponse({
        choices: [{ message: { content: 'four' } }],
        usage: { prompt_tokens: 12, completion_tokens: 1 },
      }),
    );
    const adapter = new OpenAICompatibleAdapter({
      providerId: 'gateway-x',
      baseUrl: 'https://example.com/v1',
      defaultModelId: 'some-model',
      fetchImpl: impl,
      onUsage,
    });

    await adapter.complete(PROMPT, NO_OPTS);
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({
      modelId: 'some-model',
      promptTokens: 12,
      completionTokens: 1,
    });
  });
});

// --- Reasoning deltas ----------------------------------------------------
//
// A thinking model (`qwen3-vl-…-thinking`, DeepSeek-R1, …) streams its
// chain-of-thought on a delta field of its own and leaves `delta.content` null
// until the answer starts. On a hard problem that phase runs for tens of
// seconds, so an adapter that reads only `content` calls `onToken` zero times
// and the UI cannot distinguish a working request from a hung one.
//
// Guarantees under test: reasoning reaches `onReasoning` under either field
// spelling, cumulatively; it never leaks into `onToken` or the final answer
// text; and a consumer that supplies no `onReasoning` still streams normally.

/** Builds an SSE `Response` from raw frame payloads. */
function makeSseResponse(payloads: unknown[]): Response {
  const body = payloads
    .map((p) => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`)
    .join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function makeAdapter(impl: typeof fetch) {
  return new OpenAICompatibleAdapter({
    providerId: 'gateway-x',
    baseUrl: 'https://example.com/v1',
    defaultModelId: 'thinking-model',
    fetchImpl: impl,
  });
}

describe('OpenAICompatibleAdapter.streamGenerate — reasoning deltas', () => {
  it("accumulates OpenRouter's `reasoning` field into onReasoning, not onToken", async () => {
    const { impl } = makeRecordingFetch(() =>
      makeSseResponse([
        { choices: [{ delta: { role: 'assistant' } }] },
        { choices: [{ delta: { reasoning: 'Need O(1) get ' } }] },
        { choices: [{ delta: { reasoning: 'and put.' } }] },
        { choices: [{ delta: { content: 'class LFUCache {' } }] },
        '[DONE]',
      ]),
    );

    const onToken = vi.fn();
    const onReasoning = vi.fn();
    const onComplete = vi.fn();
    await makeAdapter(impl).streamGenerate(
      PROMPT,
      { onToken, onReasoning, onComplete, onError: () => {} },
      NO_OPTS,
    );

    // Cumulative, like onToken — consumers never concatenate themselves.
    expect(onReasoning.mock.calls.map((c) => c[0])).toEqual([
      'Need O(1) get ',
      'Need O(1) get and put.',
    ]);

    // The answer is only the answer. Reasoning in `onToken` or in the final
    // text would put the model's scratch work on screen as the solution.
    expect(onToken.mock.calls.map((c) => c[0])).toEqual(['class LFUCache {']);
    expect(onComplete.mock.calls[0][0].text).toBe('class LFUCache {');
  });

  it("accepts DashScope/vLLM's `reasoning_content` spelling too", async () => {
    const { impl } = makeRecordingFetch(() =>
      makeSseResponse([
        { choices: [{ delta: { reasoning_content: 'thinking…' } }] },
        { choices: [{ delta: { content: 'answer' } }] },
        '[DONE]',
      ]),
    );

    const onReasoning = vi.fn();
    await makeAdapter(impl).streamGenerate(
      PROMPT,
      { onToken: () => {}, onReasoning, onComplete: () => {}, onError: () => {} },
      NO_OPTS,
    );

    expect(onReasoning).toHaveBeenCalledWith('thinking…');
  });

  it('streams normally for a consumer that supplies no onReasoning', async () => {
    const { impl } = makeRecordingFetch(() =>
      makeSseResponse([
        { choices: [{ delta: { reasoning: 'ignored' } }] },
        { choices: [{ delta: { content: 'answer' } }] },
        '[DONE]',
      ]),
    );

    const onComplete = vi.fn();
    // `onReasoning` is optional; omitting it must not throw on the reasoning
    // frame, which would abort the request before the answer arrived.
    await makeAdapter(impl).streamGenerate(
      PROMPT,
      { onToken: () => {}, onComplete, onError: () => {} },
      NO_OPTS,
    );

    expect(onComplete.mock.calls[0][0].text).toBe('answer');
  });

  it('completes with empty text when reasoning consumed the whole budget', async () => {
    const { impl } = makeRecordingFetch(() =>
      makeSseResponse([
        { choices: [{ delta: { reasoning: 'a very long think' } }] },
        { choices: [{ delta: {}, finish_reason: 'length' }] },
        '[DONE]',
      ]),
    );

    const onComplete = vi.fn();
    const onError = vi.fn();
    await makeAdapter(impl).streamGenerate(
      PROMPT,
      { onToken: () => {}, onReasoning: () => {}, onComplete, onError },
      NO_OPTS,
    );

    // Not an error — the HTTP request succeeded. The empty answer is reported
    // as-is so the caller's own empty-response handling applies, rather than
    // being dressed up as a transport failure the router would fail over on.
    expect(onError).not.toHaveBeenCalled();
    expect(onComplete.mock.calls[0][0].text).toBe('');
  });
});

// --- Reasoning effort ----------------------------------------------------
//
// The reasoning phase, not the network or the capture, is what makes a hard
// question take a minute. `reasoning` is how that budget is capped — but it is
// an OpenRouter extension rather than part of the OpenAI schema, so an endpoint
// that has never heard of it must not be broken by our sending it.

describe('OpenAICompatibleAdapter — reasoning effort', () => {
  function bodyOf(calls: FetchCall[], i = 0): Record<string, unknown> {
    return JSON.parse(String(calls[i].init?.body)) as Record<string, unknown>;
  }

  it('omits the reasoning field entirely when no effort is configured', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    await makeAdapter(impl).complete(PROMPT, NO_OPTS);

    // Absent, not `reasoning: null`. A local runtime's request must stay
    // byte-identical to what it was before this parameter existed.
    expect(bodyOf(calls)).not.toHaveProperty('reasoning');
  });

  it('sends the adapter default, and lets a per-call value override it', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    const adapter = new OpenAICompatibleAdapter({
      providerId: 'gateway-x',
      baseUrl: 'https://example.com/v1',
      defaultModelId: 'thinking-model',
      defaultReasoningEffort: 'low',
      fetchImpl: impl,
    });

    await adapter.complete(PROMPT, NO_OPTS);
    expect(bodyOf(calls, 0).reasoning).toEqual({ effort: 'low' });

    await adapter.complete(PROMPT, { reasoningEffort: 'high' });
    expect(bodyOf(calls, 1).reasoning).toEqual({ effort: 'high' });
  });

  it("maps 'none' to enabled:false rather than effort:'none'", async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    // Models whose thinking is baked in reject `effort: 'none'` outright but
    // ignore `enabled: false`, so the ignorable spelling is the safe one.
    await makeAdapter(impl).complete(PROMPT, { reasoningEffort: 'none' });
    expect(bodyOf(calls).reasoning).toEqual({ enabled: false });
  });

  it('retries without reasoning when the endpoint 400s on it, then stops sending it', async () => {
    let call = 0;
    const { impl, calls } = makeRecordingFetch(() => {
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify({ error: { message: "Unrecognized request argument: 'reasoning'" } }),
          { status: 400 },
        );
      }
      return makeJsonResponse({ choices: [{ message: { content: 'ok' } }] });
    });
    const adapter = new OpenAICompatibleAdapter({
      providerId: 'strict-server',
      baseUrl: 'https://example.com/v1',
      defaultModelId: 'some-model',
      defaultReasoningEffort: 'low',
      fetchImpl: impl,
    });

    // The rejection is absorbed: the caller gets an answer, not a 400.
    const res = await adapter.complete(PROMPT, NO_OPTS);
    expect(res.text).toBe('ok');
    expect(bodyOf(calls, 0)).toHaveProperty('reasoning');
    expect(bodyOf(calls, 1)).not.toHaveProperty('reasoning');

    // And the verdict sticks — a permanent one-request cost, not a per-request
    // one.
    await adapter.complete(PROMPT, NO_OPTS);
    expect(calls).toHaveLength(3);
    expect(bodyOf(calls, 2)).not.toHaveProperty('reasoning');
  });

  it('does not swallow a 429 that happens to mention reasoning', async () => {
    const { impl } = makeRecordingFetch(
      () =>
        new Response(JSON.stringify({ error: { message: 'rate limited: reasoning quota' } }), {
          status: 429,
        }),
    );
    const adapter = new OpenAICompatibleAdapter({
      providerId: 'gateway-x',
      baseUrl: 'https://example.com/v1',
      defaultModelId: 'thinking-model',
      defaultReasoningEffort: 'low',
      fetchImpl: impl,
    });

    // Retrying without `reasoning` would not fix a 429, and hiding it would rob
    // the router of the signal it needs to fail over and start a cooldown.
    const err = await adapter
      .complete(PROMPT, NO_OPTS)
      .then(() => null)
      .catch((e: ProviderHttpError) => e);
    expect(err?.status).toBe(429);
  });

  it('applies the same fallback on the streaming path', async () => {
    let call = 0;
    const { impl, calls } = makeRecordingFetch(() => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({ error: { message: 'unknown field reasoning' } }), {
          status: 400,
        });
      }
      return makeSseResponse([{ choices: [{ delta: { content: 'ok' } }] }, '[DONE]']);
    });
    const adapter = new OpenAICompatibleAdapter({
      providerId: 'strict-server',
      baseUrl: 'https://example.com/v1',
      defaultModelId: 'some-model',
      defaultReasoningEffort: 'low',
      fetchImpl: impl,
    });

    const onComplete = vi.fn();
    await adapter.streamGenerate(
      PROMPT,
      { onToken: () => {}, onComplete, onError: () => {} },
      NO_OPTS,
    );

    expect(onComplete.mock.calls[0][0].text).toBe('ok');
    expect(bodyOf(calls, 1)).not.toHaveProperty('reasoning');
  });
});

// --- Fast model selection -------------------------------------------------
//
// Past a point, "make the answer arrive sooner" is a model choice rather than a
// tuning knob: a thinking-tuned variant deliberates for tens of seconds whether
// or not it is asked to. `preferFastModel` lets the latency-critical caller (the
// screen path) reach a second model on the same endpoint and credential.
//
// The guarantees that matter: the flag is inert when nothing is configured, so
// setting it unconditionally is safe; and an explicit `modelId` still wins, so
// the flag never overrides a caller that named a model outright.

describe('OpenAICompatibleAdapter — fast model selection', () => {
  function bodyOf(calls: FetchCall[], i = 0): Record<string, unknown> {
    return JSON.parse(String(calls[i].init?.body)) as Record<string, unknown>;
  }

  function adapterWith(impl: typeof fetch, fastModelId?: string) {
    return new OpenAICompatibleAdapter({
      providerId: 'gateway-x',
      baseUrl: 'https://example.com/v1',
      defaultModelId: 'slow-thinking-model',
      fastModelId,
      fetchImpl: impl,
    });
  }

  it('sends the fast model when the caller prefers it', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    await adapterWith(impl, 'quick-instruct-model').complete(PROMPT, { preferFastModel: true });
    expect(bodyOf(calls).model).toBe('quick-instruct-model');
  });

  it('falls back to the default model when no fast model is configured', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    // The whole point of a boolean: the screen path sets it on every dispatch,
    // and a provider that has no fast slot behaves exactly as it did before.
    await adapterWith(impl).complete(PROMPT, { preferFastModel: true });
    expect(bodyOf(calls).model).toBe('slow-thinking-model');
  });

  it('treats a blank fast model id as unset', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    // A Settings field the User left empty must never become a request for the
    // model named `''`, which every gateway answers with a 400 or a 404.
    await adapterWith(impl, '   ').complete(PROMPT, { preferFastModel: true });
    expect(bodyOf(calls).model).toBe('slow-thinking-model');
  });

  it('trims a fast model id before sending it', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    await adapterWith(impl, '  quick-instruct-model\n').complete(PROMPT, { preferFastModel: true });
    expect(bodyOf(calls).model).toBe('quick-instruct-model');
  });

  it('keeps the default model when the caller does not prefer speed', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    await adapterWith(impl, 'quick-instruct-model').complete(PROMPT, NO_OPTS);
    expect(bodyOf(calls).model).toBe('slow-thinking-model');
  });

  it('lets an explicit modelId win over both', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    // Naming a model is a stronger statement than preferring speed.
    await adapterWith(impl, 'quick-instruct-model').complete(PROMPT, {
      preferFastModel: true,
      modelId: 'caller-named-model',
    });
    expect(bodyOf(calls).model).toBe('caller-named-model');
  });

  it('applies the same resolution on the streaming path', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeSseResponse([{ choices: [{ delta: { content: 'ok' } }] }, '[DONE]']),
    );
    const onComplete = vi.fn();
    await adapterWith(impl, 'quick-instruct-model').streamGenerate(
      PROMPT,
      { onToken: () => {}, onComplete, onError: () => {} },
      { preferFastModel: true },
    );

    // The screen path streams, so this is the case that actually ships.
    expect(bodyOf(calls).model).toBe('quick-instruct-model');
    expect(onComplete.mock.calls[0][0].text).toBe('ok');
  });

  it('reports the fast model id in the usage event', async () => {
    const onUsage = vi.fn();
    const { impl } = makeRecordingFetch(() =>
      makeJsonResponse({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
    );
    const adapter = new OpenAICompatibleAdapter({
      providerId: 'gateway-x',
      baseUrl: 'https://example.com/v1',
      defaultModelId: 'slow-thinking-model',
      fastModelId: 'quick-instruct-model',
      fetchImpl: impl,
      onUsage,
    });

    await adapter.complete(PROMPT, { preferFastModel: true });
    // Spend_Tracker attributes cost per model, so attributing fast-path tokens
    // to the default model would misprice every screen question.
    expect(onUsage).toHaveBeenCalledWith({
      modelId: 'quick-instruct-model',
      promptTokens: 5,
      completionTokens: 2,
    });
  });

  it('reports the model that answered through onMetrics', async () => {
    const { impl } = makeRecordingFetch(() =>
      makeSseResponse([{ choices: [{ delta: { content: 'ok' } }] }, '[DONE]']),
    );
    const onMetrics = vi.fn();
    await adapterWith(impl, 'quick-instruct-model').streamGenerate(
      PROMPT,
      { onToken: () => {}, onComplete: () => {}, onError: () => {}, onMetrics },
      { preferFastModel: true },
    );

    // `onComplete`'s legacy `AIResponse` carries no model id, so this callback is
    // the only place a caller can learn which of the two models actually served
    // the request. Without it a measured latency cannot be attributed, which is
    // the difference between diagnosing the screen path and guessing at it.
    expect(onMetrics).toHaveBeenCalledTimes(1);
    const m = onMetrics.mock.calls[0][0] as {
      modelId: string;
      ttftMs: number;
      totalMs: number;
      retries: number;
    };
    expect(m.modelId).toBe('quick-instruct-model');
    expect(m.retries).toBe(0);
    expect(m.ttftMs).toBeGreaterThanOrEqual(0);
    expect(m.totalMs).toBeGreaterThanOrEqual(m.ttftMs);
  });

  it('still reports metrics when the stream carried only reasoning', async () => {
    const { impl } = makeRecordingFetch(() =>
      makeSseResponse([{ choices: [{ delta: { reasoning: 'thinking' } }] }, '[DONE]']),
    );
    const onMetrics = vi.fn();
    await adapterWith(impl).streamGenerate(
      PROMPT,
      { onToken: () => {}, onComplete: () => {}, onError: () => {}, onMetrics },
      {},
    );

    // The case worth naming: a thinking model that deliberated and produced no
    // answer. There is no first token to time, so `ttftMs` falls back to the
    // total rather than reporting 0 — which would read as "instant", the exact
    // opposite of what happened.
    const m = onMetrics.mock.calls[0][0] as { modelId: string; ttftMs: number; totalMs: number };
    expect(m.modelId).toBe('slow-thinking-model');
    expect(m.ttftMs).toBe(m.totalMs);
  });
});
