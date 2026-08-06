// ============================================
// Zule AI — ResponseCache Screen-Aware Extension Tests
// ============================================
//
// Unit tests for getWithFrame / setWithFrame methods.
// These validate the screen-context cache keying behavior using
// query similarity AND frame-hash Hamming distance.
//
// Requirements: 6.1, 6.2, 6.3, 6.4, 6.5

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';

import { ResponseCache, type AIResponse, type ScreenCacheKey } from './responseCache';
import { PHASH_BYTES } from '../utils/phash';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic mock embedding generator. Produces a unit-vector embedding
 * derived from char codes so identical strings yield identical embeddings.
 */
function mockGenerateEmbedding(text: string): Promise<number[]> {
  const vec = new Array(16).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[i % 16] += text.charCodeAt(i) / 1000;
  }
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (mag > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= mag;
  }
  return Promise.resolve(vec);
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

/** Create a frame hash with all zeros (baseline). */
function zeroHash(): Uint8Array {
  return new Uint8Array(PHASH_BYTES);
}

/**
 * Create a hash that differs from the zero hash by exactly `bitsFlipped` bits.
 * Flips the lowest `bitsFlipped` bits across bytes.
 */
function hashWithFlippedBits(bitsFlipped: number): Uint8Array {
  const hash = new Uint8Array(PHASH_BYTES);
  let remaining = bitsFlipped;
  for (let byteIdx = 0; byteIdx < PHASH_BYTES && remaining > 0; byteIdx++) {
    const bitsThisByte = Math.min(remaining, 8);
    hash[byteIdx] = (1 << bitsThisByte) - 1; // set lowest N bits
    remaining -= bitsThisByte;
  }
  return hash;
}

function createScreenCache(opts: {
  hashDistanceThreshold?: number;
  similarityThreshold?: number;
} = {}): ResponseCache {
  return new ResponseCache({
    maxEntries: 256,
    similarityThreshold: opts.similarityThreshold ?? 0.99,
    hashDistanceThreshold: opts.hashDistanceThreshold ?? 10,
    persist: false,
    generateEmbedding: mockGenerateEmbedding,
  });
}

// ---------------------------------------------------------------------------
// Unit tests: Screen-aware cache extension
// ---------------------------------------------------------------------------

