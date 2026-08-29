// ============================================
// Zule AI — Custom_Provider_Adapter tests
// ============================================
//
// One top-level `describe` per correctness property, so the remaining
// properties for this adapter (13, 14, 11) and the example tests can be
// appended without touching what is already here.
//
// Harness note (design.md §Testing Strategy): every request-issuing test
// drives the adapter through an injected `fetchImpl` spy, so "the request
// the adapter issues" is inspected directly rather than inferred, and
// "zero HTTP requests" is a call-count assertion.

import { describe, expect, it, vi } from 'vitest';
import * as fc from 'fast-check';

import { CustomOpenAICompatibleAdapter } from './custom';
import type { CallOpts, PromptInput, StreamCallbacks } from './types';

// --- Shared harness ------------------------------------------------------

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

const SSE_HAPPY_PATH =
  'data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n' +
  'data: [DONE]\n\n';

const NO_OPTS: CallOpts = {};

function collectingCallbacks(): StreamCallbacks & {
  completions: number;
  errors: Error[];
} {
  const state = {
    completions: 0,
    errors: [] as Error[],
    onToken: () => {},
    onComplete: () => {
      state.completions += 1;
    },
    onError: (err: Error) => {
      state.errors.push(err);
    },
  };
  return state;
}

// ── Generators ──────────────────────────────────────────────────────────────

/**
 * The credential input space named by the property: absent, empty,
 * whitespace-only, and non-blank (optionally padded, so the adapter's
 * trimming is exercised). Non-blank keys are drawn from a shape that cannot
 * collide with generated prompt text, and include regex metacharacters
 * because the credential is used as a literal needle, never as a pattern.
 */
const arbBlankKey = fc.oneof(
  fc.constant(undefined),
  fc.constant(''),
  fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r', '\u00a0'), {
    minLength: 1,
    maxLength: 4,
  }),
);

const arbNonBlankKey = fc
  .tuple(
    fc.stringOf(fc.constantFrom(' ', '\t', '\n'), { maxLength: 2 }),
    fc.stringOf(fc.constantFrom(...'0123456789abcdefABCDEF-_.+*?[]$'), {
      minLength: 1,
      maxLength: 40,
    }),
    fc.stringOf(fc.constantFrom(' ', '\t', '\n'), { maxLength: 2 }),
  )
  .map(([lead, body, trail]) => `${lead}sk-${body}${trail}`);

const arbApiKey = fc.oneof(
  { weight: 3, arbitrary: arbNonBlankKey },
  { weight: 2, arbitrary: arbBlankKey },
);

const arbBaseUrl = fc.constantFrom(
  'https://example.com/v1',
  'http://localhost:1234/v1',
  'https://openrouter.ai/api/v1',
  'https://api.groq.com/openai/v1/',
  'https://gw.example.com',
);

const arbModelId = fc.constantFrom(
  'llama-3.1-8b',
  'mistralai/mixtral-8x7b',
  'gpt-4o-mini',
  'qwen2.5:7b',
);

/**
 * A prompt that passes the adapter's `preflight` (`assertRedacted`), which
 * is a precondition for any request being issued at all: without a complete
 * attestation the adapter's egress count is zero and there is nothing to
 * inspect.
 */
const arbAttestedPrompt = fc
  .record({
    systemPrompt: fc.string({ maxLength: 60 }),
    userText: fc.string({ maxLength: 60 }),
    fullPrompt: fc.string({ maxLength: 120 }),
    segments: fc.integer({ min: 0, max: 6 }),
    ruleCount: fc.integer({ min: 0, max: 5 }),
    withImage: fc.boolean(),
  })
  .map(
    ({ systemPrompt, userText, fullPrompt, segments, ruleCount, withImage }): PromptInput => ({
      systemPrompt,
      userText,
      fullPrompt,
      ...(withImage
        ? { images: [{ mimeType: 'image/png', base64: 'aGVsbG8=' }] }
        : {}),
      redaction: {
        applied: true,
        ruleCount,
        segmentsTotal: segments,
        segmentsRedacted: segments,
      },
    }),
  );

const arbEntryPoint = fc.constantFrom<'complete' | 'stream'>('complete', 'stream');

// ── Property 12 ─────────────────────────────────────────────────────────────

// Feature: custom-openai-compatible-provider, Property 12: The credential travels only in the Authorization header
//
// *For any* API_Key value (including absent, empty, and whitespace-only) and
// *for any* prompt, the request the Custom_Provider_Adapter issues SHALL carry
// the `Authorization: Bearer <key>` header if and only if the key is non-blank,
// SHALL carry the key in no other header value, SHALL exclude the key from the
// serialised request body, and SHALL use a request URL whose path, query
// string, and fragment exclude the key.
//
// **Validates: Requirements 3.2, 3.3, 3.4**

