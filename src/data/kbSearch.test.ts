// ============================================
// Zule AI — Knowledge_Base search helper tests
// ============================================
//
// Unit + property coverage for `searchChunks` / `database.search`.
// The pure helper is exercised through small example inputs first; the
// property test then validates the core algebra over arbitrary inputs
// using a deterministic similarity stub (Property 17, Requirement 6.5).

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { IDBFactory } from 'fake-indexeddb';

import {
  searchChunks,
  DEFAULT_SIMILARITY_THRESHOLD,
  DEFAULT_MAX_RESULTS,
  type ChunkVectorDecoder,
  type SimilarityFn,
} from './kbSearch';
import {
  database,
  __resetDatabaseForTests,
  type KBChunk,
  type KBDocument,
} from './database';

// Hoisted-safe mock: declare the spy via `vi.hoisted` so the factory in
// `vi.mock` can reach it. Mirrors the pattern used by
// `vectorStore.test.ts`.
const pipelineMock = vi.hoisted(() => vi.fn());
vi.mock('@huggingface/transformers', () => ({
  env: {
    allowLocalModels: false,
    allowRemoteModels: true,
    useBrowserCache: true,
    localModelPath: '',
    backends: { onnx: { wasm: {} } },
  },
  pipeline: pipelineMock,
}));

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function makeFakeExtractor(values: number[]) {
  return vi.fn(async () => ({ data: new Float32Array(values) }));
}

/** Fresh IDB factory per test so DB state never bleeds across cases. */
function resetIndexedDB(): void {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  __resetDatabaseForTests();
}

function makeDoc(
  id: string,
  type: KBDocument['type'],
  chunks: KBChunk[],
  createdAt = 0,
): KBDocument {
  return {
    id,
    title: id,
    content: chunks.map((c) => c.text).join('\n'),
    type,
    chunks,
    createdAt,
  };
}

// ---------------------------------------------------------------------
// Unit — defaults + filtering
// ---------------------------------------------------------------------

describe('searchChunks — defaults', () => {
  it('exposes the canonical 0.40 / 5 defaults from Requirement 6.5', () => {
    expect(DEFAULT_SIMILARITY_THRESHOLD).toBe(0.4);
    expect(DEFAULT_MAX_RESULTS).toBe(5);
  });

  it('returns an empty array when no chunk meets the threshold', () => {
    const docs: KBDocument[] = [
      makeDoc('a', 'notes', [
        { text: 'low-1', vector: [0.1] },
        { text: 'low-2', vector: [0.1] },
      ]),
    ];
    const result = searchChunks(
      docs,
      [1.0],
      (chunk) => chunk.vector ?? null,
      // Constant similarity well below the 0.4 default.
      () => 0.1,
    );
    expect(result).toEqual([]);
  });

  it('keeps chunks scoring exactly at the threshold (inclusive >=)', () => {
    const docs = [
      makeDoc('a', 'notes', [
        { text: 'just-at-threshold', vector: [0.4] },
      ]),
    ];
    const result = searchChunks(
      docs,
      [0.4],
      (chunk) => chunk.vector ?? null,
      // Returns exactly the threshold value.
      (a) => a[0],
      { similarityThreshold: 0.4, maxResults: 5 },
    );
    expect(result).toEqual(['just-at-threshold']);
  });

  it('sorts results by descending similarity', () => {
    const docs = [
      makeDoc('a', 'notes', [
        { text: 'low', vector: [0.5] },
        { text: 'high', vector: [0.9] },
        { text: 'mid', vector: [0.7] },
      ]),
    ];
    const result = searchChunks(
      docs,
      [1],
      (chunk) => chunk.vector ?? null,
      // Use the chunk's first component as the score.
      (_q, c) => c[0],
    );
    expect(result).toEqual(['high', 'mid', 'low']);
  });

  it('honours a custom maxResults override', () => {
    const docs = [
      makeDoc('a', 'notes', [
        { text: '1', vector: [0.9] },
        { text: '2', vector: [0.85] },
        { text: '3', vector: [0.8] },
      ]),
    ];
    const result = searchChunks(
      docs,
      [1],
      (chunk) => chunk.vector ?? null,
      (_q, c) => c[0],
      { maxResults: 2 },
    );
    expect(result).toEqual(['1', '2']);
  });

  it('clamps non-finite or negative maxResults to 0', () => {
    const docs = [
      makeDoc('a', 'notes', [{ text: 'x', vector: [0.99] }]),
    ];
    const decode: ChunkVectorDecoder = (chunk) => chunk.vector ?? null;
    const sim: SimilarityFn = (_q, c) => c[0];

    expect(
      searchChunks(docs, [1], decode, sim, { maxResults: -1 }),
    ).toEqual([]);
    expect(
      searchChunks(docs, [1], decode, sim, { maxResults: NaN }),
    ).toEqual([]);
    expect(
      searchChunks(docs, [1], decode, sim, { maxResults: Infinity }),
    ).toEqual([]);
  });

  it('skips chunks whose decoder returns null or an empty vector', () => {
    const docs = [
      makeDoc('a', 'notes', [
        { text: 'good', vector: [0.9] },
        { text: 'broken' }, // neither vector nor vectorQ
      ]),
    ];
    const result = searchChunks(
      docs,
      [1],
      (chunk) => chunk.vector ?? null,
      (_q, c) => c[0],
    );
    expect(result).toEqual(['good']);
  });
});

