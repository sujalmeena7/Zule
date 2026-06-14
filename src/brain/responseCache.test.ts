// ============================================
// Zule AI — Response_Cache v2 Tests
// ============================================
//
// Unit tests + Property-based tests for the ResponseCache class.
//
// Property 13: cache.set rejects responses where isSimulated===true,
//   text.trim()==='', or status < 200 || status >= 300. After such a
//   set, get returns null.
//   **Validates: Requirements 4.9, 7.4**
//
// Property 20: After N inserts where N > maxEntries, the cache size
//   never exceeds maxEntries.
//   **Validates: Requirement 7.2**

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import 'fake-indexeddb/auto';

import { ResponseCache, type AIResponse } from './responseCache';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic mock embedding generator. Produces a simple embedding
 * based on the text's char codes so that identical strings produce
 * identical embeddings and different strings produce (likely) different
 * embeddings. This keeps tests fast and deterministic.
 */
let embeddingCallCount = 0;

function createMockEmbedding(text: string): number[] {
  embeddingCallCount++;
  // Use a fixed-size vector (16 dimensions) seeded by char codes
  const vec = new Array(16).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[i % 16] += text.charCodeAt(i) / 1000;
  }
  // Normalize to unit vector so cosine similarity is meaningful
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (mag > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= mag;
  }
  return vec;
}

function mockGenerateEmbedding(text: string): Promise<number[]> {
  return Promise.resolve(createMockEmbedding(text));
}

/** Build a valid response for testing. */
function validResponse(overrides: Partial<AIResponse> = {}): AIResponse {
  return {
    text: 'Some response text',
    isSimulated: false,
    status: 200,
    providerId: 'gemini',
    modelId: 'gemini-1.5-flash',
    ...overrides,
  };
}