describe('Property 12: The credential travels only in the Authorization header', () => {
  it('sends Bearer auth iff the key is non-blank, and never in another header, the body, or the URL', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbApiKey,
        arbBaseUrl,
        arbModelId,
        arbAttestedPrompt,
        arbEntryPoint,
        async (apiKey, baseUrl, modelId, prompt, entryPoint) => {
          const key = apiKey ?? '';
          const trimmed = key.trim();
          const nonBlank = trimmed.length > 0;

          // The credential must be distinguishable from the prompt payload
          // for the body-exclusion clause to mean anything.
          const promptTexts = [prompt.systemPrompt, prompt.userText, prompt.fullPrompt];
          fc.pre(promptTexts.every((t) => !t.includes('Bearer')));
          if (nonBlank) {
            fc.pre(
              promptTexts.every((t) => !t.includes(trimmed)) && !modelId.includes(trimmed),
            );
          }

          const { impl, calls } = makeRecordingFetch(() =>
            entryPoint === 'stream'
              ? makeStreamResponse([SSE_HAPPY_PATH])
              : makeJsonResponse({
                  choices: [{ message: { content: 'ok' } }],
                  usage: { prompt_tokens: 5, completion_tokens: 1 },
                }),
          );

          const adapter = new CustomOpenAICompatibleAdapter({
            baseUrl,
            modelId,
            apiKey,
            fetchImpl: impl,
            telemetrySink: () => {},
          });

          if (entryPoint === 'stream') {
            const cb = collectingCallbacks();
            await adapter.streamGenerate(prompt, cb, NO_OPTS);
            expect(cb.errors).toEqual([]);
            expect(cb.completions).toBe(1);
          } else {
            await adapter.complete(prompt, NO_OPTS);
          }

          // Exactly one request was issued, so the assertions below are
          // about a request that really happened.
          expect(calls).toHaveLength(1);
          const { input, init } = calls[0];

          // --- Headers ---------------------------------------------------
          const headers = new Headers(init?.headers as HeadersInit);
          const headerNames = [...headers.keys()].sort();

          // The Authorization header is present exactly when the key is
          // non-blank, and no other credential-bearing header is added
          // (Requirements 3.2, 3.4). content-length is also sent to
          // avoid chunked transfer encoding issues with custom gateways.
          expect(headerNames).toEqual(
            nonBlank ? ['authorization', 'content-length', 'content-type'] : ['content-length', 'content-type'],
          );

          if (nonBlank) {
            expect(headers.get('authorization')).toBe(`Bearer ${trimmed}`);
            // The key appears in no other header value.
            for (const [name, value] of headers.entries()) {
              if (name === 'authorization') continue;
              expect(value).not.toContain(trimmed);
            }
          } else {
            expect(headers.has('authorization')).toBe(false);
          }

          // --- Body ------------------------------------------------------
          const body = init?.body;
          expect(typeof body).toBe('string');
          const serialisedBody = String(body);
          if (nonBlank) {
            expect(serialisedBody).not.toContain(trimmed);
          }
          expect(serialisedBody).not.toContain('Bearer');

          // --- URL -------------------------------------------------------
          const rawUrl = String(input);
          const url = new URL(rawUrl);
          expect(url.pathname).toBe(
            `${new URL(baseUrl.replace(/\/+$/, '')).pathname.replace(/\/+$/, '')}/chat/completions`,
          );
          if (nonBlank) {
            expect(url.pathname).not.toContain(trimmed);
            expect(url.search).not.toContain(trimmed);
            expect(url.hash).not.toContain(trimmed);
            expect(rawUrl).not.toContain(trimmed);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 13 ─────────────────────────────────────────────────────────────

import { REDACTED_APIKEY_MASK, scrubSecret } from './custom';

/**
 * Property 13 narrows Property 12's credential space: only keys of at least
 * `MIN_SCRUBBABLE_SECRET_LENGTH` (8) characters are scrubbable, shorter ones
 * being left alone deliberately (a 4-character "key" like `test` would
 * otherwise mangle unrelated error text). Reuses the harness generator so the
 * regex-metacharacter shapes stay in the input space — the scrubber must treat
 * the credential as a literal needle, never as a pattern.
 */
const arbScrubbableKey = arbNonBlankKey.filter((k) => k.trim().length >= 8);

/**
 * Upstream failure statuses. 429 and 5xx are included because the property
 * says "arbitrary status", but weighted low: those are the retryable classes,
 * so each such run pays two real backoff sleeps inside `retryWithJitter`.
 * 204/205/304 are excluded — `Response` forbids a body on those, so they
 * cannot model a gateway that echoes the credential back.
 */
const arbFailureStatus = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.constantFrom(400, 401, 402, 403, 404, 409, 418, 422, 451),
  },
  { weight: 1, arbitrary: fc.constantFrom(429, 500, 502, 503) },
);

/**
 * Bodies a careless gateway really sends: the credential echoed bare, echoed
 * inside the reflected `Authorization` header, or both. Kept short enough to
 * survive the base class's 200-character body excerpt, so the assertions below
 * cannot pass vacuously through truncation.
 */
function makeEchoingBody(kind: 'bare' | 'header' | 'both', key: string): string {
  switch (kind) {
    case 'bare':
      return `{"error":{"message":"Invalid api key: ${key}"}}`;
    case 'header':
      return `{"error":{"message":"rejected header Authorization: Bearer ${key}"}}`;
    case 'both':
      return `Authorization: Bearer ${key} / key=${key}`;
  }
}

/** Every string the error surface can emit: message, tag, and own properties. */
function emittedStrings(err: unknown): string[] {
  const out: string[] = [];
  if (err instanceof Error) {
    out.push(err.message, err.name, String(err), err.stack ?? '');
  } else {
    out.push(String(err));
  }
  if (err && typeof err === 'object') {
    for (const name of Object.getOwnPropertyNames(err)) {
      const value = (err as Record<string, unknown>)[name];
      out.push(name);
      out.push(typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value)));
    }
  }
  return out;
}

// Feature: custom-openai-compatible-provider, Property 13: No surface emits the credential
//
// *For any* API_Key of at least 8 characters, *for any* upstream failure
// response (arbitrary status and body, including bodies that echo the key or
// the `Authorization` header verbatim), and *for any* emitting surface in
// `{adapter error, Provider_Sync log, Connection_Test result,
// Copilot_Error_Surface message}`, every emitted string — the error message,
// every own enumerable property of the error, every console output, and every
// User-visible message — SHALL exclude the API_Key value and the
// `Authorization` header value.
//
// **Validates: Requirements 3.7, 3.9**

describe('Property 13: No surface emits the credential', () => {
  it(
    'excludes the key and its Bearer form from the error message, the error properties, and every scrubbed message surface',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          arbScrubbableKey,
          arbBaseUrl,
          arbModelId,
          arbAttestedPrompt,
          arbEntryPoint,
          arbFailureStatus,
          fc.constantFrom<'bare' | 'header' | 'both'>('bare', 'header', 'both'),
          async (apiKey, baseUrl, modelId, prompt, entryPoint, status, bodyKind) => {
            const trimmed = apiKey.trim();
            const bearer = `Bearer ${trimmed}`;

            // The credential must be distinguishable from the prompt payload
            // and the model id, or "excludes the key" would be untestable.
            const promptTexts = [prompt.systemPrompt, prompt.userText, prompt.fullPrompt];
            fc.pre(
              promptTexts.every((t) => !t.includes(trimmed)) && !modelId.includes(trimmed),
            );

            // A fresh Response per call: `retryWithJitter` re-issues the
            // request for 429/5xx, and a body may only be read once — reusing
            // one Response would hand the last attempt an empty body and let
            // the assertions pass without the scrubber doing anything.
            const { impl, calls } = makeRecordingFetch(() =>
              makeJsonResponse(makeEchoingBody(bodyKind, trimmed), status),
            );

            const adapter = new CustomOpenAICompatibleAdapter({
              baseUrl,
              modelId,
              apiKey,
              fetchImpl: impl,
              telemetrySink: () => {},
            });

            let caught: unknown;
            const cb = collectingCallbacks();
            try {
              if (entryPoint === 'stream') {
                await adapter.streamGenerate(prompt, cb, NO_OPTS);
              } else {
                await adapter.complete(prompt, NO_OPTS);
              }
            } catch (err) {
              caught = err;
            }

            // The failure really reached the adapter's error surface.
            expect(calls.length).toBeGreaterThanOrEqual(1);
            const failures = [
              ...(caught === undefined ? [] : [caught]),
              ...cb.errors,
            ];
            expect(failures.length).toBeGreaterThanOrEqual(1);
            expect(cb.completions).toBe(0);

            // --- Adapter error surface -------------------------------------
            for (const failure of failures) {
              for (const emitted of emittedStrings(failure)) {
                expect(emitted).not.toContain(trimmed);
                expect(emitted).not.toContain(bearer);
              }
            }

            // The scrubber actually fired rather than the key vanishing
            // through body truncation (Requirement 3.7).
            const primary = failures[0];
            expect(primary).toBeInstanceOf(Error);
            expect((primary as Error).message).toContain(REDACTED_APIKEY_MASK);

            // --- Provider_Sync log / Connection_Test / Copilot surfaces ----
            // All three route their text through `scrubSecret` before it
            // reaches the console, a toast, or the error surface
            // (Requirement 3.9).
            const surfaces = [
              `Provider_Sync: custom registration failed — ${bearer} was rejected (${trimmed})`,
              `Connection_Test: HTTP ${status} — ${makeEchoingBody(bodyKind, trimmed)}`,
              `Copilot: provider 'custom' returned ${status}: key ${trimmed} invalid`,
            ];
            for (const surface of surfaces) {
              const scrubbed = scrubSecret(surface, trimmed);
              expect(scrubbed).not.toContain(trimmed);
              expect(scrubbed).not.toContain(bearer);
              expect(scrubbed).toContain(REDACTED_APIKEY_MASK);
            }
          },
        ),
        { numRuns: 100 },
      );
    },
    120_000,
  );
});