// ---------------------------------------------------------------------
// Property 17 — search bounds and threshold are honoured
// Validates: Requirements 6.5
// ---------------------------------------------------------------------
//
// Statement: For arbitrary documents, an arbitrary query vector, and
// arbitrary `(threshold, maxResults)` overrides, the result of
// `searchChunks` satisfies:
//
//   1. `result.length <= max(0, maxResults)`.
//   2. Every text in `result` came from some chunk whose injected
//      similarity score is `>= threshold`.
//   3. The `result` is sorted by descending similarity.
//   4. The chunks corresponding to `result` are exactly the top-N
//      by score among those that pass the threshold (no chunk with a
//      higher passing score is missing from the result while a
//      lower-scoring one is present).
//
// To keep the property tractable, similarity is simulated by a stub
// that hashes each chunk's vector to a deterministic score in [0, 1].
// This sidesteps the Transformers.js pipeline and lets fast-check
// shrink failures down to minimal counterexamples.

describe('searchChunks — Property 17: search bounds and threshold are honoured', () => {
  it(
    'every result passes the threshold and the result length is bounded by maxResults',
    () => {
      // `score(vec)` is a deterministic, bounded function of the chunk
      // vector — the property does not depend on the specific shape of
      // cosine similarity, only on the algebraic guarantees of the
      // ranking algorithm.
      const score = (vec: readonly number[]): number => {
        let s = 0;
        for (const v of vec) s += v;
        return vec.length === 0 ? 0 : s / vec.length;
      };

      const arbVector = fc.array(
        fc.double({
          min: 0,
          max: 1,
          noNaN: true,
          noDefaultInfinity: true,
        }),
        { minLength: 1, maxLength: 4 },
      );

      // Each document is described by a (type, createdAt, chunkVectors)
      // triple. We assign globally unique chunk texts after the
      // arbitrary fires so the result-to-chunk mapping is one-to-one
      // even when fast-check shrinks toward repeated values.
      const arbDocSpec = fc.record({
        type: fc.constantFrom<KBDocument['type']>(
          'resume',
          'project',
          'job-description',
          'notes',
          'sales-script',
          'custom',
        ),
        chunkVectors: fc.array(arbVector, { minLength: 0, maxLength: 5 }),
        createdAt: fc.integer({ min: 0, max: 1_000_000 }),
      });

      const arbDocSpecs = fc.array(arbDocSpec, { maxLength: 5 });

      const arbQueryVector = arbVector;

      const arbThreshold = fc.double({
        min: 0,
        max: 1,
        noNaN: true,
        noDefaultInfinity: true,
      });

      const arbMaxResults = fc.integer({ min: 0, max: 10 });

      fc.assert(
        fc.property(
          arbDocSpecs,
          arbQueryVector,
          arbThreshold,
          arbMaxResults,
          (specs, _query, threshold, maxResults) => {
            // Materialise documents with unique chunk texts. Tagging
            // by a monotonically-increasing counter guarantees that
            // every chunk is uniquely identifiable by its text in the
            // result, even though `searchChunks` returns texts only.
            let chunkCounter = 0;
            const docs: KBDocument[] = specs.map((s, i) => {
              const chunks: KBChunk[] = s.chunkVectors.map((vector) => ({
                text: `c-${chunkCounter++}`,
                vector,
              }));
              return makeDoc(`d-${i}`, s.type, chunks, s.createdAt);
            });

            const result = searchChunks(
              docs,
              _query,
              (chunk) => chunk.vector ?? null,
              (_q, c) => score(c),
              { similarityThreshold: threshold, maxResults },
            );

            // Build the canonical (text → score) map. With unique
            // texts, no chunk shares a key, so a result text is
            // guaranteed to map back to the chunk it came from.
            const scoresByText = new Map<string, number>();
            for (const doc of docs) {
              for (const chunk of doc.chunks) {
                if (!chunk.vector || chunk.vector.length === 0) continue;
                scoresByText.set(chunk.text, score(chunk.vector));
              }
            }

            // (1) Length bound.
            expect(result.length).toBeLessThanOrEqual(maxResults);

            // (2) Every returned text passes the threshold.
            for (const text of result) {
              const s = scoresByText.get(text);
              expect(s).toBeDefined();
              expect(s!).toBeGreaterThanOrEqual(threshold);
            }

            // (3) Result is sorted by score descending.
            const resultScores = result.map((t) => scoresByText.get(t)!);
            for (let i = 1; i < resultScores.length; i++) {
              expect(resultScores[i - 1]).toBeGreaterThanOrEqual(
                resultScores[i],
              );
            }

            // (4) The result is the top-`min(maxResults, |passing|)`
            // by score among passing chunks. Compare against the
            // canonical sort, comparing texts as a multiset (chunks
            // with identical scores can swap positions on stable
            // sorts only when they come from different documents —
            // both orderings are equally correct).
            const candidates: { text: string; score: number }[] = [];
            for (const doc of docs) {
              for (const chunk of doc.chunks) {
                if (!chunk.vector || chunk.vector.length === 0) continue;
                const s = score(chunk.vector);
                if (s >= threshold) candidates.push({ text: chunk.text, score: s });
              }
            }
            candidates.sort((a, b) => b.score - a.score);
            const expectedSlice = candidates
              .slice(0, maxResults)
              .map((c) => c.text);
            expect([...result].sort()).toEqual([...expectedSlice].sort());
          },
        ),
        { numRuns: 200 },
      );
    },
  );
});

