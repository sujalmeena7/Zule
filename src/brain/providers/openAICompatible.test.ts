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