// ── Property 14 ─────────────────────────────────────────────────────────────

import type { MetricEvent } from '../telemetry';

/**
 * Usage blocks are handed to the adapter as **raw JSON text** rather than
 * through `JSON.stringify`, because the interesting malformed shapes cannot
 * survive a round trip through it: `1e999` parses back as `Infinity` and
 * `JSON.stringify(Infinity)` is `null`. Writing the fragment by hand is the
 * only way to exercise the non-finite branch of the adapter's coercion.
 */
type UsageKind =
  | 'reported'
  | 'absent'
  | 'partial-prompt'
  | 'partial-completion'
  | 'malformed';

/** Malformed usage blocks a real gateway (or a buggy shim) can emit. */
const MALFORMED_USAGE_FRAGMENTS = [
  '{"prompt_tokens":-7,"completion_tokens":-1}', // negative
  '{"prompt_tokens":12.7,"completion_tokens":0.4}', // fractional
  '{"prompt_tokens":1e999,"completion_tokens":1e999}', // non-finite
  '{"prompt_tokens":1e20,"completion_tokens":99999999999999}', // huge
  '{"prompt_tokens":"42","completion_tokens":"abc"}', // non-numeric
  '{"prompt_tokens":null,"completion_tokens":true}', // non-numeric
  '{"prompt_tokens":{},"completion_tokens":[]}', // non-numeric
  '{}', // present but empty
  'null', // usage: null
];