// ---------------------------------------------------------------------
// `database.search` end-to-end (Requirement 6.5, 6.7 wiring)
// ---------------------------------------------------------------------

describe('database.search — end-to-end with mocked Transformers.js', () => {
  beforeEach(() => {
    resetIndexedDB();
    pipelineMock.mockReset();
  });

  afterEach(() => {
    pipelineMock.mockReset();
  });

  it('honours similarityThreshold and maxResults overrides', async () => {
    // Embedding pipeline always returns a constant vector; we drive
    // the similarity outcome by storing chunks with vectors that the
    // real cosine-similarity in `vectorStore.calculateCosineSimilarity`
    // ranks against the query.
    pipelineMock.mockResolvedValue(makeFakeExtractor([1, 0, 0]));

    // (1, 0, 0) → score 1.0 against the query.
    // (0.8, 0.6, 0) → score 0.8.
    // (0.4, 0.917, 0) ≈ score 0.4.
    // (0, 1, 0) → score 0.
    await database.addDocument('doc-A', 'a', 'notes', [
      { text: 'hit-1.0', vector: [1, 0, 0] },
      { text: 'hit-0.8', vector: [0.8, 0.6, 0] },
      { text: 'hit-0.4', vector: [0.4, 0.9165, 0] },
      { text: 'miss', vector: [0, 1, 0] },
    ]);

    const top1 = await database.search('q', { maxResults: 1 });
    expect(top1).toEqual(['hit-1.0']);

    const aboveHalf = await database.search('q', {
      similarityThreshold: 0.5,
      maxResults: 5,
    });
    expect(aboveHalf).toEqual(['hit-1.0', 'hit-0.8']);

    // Default threshold (0.4) keeps the borderline chunk; default
    // maxResults (5) admits up to five hits.
    const defaults = await database.search('q');
    expect(defaults).toEqual(['hit-1.0', 'hit-0.8', 'hit-0.4']);
  });

  it('treats a numeric second argument as { maxResults } (legacy contextManager call)', async () => {
    pipelineMock.mockResolvedValue(makeFakeExtractor([1, 0, 0]));
    await database.addDocument('doc', 'a', 'notes', [
      { text: 'a', vector: [1, 0, 0] },
      { text: 'b', vector: [0.95, 0.31, 0] },
      { text: 'c', vector: [0.9, 0.43, 0] },
    ]);
    const result = await database.search('q', 2);
    expect(result.length).toBe(2);
  });
});

// ---------------------------------------------------------------------
// removeDocument — Requirement 6.7 cache invalidation
// ---------------------------------------------------------------------

describe('database.removeDocument — invalidates the query embedding cache (Requirement 6.7)', () => {
  beforeEach(() => {
    resetIndexedDB();
    pipelineMock.mockReset();
  });

  it('clears the LRU after a document is deleted', async () => {
    pipelineMock.mockResolvedValue(makeFakeExtractor([1, 0, 0]));

    // Seed a document and run a search to populate the LRU.
    const doc = await database.addDocument('doc', 'a', 'notes', [
      { text: 't', vector: [1, 0, 0] },
    ]);
    await database.search('hello world');

    const { vectorStore } = await import('../brain/vectorStore');
    expect(vectorStore.getCacheStats().size).toBeGreaterThan(0);

    await database.removeDocument(doc.id);
    expect(vectorStore.getCacheStats().size).toBe(0);
  });
});
