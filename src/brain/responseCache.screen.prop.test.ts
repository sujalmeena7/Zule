// ============================================
// Zule AI — Screen-Aware Cache Property Tests
// ============================================
//
// Feature: screen-context-latency, Property 7: Screen-aware cache correctness
//
// For any query text Q and Frame_Hash H, a cache lookup with screen context
// armed SHALL return a hit if and only if:
//   (a) an entry exists whose query embedding similarity ≥ the configured threshold, AND
//   (b) the entry's stored Frame_Hash has Hamming distance ≤ the configured hash threshold from H.
// A lookup with no Frame_Hash, or against an entry stored without a Frame_Hash, SHALL always miss.
//
// **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5**

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import 'fake-indexeddb/auto';

import { ResponseCache, type AIResponse, type ScreenCacheKey } from './responseCache';
import { hammingDistance, PHASH_BYTES } from '../utils/phash';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic mock embedding generator.
 * Identical strings produce identical embeddings (cosine similarity = 1.0).
 * Different strings produce different embeddings.
 */
function createMockEmbedding(text: string): number[] {
  const vec = new Array(16).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[i % 16] += text.charCodeAt(i) / 1000;
  }
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (mag > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= mag;
  }
  return vec;
}

function mockGenerateEmbedding(text: string): Promise<number[]> {
  return Promise.resolve(createMockEmbedding(text));
}

function validResponse(text = 'cached response'): AIResponse {
  return {
    text,
    isSimulated: false,
    status: 200,
    providerId: 'test',
    modelId: 'test-model',
  };
}

function createCache(opts: { hashDistanceThreshold?: number } = {}): ResponseCache {
  return new ResponseCache({
    maxEntries: 256,
    similarityThreshold: 0.99, // Use exact match for query so we isolate hash behavior
    hashDistanceThreshold: opts.hashDistanceThreshold ?? 10,
    persist: false,
    generateEmbedding: mockGenerateEmbedding,
  });
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Generate a valid 8-byte frame hash (Uint8Array of PHASH_BYTES). */
const frameHashArb = fc.uint8Array({ minLength: PHASH_BYTES, maxLength: PHASH_BYTES });

/** Generate a non-empty query string. */
const queryArb = fc.string({ minLength: 1, maxLength: 50 });

/** Generate a Hamming distance threshold between 0 and 64. */
const thresholdArb = fc.integer({ min: 0, max: 64 });

// ---------------------------------------------------------------------------
// Property 7: Screen-aware cache correctness
// **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5**
// ---------------------------------------------------------------------------

describe('ResponseCache screen-aware cache (Property 7)', () => {
  it('cache hit occurs iff Hamming distance ≤ threshold (same query)', async () => {
    await fc.assert(
      fc.asyncProperty(
        queryArb,
        frameHashArb,
        frameHashArb,
        thresholdArb,
        async (query, storedHash, lookupHash, threshold) => {
          const cache = createCache({ hashDistanceThreshold: threshold });

          // Store an entry with a frame hash
          const storeKey: ScreenCacheKey = { query, frameHash: storedHash };
          await cache.setWithFrame(storeKey, validResponse());

          // Look up with the same query but potentially different hash
          const lookupKey: ScreenCacheKey = { query, frameHash: lookupHash };
          const result = await cache.getWithFrame(lookupKey);

          // Compute actual Hamming distance
          const actualDistance = hammingDistance(storedHash, lookupHash);

          if (actualDistance <= threshold) {
            // Req 6.2: Should be a hit
            expect(result.hit).not.toBeNull();
            expect(result.hit!.fromCache).toBe(true);
          } else {
            // Req 6.3: Should be a miss
            expect(result.hit).toBeNull();
          }

          // Verify reported hashDistance matches actual
          expect(result.hashDistance).toBe(actualDistance);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('null frame hash in lookup always results in a cache miss (Req 6.4)', async () => {
    await fc.assert(
      fc.asyncProperty(
        queryArb,
        frameHashArb,
        thresholdArb,
        async (query, storedHash, threshold) => {
          const cache = createCache({ hashDistanceThreshold: threshold });

          // Store a valid entry with a frame hash
          const storeKey: ScreenCacheKey = { query, frameHash: storedHash };
          await cache.setWithFrame(storeKey, validResponse());

          // Look up with null frame hash — must always miss
          const lookupKey: ScreenCacheKey = { query, frameHash: null };
          const result = await cache.getWithFrame(lookupKey);

          expect(result.hit).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('entry stored without frame hash never serves screen-context lookups (Req 6.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        queryArb,
        frameHashArb,
        thresholdArb,
        async (query, lookupHash, threshold) => {
          const cache = createCache({ hashDistanceThreshold: threshold });

          // Store an entry WITHOUT a frame hash (using regular set)
          await cache.set(query, validResponse());

          // Look up with getWithFrame — should always miss because stored entry has no hash
          const lookupKey: ScreenCacheKey = { query, frameHash: lookupHash };
          const result = await cache.getWithFrame(lookupKey);

          expect(result.hit).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('entry stored with null frame hash via setWithFrame never serves screen-context lookups (Req 6.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        queryArb,
        frameHashArb,
        thresholdArb,
        async (query, lookupHash, threshold) => {
          const cache = createCache({ hashDistanceThreshold: threshold });

          // Store an entry with null frame hash via setWithFrame
          const storeKey: ScreenCacheKey = { query, frameHash: null };
          await cache.setWithFrame(storeKey, validResponse());

          // Look up with getWithFrame — should always miss
          const lookupKey: ScreenCacheKey = { query, frameHash: lookupHash };
          const result = await cache.getWithFrame(lookupKey);

          expect(result.hit).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('identical hash always hits regardless of threshold (distance = 0)', async () => {
    await fc.assert(
      fc.asyncProperty(
        queryArb,
        frameHashArb,
        thresholdArb.filter((t) => t >= 0),
        async (query, hash, threshold) => {
          const cache = createCache({ hashDistanceThreshold: threshold });

          // Store with a hash
          const key: ScreenCacheKey = { query, frameHash: hash };
          await cache.setWithFrame(key, validResponse());

          // Look up with the exact same hash — distance is 0, always ≤ threshold
          const result = await cache.getWithFrame(key);
          expect(result.hit).not.toBeNull();
          expect(result.hashDistance).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('maximally different hash (distance=64) misses unless threshold is 64', async () => {
    await fc.assert(
      fc.asyncProperty(
        queryArb,
        frameHashArb,
        thresholdArb,
        async (query, storedHash, threshold) => {
          const cache = createCache({ hashDistanceThreshold: threshold });

          // Create a maximally different hash (flip all bits)
          const invertedHash = new Uint8Array(PHASH_BYTES);
          for (let i = 0; i < PHASH_BYTES; i++) {
            invertedHash[i] = storedHash[i] ^ 0xff;
          }

          const storeKey: ScreenCacheKey = { query, frameHash: storedHash };
          await cache.setWithFrame(storeKey, validResponse());

          const lookupKey: ScreenCacheKey = { query, frameHash: invertedHash };
          const result = await cache.getWithFrame(lookupKey);

          const expectedDistance = hammingDistance(storedHash, invertedHash);
          expect(result.hashDistance).toBe(expectedDistance);

          if (expectedDistance <= threshold) {
            expect(result.hit).not.toBeNull();
          } else {
            expect(result.hit).toBeNull();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