const arbUsageBlock = fc
  .oneof(
    fc
      .tuple(fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 100_000 }))
      .map(([p, c]) => ({
        kind: 'reported' as UsageKind,
        fragment: `{"prompt_tokens":${p},"completion_tokens":${c}}`,
        promptTokens: p,
        completionTokens: c,
      })),
    fc.constant({
      kind: 'absent' as UsageKind,
      fragment: undefined,
      promptTokens: undefined,
      completionTokens: undefined,
    }),
    fc.integer({ min: 0, max: 100_000 }).map((p) => ({
      kind: 'partial-prompt' as UsageKind,
      fragment: `{"prompt_tokens":${p}}`,
      promptTokens: p,
      completionTokens: undefined,
    })),
    fc.integer({ min: 0, max: 100_000 }).map((c) => ({
      kind: 'partial-completion' as UsageKind,
      fragment: `{"completion_tokens":${c}}`,
      promptTokens: undefined,
      completionTokens: c,
    })),
    fc.constantFrom(...MALFORMED_USAGE_FRAGMENTS).map((fragment) => ({
      kind: 'malformed' as UsageKind,
      fragment,
      promptTokens: undefined,
      completionTokens: undefined,
    })),
  )
  .map((u) => u as { kind: UsageKind; fragment?: string; promptTokens?: number; completionTokens?: number });

/**
 * Failure modes that reach the adapter's error surface in a single attempt:
 * every one of them is classified non-retryable by `http.ts`, so a run costs
 * no real backoff sleep. (A transport `TypeError` would be retried twice.)
 */
const arbFailureMode = fc.constantFrom<400 | 401 | 404 | 'throw'>(400, 401, 404, 'throw');

/** A `Response` carrying a hand-written JSON body. */
function makeRawJsonResponse(bodyText: string, status = 200): Response {
  return new Response(bodyText, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The `ceil(len / 4)` fallback the adapter estimates with when usage is absent. */
function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

// Feature: custom-openai-compatible-provider, Property 14: Exactly one token-usage event per completed request
//
// *For any* completed Custom_Provider request (streaming or non-streaming) and
// *for any* usage block the gateway reports (complete, partial, absent, or
// negative), exactly one telemetry event of kind `tokens` SHALL be recorded,
// whose provider id is `custom`, whose model id is the configured Model_ID,
// whose prompt and completion token counts are non-negative integers, and none
// of whose fields contains the API_Key value.
//
// **Validates: Requirements 3.8**

describe('Property 14: Exactly one token-usage event per completed request', () => {
  it(
    'records exactly one credential-free tokens event with non-negative integer counts per completed request, and none for a failed one',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          arbApiKey,
          arbBaseUrl,
          arbModelId,
          arbAttestedPrompt,
          arbEntryPoint,
          arbUsageBlock,
          fc.string({ maxLength: 40 }),
          fc.option(arbFailureMode, { nil: undefined }),
          async (apiKey, baseUrl, modelId, prompt, entryPoint, usage, content, failure) => {
            const trimmedKey = (apiKey ?? '').trim();
            const hasKey = trimmedKey.length > 0;

            // "None of whose fields contains the API_Key" is only meaningful
            // when the credential cannot arrive through the payload instead.
            if (hasKey) {
              fc.pre(
                !modelId.includes(trimmedKey) &&
                  !content.includes(trimmedKey) &&
                  [prompt.systemPrompt, prompt.userText, prompt.fullPrompt].every(
                    (t) => !t.includes(trimmedKey),
                  ),
              );
            }

            const usagePart = usage.fragment === undefined ? '' : `,"usage":${usage.fragment}`;

            const { impl, calls } = makeRecordingFetch(() => {
              if (failure === 'throw') throw new Error('gateway unreachable');
              if (typeof failure === 'number') {
                return makeRawJsonResponse('{"error":{"message":"nope"}}', failure);
              }
              return entryPoint === 'stream'
                ? makeStreamResponse([
                    `data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}\n\n`,
                    usage.fragment === undefined
                      ? ''
                      : `data: {"choices":[{"delta":{}}]${usagePart}}\n\n`,
                    'data: [DONE]\n\n',
                  ])
                : makeRawJsonResponse(
                    `{"choices":[{"message":{"content":${JSON.stringify(content)}}}]${usagePart}}`,
                  );
            });

            const events: MetricEvent[] = [];
            const adapter = new CustomOpenAICompatibleAdapter({
              baseUrl,
              modelId,
              apiKey,
              fetchImpl: impl,
              telemetrySink: (event) => {
                events.push(event);
              },
            });

            const cb = collectingCallbacks();
            let threw = false;
            try {
              if (entryPoint === 'stream') {
                await adapter.streamGenerate(prompt, cb, NO_OPTS);
              } else {
                await adapter.complete(prompt, NO_OPTS);
              }
            } catch {
              threw = true;
            }

            expect(calls).toHaveLength(1);

            // --- A failed request emits no token-usage event ---------------
            if (failure !== undefined) {
              expect(threw || cb.errors.length > 0).toBe(true);
              expect(cb.completions).toBe(0);
              expect(events).toEqual([]);
              return;
            }

            // --- Exactly one event, of kind `tokens` -----------------------
            expect(threw).toBe(false);
            expect(cb.errors).toEqual([]);
            if (entryPoint === 'stream') expect(cb.completions).toBe(1);

            expect(events).toHaveLength(1);
            const event = events[0];
            expect(event.kind).toBe('tokens');
            const tokensEvent = event as Extract<MetricEvent, { kind: 'tokens' }>;

            // --- Identity and shape ----------------------------------------
            expect(tokensEvent.providerId).toBe('custom');
            expect(tokensEvent.modelId).toBe(modelId);
            for (const count of [tokensEvent.promptTokens, tokensEvent.completionTokens]) {
              expect(Number.isInteger(count)).toBe(true);
              expect(count).toBeGreaterThanOrEqual(0);
            }

            // --- Reported vs estimated counts ------------------------------
            // The estimator is `ceil(len / 4)` over the prompt text the body
            // carried and over the assistant text the gateway returned.
            const promptText = prompt.fullPrompt || prompt.userText || '';
            const estimatedPrompt = estimateTokens(promptText);
            const estimatedCompletion = estimateTokens(content);

            if (usage.promptTokens !== undefined) {
              expect(tokensEvent.promptTokens).toBe(usage.promptTokens);
            } else if (usage.kind === 'absent' || usage.kind === 'partial-completion') {
              expect(tokensEvent.promptTokens).toBe(estimatedPrompt);
            }
            if (usage.completionTokens !== undefined) {
              expect(tokensEvent.completionTokens).toBe(usage.completionTokens);
            } else if (usage.kind === 'absent' || usage.kind === 'partial-prompt') {
              expect(tokensEvent.completionTokens).toBe(estimatedCompletion);
            }

            // --- The credential appears in no field ------------------------
            if (hasKey) {
              for (const [name, value] of Object.entries(tokensEvent)) {
                expect(name).not.toContain(trimmedKey);
                expect(String(value)).not.toContain(trimmedKey);
              }
              expect(JSON.stringify(tokensEvent)).not.toContain(trimmedKey);
              expect(JSON.stringify(tokensEvent)).not.toContain(`Bearer ${trimmedKey}`);
            }
          },
        ),
        { numRuns: 100 },
      );
    },
    60_000,
  );
});

