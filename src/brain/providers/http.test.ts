// ============================================
// Tests for shared provider HTTP utilities.
// ============================================
//
// **Property 10: Per-request timeout aborts when latency exceeds budget**
//
// *For all* timeout values `T > 0` and any latency `L > 0`, the wrapped
// `fetch` resolves with the response if `L < T` and rejects with an
// `AbortError` whose `signal.aborted === true` if `L > T`.
//
// **Validates: Requirements 4.4**

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fc from 'fast-check';
import {
  fetchWithTimeout,
  DEFAULT_NON_STREAMING_TIMEOUT_MS,
  DEFAULT_STREAMING_TIMEOUT_MS,
} from './http';

// Mock fetch factory that resolves after `latencyMs` and respects abort signals
// the same way the platform `fetch` does (rejects with the signal's reason as
// soon as the signal aborts). The factory exposes the most-recently observed
// signal so the test can assert that `signal.aborted === true` after a timeout.
function makeMockFetch(latencyMs: number) {
  const observed: { signal: AbortSignal | null } = { signal: null };
  const impl = vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const sig = init?.signal ?? null;
      observed.signal = sig;
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(
            new Response('{"ok":true}', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }, latencyMs);
        if (sig) {
          if (sig.aborted) {
            clearTimeout(timer);
            reject(sig.reason ?? new DOMException('Aborted', 'AbortError'));
            return;
          }
          sig.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(sig.reason ?? new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        }
      });
    },
  );
  return { impl: impl as unknown as typeof fetch, observed };
}

describe('fetchWithTimeout — defaults', () => {
  it('uses 6 000 ms for non-streaming and 12 000 ms for streaming kinds', () => {
    expect(DEFAULT_NON_STREAMING_TIMEOUT_MS).toBe(6_000);
    expect(DEFAULT_STREAMING_TIMEOUT_MS).toBe(12_000);
  });

  it('rejects when timeoutMs is non-positive', async () => {
    await expect(
      fetchWithTimeout('https://example.test', undefined, { timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      fetchWithTimeout('https://example.test', undefined, { timeoutMs: -1 }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe('fetchWithTimeout — caller signal honouring', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('aborts the underlying fetch when the caller signal aborts mid-flight', async () => {
    const { impl } = makeMockFetch(10_000);
    globalThis.fetch = impl;

    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('user-cancel')), 20);

    await expect(
      fetchWithTimeout('https://example.test', undefined, {
        timeoutMs: 5_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});

describe('fetchWithTimeout (Property 10: per-request timeout aborts when latency exceeds budget)', () => {
  // **Property 10: Per-request timeout aborts when latency exceeds budget**
  // **Validates: Requirements 4.4**

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('forall T,L>0: resolves when L<T; rejects AbortError with signal.aborted=true when L>T', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Constrained ranges keep wall-clock cost bounded while preserving a
        // generous gap (>= 50 ms) so jsdom's setTimeout jitter cannot flip
        // the relative ordering of timeout vs latency.
        fc.integer({ min: 10, max: 30 }), // shortMs
        fc.integer({ min: 100, max: 160 }), // longMs
        fc.boolean(), // shouldTimeOut
        async (shortMs, longMs, shouldTimeOut) => {
          const timeoutMs = shouldTimeOut ? shortMs : longMs;
          const latencyMs = shouldTimeOut ? longMs : shortMs;

          const { impl, observed } = makeMockFetch(latencyMs);
          globalThis.fetch = impl;

          if (shouldTimeOut) {
            // L > T  ⇒  reject with AbortError; the signal handed to fetch is aborted.
            try {
              await fetchWithTimeout('https://example.test', undefined, {
                timeoutMs,
              });
              return false; // Should have thrown.
            } catch (err) {
              const e = err as { name?: string };
              return e.name === 'AbortError' && observed.signal?.aborted === true;
            }
          } else {
            // L < T  ⇒  resolves with the underlying response.
            const res = await fetchWithTimeout('https://example.test', undefined, {
              timeoutMs,
            });
            return res.status === 200 && observed.signal?.aborted === false;
          }
        },
      ),
      { numRuns: 16 },
    );
  }, 20_000);
});