describe('ResponseCache.getWithFrame / setWithFrame (unit)', () => {
  let cache: ResponseCache;

  beforeEach(() => {
    cache = createScreenCache({ hashDistanceThreshold: 10 });
  });

  // -------------------------------------------------------------------------
  // Req 6.1, 6.2: Cache hit when query matches AND hash within threshold
  // -------------------------------------------------------------------------

  describe('hit on matching query + hash within threshold', () => {
    it('returns a hit when query is identical and hash is identical', async () => {
      const hash = zeroHash();
      const key: ScreenCacheKey = { query: 'what is on screen', frameHash: hash };
      const resp = validResponse({ text: 'screen answer' });

      await cache.setWithFrame(key, resp);

      const result = await cache.getWithFrame({ query: 'what is on screen', frameHash: hash });
      expect(result.hit).not.toBeNull();
      expect(result.hit!.text).toBe('screen answer');
      expect(result.hit!.fromCache).toBe(true);
      expect(result.similarity).toBeCloseTo(1.0, 5);
      expect(result.hashDistance).toBe(0);
    });

    it('returns a hit when hash Hamming distance is exactly at threshold', async () => {
      const storedHash = zeroHash();
      const queryHash = hashWithFlippedBits(10); // distance = 10, threshold = 10

      const key: ScreenCacheKey = { query: 'describe this image', frameHash: storedHash };
      await cache.setWithFrame(key, validResponse({ text: 'at threshold' }));

      const result = await cache.getWithFrame({ query: 'describe this image', frameHash: queryHash });
      expect(result.hit).not.toBeNull();
      expect(result.hit!.text).toBe('at threshold');
      expect(result.hashDistance).toBe(10);
    });

    it('returns a hit when hash Hamming distance is below threshold', async () => {
      const storedHash = zeroHash();
      const queryHash = hashWithFlippedBits(5); // distance = 5, threshold = 10

      const key: ScreenCacheKey = { query: 'what text is here', frameHash: storedHash };
      await cache.setWithFrame(key, validResponse({ text: 'below threshold' }));

      const result = await cache.getWithFrame({ query: 'what text is here', frameHash: queryHash });
      expect(result.hit).not.toBeNull();
      expect(result.hit!.text).toBe('below threshold');
      expect(result.hashDistance).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // Req 6.3: Cache miss when hash Hamming distance exceeds threshold
  // -------------------------------------------------------------------------

  describe('miss on divergent hash beyond threshold', () => {
    it('returns a miss when hash Hamming distance exceeds threshold by 1', async () => {
      const storedHash = zeroHash();
      const queryHash = hashWithFlippedBits(11); // distance = 11, threshold = 10

      const key: ScreenCacheKey = { query: 'read the screen', frameHash: storedHash };
      await cache.setWithFrame(key, validResponse({ text: 'original' }));

      const result = await cache.getWithFrame({ query: 'read the screen', frameHash: queryHash });
      expect(result.hit).toBeNull();
      expect(result.hashDistance).toBe(11);
    });

    it('returns a miss when hashes are completely different (max distance)', async () => {
      const storedHash = new Uint8Array(PHASH_BYTES).fill(0x00);
      const queryHash = new Uint8Array(PHASH_BYTES).fill(0xFF); // all bits flipped = distance 64

      const key: ScreenCacheKey = { query: 'what do you see', frameHash: storedHash };
      await cache.setWithFrame(key, validResponse({ text: 'original' }));

      const result = await cache.getWithFrame({ query: 'what do you see', frameHash: queryHash });
      expect(result.hit).toBeNull();
      expect(result.hashDistance).toBe(64);
    });

    it('respects custom threshold', async () => {
      const tightCache = createScreenCache({ hashDistanceThreshold: 3 });
      const storedHash = zeroHash();
      const queryHash = hashWithFlippedBits(4); // distance = 4, threshold = 3

      const key: ScreenCacheKey = { query: 'tight threshold test', frameHash: storedHash };
      await tightCache.setWithFrame(key, validResponse({ text: 'tight' }));

      const result = await tightCache.getWithFrame({ query: 'tight threshold test', frameHash: queryHash });
      expect(result.hit).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Req 6.4: Cache miss when Frame_Hash is null
  // -------------------------------------------------------------------------

  describe('miss on null Frame_Hash', () => {
    it('returns a miss when the lookup key has null frameHash', async () => {
      const storedHash = zeroHash();
      const key: ScreenCacheKey = { query: 'what is this', frameHash: storedHash };
      await cache.setWithFrame(key, validResponse({ text: 'stored entry' }));

      const result = await cache.getWithFrame({ query: 'what is this', frameHash: null });
      expect(result.hit).toBeNull();
      expect(result.similarity).toBe(0);
      expect(result.hashDistance).toBe(64);
    });

    it('returns a miss with null frameHash even when query matches exactly', async () => {
      const key: ScreenCacheKey = { query: 'exact match query', frameHash: zeroHash() };
      await cache.setWithFrame(key, validResponse({ text: 'exact match' }));

      const result = await cache.getWithFrame({ query: 'exact match query', frameHash: null });
      expect(result.hit).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Req 6.5: Cache miss on entry stored without Frame_Hash
  // -------------------------------------------------------------------------

  describe('miss on entry stored without Frame_Hash', () => {
    it('skips entries stored via regular set (no frame hash)', async () => {
      // Store using regular set (which sets frameHash to null)
      await cache.set('what is on screen', validResponse({ text: 'non-screen entry' }));

      // Look up with a frame hash — should miss because the stored entry has no hash
      const result = await cache.getWithFrame({
        query: 'what is on screen',
        frameHash: zeroHash(),
      });
      expect(result.hit).toBeNull();
    });

    it('skips entries stored with setWithFrame using null frameHash', async () => {
      // Store with explicit null frameHash
      const key: ScreenCacheKey = { query: 'no hash entry', frameHash: null };
      await cache.setWithFrame(key, validResponse({ text: 'null hash' }));

      // Look up with a valid frame hash
      const result = await cache.getWithFrame({
        query: 'no hash entry',
        frameHash: zeroHash(),
      });
      expect(result.hit).toBeNull();
    });

    it('only matches entries that have a stored frame hash', async () => {
      // Store one entry WITHOUT frame hash (via set)
      await cache.set('mixed query', validResponse({ text: 'no-frame entry' }));

      // Store another entry WITH frame hash (via setWithFrame)
      await cache.setWithFrame(
        { query: 'mixed query', frameHash: zeroHash() },
        validResponse({ text: 'frame entry' }),
      );

      // getWithFrame should only hit the entry that has a frame hash
      const result = await cache.getWithFrame({
        query: 'mixed query',
        frameHash: zeroHash(),
      });
      expect(result.hit).not.toBeNull();
      expect(result.hit!.text).toBe('frame entry');
    });
  });
});