// ── Example tests (task 5.5) ────────────────────────────────────────────────

import type { ProviderResponse } from './types';

/**
 * A minimal prompt carrying a complete redaction attestation — the
 * precondition for the adapter issuing any request at all
 * (`assertRedacted`, Requirements 2.9, 2.10).
 */
const ATTESTED_PROMPT: PromptInput = {
  systemPrompt: 'You are a helpful assistant.',
  userText: 'Say hello.',
  fullPrompt: 'Say hello.',
  redaction: { applied: true, ruleCount: 2, segmentsTotal: 3, segmentsRedacted: 3 },
};

/**
 * Multi-frame SSE fixture terminated by the OpenAI-dialect `data: [DONE]`
 * sentinel. Three content frames, then a usage-only frame, so the cumulative
 * `onToken` contract (each call receives the whole text so far, not the
 * delta) is actually observable.
 */
const SSE_MULTI_FRAME = [
  'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"lo, "}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":3}}\n\n',
  'data: [DONE]\n\n',
];

/** `collectingCallbacks` plus the recorded `onToken` texts and responses. */
function recordingCallbacks() {
  const cb = collectingCallbacks();
  const tokens: string[] = [];
  const responses: ProviderResponse[] = [];
  const countCompletion = cb.onComplete;
  cb.onToken = (cumulativeText: string) => {
    tokens.push(cumulativeText);
  };
  cb.onComplete = (response: ProviderResponse) => {
    countCompletion(response);
    responses.push(response);
  };
  return { cb, tokens, responses };
}