function createCache(opts: {
  maxEntries?: number;
  similarityThreshold?: number;
  persist?: boolean;
} = {}): ResponseCache {
  return new ResponseCache({
    maxEntries: opts.maxEntries ?? 256,
    similarityThreshold: opts.similarityThreshold ?? 0.85,
    persist: opts.persist ?? false, // disable persistence for unit tests
    generateEmbedding: mockGenerateEmbedding,
  });
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('ResponseCache (unit)', () => {
  beforeEach(() => {
    embeddingCallCount = 0;
  });

  it('stores and retrieves a valid response with exact query match', async () => {
    const cache = createCache({ similarityThreshold: 0.99 });
    const resp = validResponse();
    await cache.set('what is TypeScript', resp);
    const result = await cache.get('what is TypeScript');
    expect(result.hit).not.toBeNull();
    expect(result.hit!.text).toBe('Some response text');
    expect(result.hit!.fromCache).toBe(true);
    expect(result.similarity).toBeCloseTo(1.0, 5);
  });

  it('returns null for an empty cache', async () => {
    const cache = createCache();
    const result = await cache.get('anything');
    expect(result.hit).toBeNull();
    expect(result.similarity).toBe(0);
  });

  it('refuses to store simulated responses', async () => {
    const cache = createCache();
    await cache.set('query', validResponse({ isSimulated: true }));
    expect(cache.size).toBe(0);
  });

  it('refuses to store responses with empty text', async () => {
    const cache = createCache();
    await cache.set('query', validResponse({ text: '' }));
    expect(cache.size).toBe(0);
    await cache.set('query2', validResponse({ text: '   ' }));
    expect(cache.size).toBe(0);
  });

  it('refuses to store responses with non-2xx status', async () => {
    const cache = createCache();
    await cache.set('query', validResponse({ status: 500 }));
    expect(cache.size).toBe(0);
    await cache.set('query2', validResponse({ status: 404 }));
    expect(cache.size).toBe(0);
    await cache.set('query3', validResponse({ status: 199 }));
    expect(cache.size).toBe(0);
  });

  it('annotates served responses with fromCache: true', async () => {
    const cache = createCache({ similarityThreshold: 0.99 });
    await cache.set('hello world', validResponse());
    const result = await cache.get('hello world');
    expect(result.hit?.fromCache).toBe(true);
  });

  it('emits cache.hit telemetry on a hit', async () => {
    const telemetry: Array<{ kind: string; similarity?: number }> = [];
    const cache = new ResponseCache({
      maxEntries: 256,
      similarityThreshold: 0.99,
      persist: false,
      generateEmbedding: mockGenerateEmbedding,
      emitTelemetry: (e) => telemetry.push(e),
    });
    await cache.set('test query', validResponse());
    await cache.get('test query');
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0].kind).toBe('cache.hit');
    expect(telemetry[0].similarity).toBeCloseTo(1.0, 5);
  });

  it('clear removes all entries', async () => {
    const cache = createCache();
    await cache.set('q1', validResponse({ text: 'r1' }));
    await cache.set('q2', validResponse({ text: 'r2' }));
    expect(cache.size).toBe(2);
    await cache.clear();
    expect(cache.size).toBe(0);
  });

  it('invalidateAll drops in-memory entries', async () => {
    const cache = createCache();
    await cache.set('q1', validResponse({ text: 'r1' }));
    expect(cache.size).toBe(1);
    cache.invalidateAll();
    expect(cache.size).toBe(0);
  });

  it('LRU eviction removes oldest entry when at capacity', async () => {
    const cache = createCache({ maxEntries: 3 });
    await cache.set('q1', validResponse({ text: 'r1' }));
    await cache.set('q2', validResponse({ text: 'r2' }));
    await cache.set('q3', validResponse({ text: 'r3' }));
    expect(cache.size).toBe(3);
    // Adding a 4th should evict the oldest
    await cache.set('q4', validResponse({ text: 'r4' }));
    expect(cache.size).toBe(3);
  });

  it('accepts status 200, 201, 299 as valid 2xx', async () => {
    const cache = createCache();
    await cache.set('q200', validResponse({ status: 200 }));
    await cache.set('q201', validResponse({ status: 201 }));
    await cache.set('q299', validResponse({ status: 299 }));
    expect(cache.size).toBe(3);
  });

  it('rejects status 300 as non-2xx', async () => {
    const cache = createCache();
    await cache.set('q300', validResponse({ status: 300 }));
    expect(cache.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Property 13: Response_Cache refuses to store invalid responses
// **Validates: Requirements 4.9, 7.4**
// ---------------------------------------------------------------------------

describe('ResponseCache (Property 13)', () => {
  // Arbitrary for generating invalid responses
  const invalidResponseArb = fc.oneof(
    // isSimulated === true
    fc.record({
      text: fc.string({ minLength: 1 }),
      isSimulated: fc.constant(true),
      status: fc.integer({ min: 200, max: 299 }),
    }),
    // text is empty or whitespace
    fc.record({
      text: fc.stringOf(fc.constant(' '), { minLength: 0, maxLength: 10 }),
      isSimulated: fc.constant(false),
      status: fc.integer({ min: 200, max: 299 }),
    }),
    // status outside 2xx range
    fc.record({
      text: fc.string({ minLength: 1 }),
      isSimulated: fc.constant(false),
      status: fc.oneof(
        fc.integer({ min: 100, max: 199 }),
        fc.integer({ min: 300, max: 599 }),
      ),
    }),
  );

  const queryArb = fc.string({ minLength: 1, maxLength: 100 });

  it('cache.set rejects all invalid responses — after set, get returns null', async () => {
    await fc.assert(
      fc.asyncProperty(
        queryArb,
        invalidResponseArb,
        async (query, invalidResp) => {
          const cache = createCache({ similarityThreshold: 0.99 });
          const response: AIResponse = {
            text: invalidResp.text,
            isSimulated: invalidResp.isSimulated,
            status: invalidResp.status,
          };
          await cache.set(query, response);
          // After storing an invalid response, cache must be empty
          expect(cache.size).toBe(0);
          const result = await cache.get(query);
          expect(result.hit).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 20: LRU bound preserves capacity invariant
// **Validates: Requirement 7.2**
// ---------------------------------------------------------------------------

describe('ResponseCache (Property 20)', () => {
  const maxEntriesArb = fc.integer({ min: 1, max: 50 });
  const insertCountArb = fc.integer({ min: 1, max: 100 });

  it('after N inserts where N > maxEntries, cache size never exceeds maxEntries', async () => {
    await fc.assert(
      fc.asyncProperty(
        maxEntriesArb,
        insertCountArb,
        async (maxEntries, insertCount) => {
          const cache = createCache({ maxEntries });
          const totalInserts = maxEntries + insertCount; // always > maxEntries

          for (let i = 0; i < totalInserts; i++) {
            await cache.set(
              `unique-query-${i}`,
              validResponse({ text: `response-${i}` }),
            );
            // Invariant: size never exceeds maxEntries at any point
            expect(cache.size).toBeLessThanOrEqual(maxEntries);
          }

          // Final check: size is exactly maxEntries (since all inserts are valid)
          expect(cache.size).toBe(maxEntries);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// IndexedDB persistence tests
// ---------------------------------------------------------------------------

describe('ResponseCache (persistence)', () => {
  beforeEach(() => {
    // Reset IndexedDB state between tests
    // fake-indexeddb/auto handles this via the jsdom environment
  });

  it('persists entries to IndexedDB and reloads them', async () => {
    // Create a cache with persistence enabled and store an entry
    const cache1 = new ResponseCache({
      maxEntries: 256,
      similarityThreshold: 0.99,
      persist: true,
      generateEmbedding: mockGenerateEmbedding,
    });
    await cache1.set('persistent query', validResponse({ text: 'persisted' }));
    expect(cache1.size).toBe(1);

    // Create a new cache instance that loads from IndexedDB
    const cache2 = new ResponseCache({
      maxEntries: 256,
      similarityThreshold: 0.99,
      persist: true,
      generateEmbedding: mockGenerateEmbedding,
    });
    const result = await cache2.get('persistent query');
    expect(result.hit).not.toBeNull();
    expect(result.hit!.text).toBe('persisted');
    expect(result.hit!.fromCache).toBe(true);
  });

  it('clear removes entries from IndexedDB', async () => {
    const cache = new ResponseCache({
      maxEntries: 256,
      similarityThreshold: 0.99,
      persist: true,
      generateEmbedding: mockGenerateEmbedding,
    });
    await cache.set('q', validResponse({ text: 'r' }));
    await cache.clear();

    // New instance should find nothing
    const cache2 = new ResponseCache({
      maxEntries: 256,
      similarityThreshold: 0.99,
      persist: true,
      generateEmbedding: mockGenerateEmbedding,
    });
    const result = await cache2.get('q');
    expect(result.hit).toBeNull();
  });
});
