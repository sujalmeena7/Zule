// ============================================
// Zule AI — modelCatalog tests
// ============================================
//
// The two probes exist so the User picks a fast model by measuring their own
// gateway instead of trusting a list baked into the binary. What these tests pin
// is therefore not "does it fetch" but the properties that make the readout
// trustworthy and the failures safe:
//
//   - the credential appears only in the `Authorization` header, and never in a
//     returned `detail` string even when the gateway echoes it back;
//   - chain-of-thought is not counted as an answer, so a thinking model cannot
//     measure as fast;
//   - every failure mode is a value, not a throw, because Settings renders it.

import { describe, expect, it, vi } from 'vitest';

import {
  extractModelIds,
  formatSpeedSample,
  listGatewayModels,
  measureModelSpeed,
  messagesEndpointToApiRoot,
} from './modelCatalog';

const BASE = 'https://gw.example.com/v1';
const KEY = 'sk-secret-value-1234';

type FetchCall = { input: RequestInfo | URL; init?: RequestInit };

function recordingFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const impl = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return Promise.resolve(handler({ input, init }));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** An SSE `Response` built from raw frame payloads, as a gateway would send. */
function sse(payloads: unknown[]): Response {
  const body = payloads
    .map((p) => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`)
    .join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

// --- extractModelIds -----------------------------------------------------

describe('extractModelIds', () => {
  it('reads the OpenAI listing shape', () => {
    expect(extractModelIds({ data: [{ id: 'b-model' }, { id: 'a-model' }] })).toEqual([
      'a-model',
      'b-model',
    ]);
  });

  it('reads the shapes self-hosted runtimes return instead', () => {
    // A bare array, a `models` key, and plain strings all appear in the wild.
    expect(extractModelIds({ models: ['x'] })).toEqual(['x']);
    expect(extractModelIds([{ id: 'y' }])).toEqual(['y']);
    expect(extractModelIds(['z'])).toEqual(['z']);
  });

  it('skips malformed rows instead of failing the whole listing', () => {
    // One bad row should not cost the User the other four hundred.
    const ids = extractModelIds({
      data: [{ id: 'good' }, null, 42, { id: '  ' }, { notAnId: true }, { id: 'good' }],
    });
    expect(ids).toEqual(['good']);
  });

  it('returns nothing for shapes it does not recognise', () => {
    for (const body of [null, undefined, 42, 'text', {}, { data: 'not-an-array' }]) {
      expect(extractModelIds(body)).toEqual([]);
    }
  });
});

// --- listGatewayModels ---------------------------------------------------

describe('listGatewayModels', () => {
  it('GETs {baseUrl}/models with the credential only in the Authorization header', async () => {
    const { impl, calls } = recordingFetch(() => json({ data: [{ id: 'a' }] }));
    const result = await listGatewayModels({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl });

    expect(result).toEqual({ ok: true, models: ['a'] });
    expect(String(calls[0].input)).toBe('https://gw.example.com/v1/models');
    expect(calls[0].init?.method).toBe('GET');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    // Not in the URL, and there is no body to hide it in.
    expect(String(calls[0].input)).not.toContain(KEY);
    expect(calls[0].init?.body ?? '').not.toContain(KEY);
  });

  it('omits the Authorization header entirely when no key is configured', async () => {
    const { impl, calls } = recordingFetch(() => json({ data: [{ id: 'a' }] }));
    await listGatewayModels({ baseUrl: BASE, apiKey: '   ', fetchImpl: impl });
    // `Bearer ` with nothing after it is a malformed credential, not an absent one.
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('reports a bad Base URL without issuing a request', async () => {
    const { impl, calls } = recordingFetch(() => json({}));
    const result = await listGatewayModels({ baseUrl: 'not-a-url', fetchImpl: impl });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('reports the status only — never the response body', async () => {
    const { impl } = recordingFetch(() =>
      json({ error: { message: `rejected Bearer ${KEY}` } }, 401),
    );
    const result = await listGatewayModels({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl });
    expect(result).toEqual({ ok: false, detail: 'HTTP 401' });
    if (!result.ok) expect(result.detail).not.toContain(KEY);
  });

  it('treats an endpoint with no listing as a soft failure', async () => {
    // Discovery is a convenience. `ok: false` leaves the fields as free text,
    // which is exactly how they behaved before the button existed.
    const { impl } = recordingFetch(() => json({ data: [] }));
    const result = await listGatewayModels({ baseUrl: BASE, fetchImpl: impl });
    expect(result.ok).toBe(false);
  });

  it('returns a value rather than throwing when the transport fails', async () => {
    const impl = vi.fn(() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
    const result = await listGatewayModels({ baseUrl: BASE, fetchImpl: impl });
    expect(result).toEqual({ ok: false, detail: 'Network request failed' });
  });

  it('does not surface an unparseable body', async () => {
    const { impl } = recordingFetch(
      () => new Response('<html>gateway error</html>', { status: 200 }),
    );
    const result = await listGatewayModels({ baseUrl: BASE, fetchImpl: impl });
    expect(result).toEqual({ ok: false, detail: 'Response body was not valid JSON' });
  });
});

// --- measureModelSpeed ---------------------------------------------------

describe('measureModelSpeed', () => {
  it('streams a fixed prompt that carries no User data', async () => {
    const { impl, calls } = recordingFetch(() =>
      sse([{ choices: [{ delta: { content: '1 2 3 4 5' } }] }, '[DONE]']),
    );
    await measureModelSpeed({ baseUrl: BASE, apiKey: KEY, modelId: 'm', fetchImpl: impl });

    const body = JSON.parse(String(calls[0].init?.body)) as {
      model: string;
      stream: boolean;
      messages: Array<{ content: string }>;
    };
    expect(String(calls[0].input)).toBe('https://gw.example.com/v1/chat/completions');
    expect(body.model).toBe('m');
    expect(body.stream).toBe(true);
    // A literal, so the probe needs no redaction attestation and no egress gate.
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toMatch(/^Count from 1 to 40/);
  });

  it('counts the words in the answer and reports a throughput', async () => {
    const { impl } = recordingFetch(() =>
      sse([
        { choices: [{ delta: { role: 'assistant' } }] },
        { choices: [{ delta: { content: '1 2 ' } }] },
        { choices: [{ delta: { content: '3 4' } }] },
        '[DONE]',
      ]),
    );
    const result = await measureModelSpeed({ baseUrl: BASE, modelId: 'm', fetchImpl: impl });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.words).toBe(4);
      expect(result.thinking).toBe(false);
      expect(result.wordsPerSec).toBeGreaterThan(0);
      expect(result.firstWordMs).toBeGreaterThanOrEqual(0);
      expect(result.totalMs).toBeGreaterThanOrEqual(result.firstWordMs);
    }
  });

  it('does not count chain-of-thought as the answer', async () => {
    const { impl } = recordingFetch(() =>
      sse([
        { choices: [{ delta: { reasoning: 'let me consider the range' } }] },
        { choices: [{ delta: { reasoning_content: 'still considering' } }] },
        { choices: [{ delta: { content: 'one two' } }] },
        '[DONE]',
      ]),
    );
    const result = await measureModelSpeed({ baseUrl: BASE, modelId: 'm', fetchImpl: impl });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The words are the answer's words only. Counting reasoning would report a
      // deliberating model as fast, which is the opposite of the truth and the
      // whole reason the User is running this probe.
      expect(result.words).toBe(2);
      expect(result.thinking).toBe(true);
      expect(result.thinkingMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('fails when the model produced only reasoning', async () => {
    const { impl } = recordingFetch(() =>
      sse([{ choices: [{ delta: { reasoning: 'thinking forever' } }] }, '[DONE]']),
    );
    const result = await measureModelSpeed({ baseUrl: BASE, modelId: 'm', fetchImpl: impl });
    // A 200 with no answer has no first word to time, and saying so is more
    // useful than reporting zero words per second.
    expect(result).toEqual({
      ok: false,
      detail: 'The model produced only reasoning, no answer',
    });
  });

  it('requires a model id, and issues no request without one', async () => {
    const { impl, calls } = recordingFetch(() => sse(['[DONE]']));
    const result = await measureModelSpeed({ baseUrl: BASE, modelId: '  ', fetchImpl: impl });
    expect(result).toEqual({ ok: false, detail: 'Model ID is required' });
    expect(calls).toHaveLength(0);
  });

  it('reports the status only, with the credential scrubbed', async () => {
    const { impl } = recordingFetch(
      () => new Response(`no credit for Bearer ${KEY}`, { status: 402 }),
    );
    const result = await measureModelSpeed({
      baseUrl: BASE,
      apiKey: KEY,
      modelId: 'm',
      fetchImpl: impl,
    });
    expect(result).toEqual({ ok: false, detail: 'HTTP 402' });
  });

  it('survives a malformed SSE frame rather than losing the measurement', async () => {
    const { impl } = recordingFetch(() =>
      sse(['{not json', { choices: [{ delta: { content: 'answer here' } }] }, '[DONE]']),
    );
    const result = await measureModelSpeed({ baseUrl: BASE, modelId: 'm', fetchImpl: impl });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.words).toBe(2);
  });

  it('returns a value when the transport fails', async () => {
    const impl = vi.fn(() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
    const result = await measureModelSpeed({ baseUrl: BASE, modelId: 'm', fetchImpl: impl });
    expect(result).toEqual({ ok: false, detail: 'Network request failed' });
  });
});

// --- formatSpeedSample ---------------------------------------------------

describe('formatSpeedSample', () => {
  const SAMPLE = {
    firstWordMs: 900,
    totalMs: 1500,
    words: 40,
    wordsPerSec: 145.4,
    thinking: false,
    thinkingMs: 0,
  };

  it('leads with the number that decides the choice', () => {
    // Time-to-first-word first: it is what the User feels, and throughput only
    // matters once something is on screen.
    expect(formatSpeedSample(SAMPLE)).toBe('first word 0.9s · 145 words/sec');
  });

  it('says so when the model deliberated first', () => {
    expect(formatSpeedSample({ ...SAMPLE, thinking: true, thinkingMs: 31_200 })).toBe(
      'first word 0.9s · 145 words/sec · thought for 31.2s first',
    );
  });
});

describe('messagesEndpointToApiRoot', () => {
  // The Anthropic Base URL is a full endpoint the adapter POSTs verbatim, unlike
  // the Custom provider's API root. Handing it to `listGatewayModels` unchanged
  // would ask for `…/v1/messages/models`.
  it('drops a trailing /messages segment', () => {
    expect(messagesEndpointToApiRoot('https://gw.example.com/v1/messages')).toBe(
      'https://gw.example.com/v1',
    );
    expect(messagesEndpointToApiRoot('https://api.anthropic.com/v1/messages/')).toBe(
      'https://api.anthropic.com/v1',
    );
    expect(messagesEndpointToApiRoot('  https://gw.example.com/v1/MESSAGES  ')).toBe(
      'https://gw.example.com/v1',
    );
  });

  it('leaves any other layout alone', () => {
    expect(messagesEndpointToApiRoot('https://gw.example.com/v1')).toBe(
      'https://gw.example.com/v1',
    );
    // `/messages` only as a whole final segment — not as a suffix of one.
    expect(messagesEndpointToApiRoot('https://gw.example.com/v1/allmessages')).toBe(
      'https://gw.example.com/v1/allmessages',
    );
    expect(messagesEndpointToApiRoot('')).toBe('');
  });
});