describe('CustomOpenAICompatibleAdapter — examples', () => {
  it('exposes the provider id `custom` as its name', () => {
    const adapter = new CustomOpenAICompatibleAdapter({
      baseUrl: 'https://example.com/v1',
      modelId: 'gpt-4o-mini',
    });

    // Requirement 2.1 — never `ollama`, which is exempt from the cloud gates.
    expect(adapter.name).toBe('custom');
  });

  it('appends only /chat/completions to the Base_URL — no /v1 synthesis', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      }),
    );

    const adapter = new CustomOpenAICompatibleAdapter({
      baseUrl: 'https://example.com/v1',
      modelId: 'gpt-4o-mini',
      fetchImpl: impl,
      telemetrySink: () => {},
    });

    await adapter.complete(ATTESTED_PROMPT, NO_OPTS);

    expect(calls).toHaveLength(1);
    expect(String(calls[0].input)).toBe('https://example.com/v1/chat/completions');
  });

  it('uses a Base_URL without a version segment verbatim — unlike the ollama branch in aiProvider.ts', async () => {
    const { impl, calls } = makeRecordingFetch(() =>
      makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );

    const adapter = new CustomOpenAICompatibleAdapter({
      baseUrl: 'https://gw.example.com/',
      modelId: 'llama-3.1-8b',
      fetchImpl: impl,
      telemetrySink: () => {},
    });

    await adapter.complete(ATTESTED_PROMPT, NO_OPTS);

    // The trailing slash is normalised away and no `/v1` is inserted: a
    // gateway whose documented base carries no version segment must not have
    // one invented for it.
    expect(String(calls[0].input)).toBe('https://gw.example.com/chat/completions');
  });

  it('streams a canned SSE fixture, reporting cumulative token text and completing exactly once', async () => {
    const { impl, calls } = makeRecordingFetch(() => makeStreamResponse(SSE_MULTI_FRAME));

    const adapter = new CustomOpenAICompatibleAdapter({
      baseUrl: 'https://example.com/v1',
      modelId: 'gpt-4o-mini',
      fetchImpl: impl,
      telemetrySink: () => {},
    });

    const { cb, tokens, responses } = recordingCallbacks();
    await adapter.streamGenerate(ATTESTED_PROMPT, cb, NO_OPTS);

    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0].init?.body)).stream).toBe(true);
    expect(cb.errors).toEqual([]);

    // `onToken` receives the whole text so far on each contributing frame;
    // the role-only and usage-only frames contribute nothing.
    expect(tokens).toEqual(['Hel', 'Hello, ', 'Hello, world']);

    // Exactly one completion, carrying the assembled text, the identity, and
    // the gateway-reported usage.
    expect(cb.completions).toBe(1);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      text: 'Hello, world',
      providerId: 'custom',
      modelId: 'gpt-4o-mini',
      promptTokens: 11,
      completionTokens: 3,
      isSimulated: false,
      status: 200,
    });
  });

  it('refuses construction with a blank baseUrl or a blank modelId', () => {
    // Requirement 1.6 — an incompletely configured adapter must not exist, so
    // Provider_Sync cannot register one that would call an empty endpoint.
    // Blankness is `trim().length === 0`, so whitespace-only counts.
    for (const baseUrl of ['', '   ', '\t\n']) {
      expect(
        () => new CustomOpenAICompatibleAdapter({ baseUrl, modelId: 'gpt-4o-mini' }),
      ).toThrow(/baseUrl is required/);
    }

    for (const modelId of ['', '   ', '\t\n']) {
      expect(
        () =>
          new CustomOpenAICompatibleAdapter({
            baseUrl: 'https://example.com/v1',
            modelId,
          }),
      ).toThrow(/modelId is required/);
    }
  });

  it('accepts a blank fastModelId as "no fast model", unlike modelId', async () => {
    // `fastModelId` is optional, so blankness is a valid configuration rather
    // than the construction error a blank `modelId` is. Construction must
    // succeed, and a `preferFastModel` dispatch must fall back to `modelId`
    // rather than requesting the model named `''`.
    for (const fastModelId of ['', '   ', '\t\n']) {
      const { impl, calls } = makeRecordingFetch(() =>
        makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
      );
      const adapter = new CustomOpenAICompatibleAdapter({
        baseUrl: 'https://example.com/v1',
        modelId: 'gpt-4o-mini',
        fastModelId,
        fetchImpl: impl,
        telemetrySink: () => {},
      });

      await adapter.complete(ATTESTED_PROMPT, { preferFastModel: true });
      expect(JSON.parse(String(calls[0].init?.body)).model).toBe('gpt-4o-mini');
    }
  });

  it('routes a preferFastModel dispatch to the configured fast model', async () => {
    const { impl, calls } = makeRecordingFetch(() => makeStreamResponse(SSE_MULTI_FRAME));

    const adapter = new CustomOpenAICompatibleAdapter({
      baseUrl: 'https://example.com/v1',
      modelId: 'qwen-thinking',
      fastModelId: 'qwen-instruct',
      fetchImpl: impl,
      telemetrySink: () => {},
    });

    const { cb, responses } = recordingCallbacks();
    await adapter.streamGenerate(ATTESTED_PROMPT, cb, { preferFastModel: true });

    // Same endpoint, same credential — only the `model` string differs, which is
    // the entire mechanism.
    expect(String(calls[0].input)).toBe('https://example.com/v1/chat/completions');
    expect(JSON.parse(String(calls[0].init?.body)).model).toBe('qwen-instruct');
    expect(responses[0].modelId).toBe('qwen-instruct');
  });
});

// ── Property 11 ─────────────────────────────────────────────────────────────

import { apply as applyRedaction } from '../redaction';
import type { RedactionEntity, RedactionRule } from '../../types/redaction';
import type { RedactionAttestation } from '../../types/ai';
import { RedactionIncompleteError } from './custom';

/**
 * Segments carry a distinctive `ZSEG-` marker so "the error is content-free"
 * is a meaningful assertion: a generated segment made of ordinary words could
 * appear inside the adapter's own message by coincidence and let the check
 * pass (or fail) for the wrong reason.
 *
 * The payloads are the shapes the built-in entity rules actually match, plus
 * one that matches nothing — an unredactable segment must not change the
 * outcome either way.
 */
const P11_PAYLOADS = [
  'alice@example.com',
  '+1 (415) 555-0142',
  '4111 1111 1111 1111',
  'GB29NWBK60161331926819',
  '123-45-6789',
  'nothing-sensitive-here',
];

type P11Segment = { label: '[AUDIO]' | '[SCREEN]' | '[KNOWLEDGE]'; text: string };

/** Transcript, screen-text, and Knowledge_Base segments, pre-redaction. */
const arbP11Segments = fc.array(
  fc
    .tuple(
      fc.constantFrom<P11Segment['label']>('[AUDIO]', '[SCREEN]', '[KNOWLEDGE]'),
      fc.constantFrom(...P11_PAYLOADS),
      fc.hexaString({ minLength: 4, maxLength: 8 }),
    )
    .map(([label, payload, tag]): P11Segment => ({
      label,
      text: `ZSEG-${tag} ${label} ${payload} <end>`,
    })),
  { minLength: 1, maxLength: 5 },
);

const P11_ENTITIES: readonly RedactionEntity[] = [
  'email',
  'phone',
  'credit-card',
  'iban',
  'us-ssn',
];

/**
 * User-defined rule sets, including the empty one: applying zero rules over
 * every segment is a *completed* application, so `ruleCount: 0` is a
 * legitimate success and must not be mistaken for "redaction did not run".
 */
const arbP11Rules = fc.oneof(
  { weight: 1, arbitrary: fc.constant<RedactionRule[]>([]) },
  {
    weight: 3,
    arbitrary: fc
      .uniqueArray(fc.constantFrom(...P11_ENTITIES), { minLength: 1, maxLength: 5 })
      .map((entities): RedactionRule[] =>
        entities.map((entity) => ({ kind: 'entity', entity })),
      ),
  },
  {
    weight: 1,
    arbitrary: fc.constant<RedactionRule[]>([
      { kind: 'regex', pattern: 'ZSEG-[0-9a-f]+', flags: 'g', replacement: '[REDACTED:TAG]' },
    ]),
  },
);

/**
 * The attestation space, generated adversarially. `valid` is the only shape
 * that may reach the network; every other shape — the field absent, the field
 * explicitly `undefined`, `applied: false` crossed with equal and unequal
 * segment counts, and `applied: true` with a count mismatch in *either*
 * direction (`segmentsRedacted > segmentsTotal` is as much a mismatch as
 * `<`, and means the counter is untrustworthy) — must produce zero egress.
 */
type P11AttestationKind =
  | 'valid'
  | 'absent'
  | 'explicit-undefined'
  | 'not-applied-equal'
  | 'not-applied-under'
  | 'not-applied-over'
  | 'applied-under'
  | 'applied-over';

const arbP11AttestationKind = fc.oneof(
  { weight: 4, arbitrary: fc.constant<P11AttestationKind>('valid') },
  { weight: 1, arbitrary: fc.constant<P11AttestationKind>('absent') },
  { weight: 1, arbitrary: fc.constant<P11AttestationKind>('explicit-undefined') },
  { weight: 1, arbitrary: fc.constant<P11AttestationKind>('not-applied-equal') },
  { weight: 1, arbitrary: fc.constant<P11AttestationKind>('not-applied-under') },
  { weight: 1, arbitrary: fc.constant<P11AttestationKind>('not-applied-over') },
  { weight: 1, arbitrary: fc.constant<P11AttestationKind>('applied-under') },
  { weight: 1, arbitrary: fc.constant<P11AttestationKind>('applied-over') },
);

/** Builds the attestation for a kind, given the true segment count. */
function buildP11Attestation(
  kind: Exclude<P11AttestationKind, 'absent' | 'explicit-undefined'>,
  total: number,
  ruleCount: number,
): RedactionAttestation {
  switch (kind) {
    case 'valid':
      return { applied: true, ruleCount, segmentsTotal: total, segmentsRedacted: total };
    case 'not-applied-equal':
      return { applied: false, ruleCount, segmentsTotal: total, segmentsRedacted: total };
    case 'not-applied-under':
      return { applied: false, ruleCount, segmentsTotal: total + 1, segmentsRedacted: total };
    case 'not-applied-over':
      return { applied: false, ruleCount, segmentsTotal: total, segmentsRedacted: total + 1 };
    case 'applied-under':
      return { applied: true, ruleCount, segmentsTotal: total + 1, segmentsRedacted: total };
    case 'applied-over':
      return { applied: true, ruleCount, segmentsTotal: total, segmentsRedacted: total + 1 };
  }
}

// Feature: custom-openai-compatible-provider, Property 11: Redaction is complete before egress, or there is no egress
//
// *For any* User-defined rule set and *for any* set of transcript,
// screen-text, and Knowledge_Base segments, the request body the
// Custom_Provider_Adapter transmits SHALL contain each segment's redacted form
// as produced by the Redaction_Engine over that rule set; and *for any* prompt
// whose redaction attestation is absent, not applied, or reports fewer
// redacted segments than total segments, the adapter SHALL issue zero HTTP
// requests to the Base_URL, SHALL reject with a redaction-incomplete error,
// and SHALL leave the local transcript, screen-text, and Knowledge_Base state
// deep-equal to its prior value.
//
// **Validates: Requirements 2.9, 2.10**

describe('Property 11: Redaction is complete before egress, or there is no egress', () => {
  it('transmits only redacted segments under a complete attestation, and issues zero requests with a content-free error otherwise', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbP11Segments,
        arbP11Rules,
        arbP11AttestationKind,
        arbBaseUrl,
        arbModelId,
        arbEntryPoint,
        async (segments, rules, kind, baseUrl, modelId, entryPoint) => {
          // The prompt Context_Builder would hand over: every segment already
          // passed through the Redaction_Engine over this rule set.
          const redacted = segments.map((s) => applyRedaction(s.text, rules));
          const fullPrompt = redacted.join('\n');

          const attestation =
            kind === 'absent' || kind === 'explicit-undefined'
              ? undefined
              : buildP11Attestation(kind, segments.length, rules.length);

          const prompt: PromptInput = {
            systemPrompt: 'You are Zule.',
            userText: 'Summarise the meeting.',
            fullPrompt,
            // 'absent' omits the field entirely; 'explicit-undefined' sets it
            // to `undefined` — both must be refused, and a `!attestation`
            // check is the only thing separating them from a passing shape.
            ...(kind === 'absent' ? {} : { redaction: attestation }),
          };

          // Stand-in for the local stores the refused text lives in. The
          // adapter holds no state and never touches IndexedDB, so this
          // snapshot is the machine-checkable reading of "retain the unsent
          // text in local storage unmodified".
          const localStore = {
            transcript: segments.filter((s) => s.label === '[AUDIO]').map((s) => s.text),
            screen: segments.filter((s) => s.label === '[SCREEN]').map((s) => s.text),
            knowledgeBase: segments
              .filter((s) => s.label === '[KNOWLEDGE]')
              .map((s) => s.text),
          };
          const before = JSON.stringify(localStore);

          const { impl, calls } = makeRecordingFetch(() =>
            entryPoint === 'stream'
              ? makeStreamResponse([SSE_HAPPY_PATH])
              : makeJsonResponse({
                  choices: [{ message: { content: 'ok' } }],
                  usage: { prompt_tokens: 5, completion_tokens: 1 },
                }),
          );

          const adapter = new CustomOpenAICompatibleAdapter({
            baseUrl,
            modelId,
            apiKey: 'sk-p11-property-key',
            fetchImpl: impl,
            telemetrySink: () => {},
          });

          if (kind === 'valid') {
            // --- Egress clause: the body carries the redacted forms --------
            if (entryPoint === 'stream') {
              const cb = collectingCallbacks();
              await adapter.streamGenerate(prompt, cb, NO_OPTS);
              expect(cb.errors).toEqual([]);
              expect(cb.completions).toBe(1);
            } else {
              await adapter.complete(prompt, NO_OPTS);
            }

            expect(calls).toHaveLength(1);
            const serialised = String(calls[0].init?.body);
            const parsed = JSON.parse(serialised) as {
              messages: Array<{ role: string; content: string }>;
            };
            const userContent = parsed.messages.find((m) => m.role === 'user')?.content;

            for (let i = 0; i < segments.length; i += 1) {
              // Each segment's redacted form is present …
              expect(userContent).toContain(redacted[i]);
              // … and its unredacted form is not, whenever the rule set
              // actually changed it.
              if (redacted[i] !== segments[i].text) {
                expect(serialised).not.toContain(segments[i].text);
              }
            }
            return;
          }

          // --- Refusal clause: zero egress on both entry points ------------
          const failures: unknown[] = [];
          const cb = collectingCallbacks();

          try {
            await adapter.complete(prompt, NO_OPTS);
            throw new Error('complete resolved despite an incomplete attestation');
          } catch (err) {
            failures.push(err);
          }
          try {
            await adapter.streamGenerate(prompt, cb, NO_OPTS);
            throw new Error('streamGenerate resolved despite an incomplete attestation');
          } catch (err) {
            failures.push(err);
          }

          // Zero HTTP requests to the Base_URL, for either entry point.
          expect(calls).toHaveLength(0);
          expect(impl).not.toHaveBeenCalled();
          expect(cb.completions).toBe(0);
          expect(cb.errors).toEqual([]);

          // A redaction-incomplete error, naming the refused provider.
          expect(failures).toHaveLength(2);
          for (const failure of failures) {
            expect(failure).toBeInstanceOf(RedactionIncompleteError);
            const err = failure as RedactionIncompleteError;
            expect(err.code).toBe('REDACTION_INCOMPLETE');
            expect(err.providerId).toBe('custom');

            // Content-free: no prompt text of any kind escapes through the
            // error surface.
            for (const emitted of emittedStrings(err)) {
              expect(emitted).not.toContain('ZSEG');
              expect(emitted).not.toContain(fullPrompt);
              for (let i = 0; i < segments.length; i += 1) {
                expect(emitted).not.toContain(segments[i].text);
                expect(emitted).not.toContain(redacted[i]);
              }
            }
          }

          // The unsent text is untouched.
          expect(JSON.stringify(localStore)).toBe(before);
        },
      ),
      { numRuns: 100 },
    );
  });
});
