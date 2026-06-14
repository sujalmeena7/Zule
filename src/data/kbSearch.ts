// ============================================
// Zule AI — Knowledge_Base Search (pure helper)
// ============================================
//
// Pure ranking function used by `database.search` to filter and rank
// Knowledge_Base chunks against a query embedding. Lifting this out of
// `database.ts` keeps the I/O wrapper trivial and makes the cosine
// + threshold + maxResults algebra directly property-testable
// (Property 17, Requirement 6.5).
//
// Acceptance criteria covered:
//
//   - 6.5 — Knowledge_Base search exposes the cosine-similarity
//     threshold and `maxResults` as parameters; defaults to 0.40 / 5.
//
// Property covered:
//
//   - 17: Vector_Index search bounds and threshold are honoured.

import type { KBChunk, KBDocument } from './database';

/**
 * Default cosine-similarity threshold (Requirement 6.5). Chunks with
 * a similarity strictly below this value are excluded from the result
 * set. The legacy hard-coded threshold was 0.4; this constant pins the
 * documented default and lets callers / Settings override it.
 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.4;

/**
 * Default number of top-similarity chunks returned (Requirement 6.5).
 * The legacy default was 3; design.md §"Components and Interfaces — 7.
 * Vector_Index" raises it to 5 so the Context_Builder has more material
 * to fit into the token budget when it can.
 */
export const DEFAULT_MAX_RESULTS = 5;

/**
 * Configurable search parameters exposed by `database.search`. Both
 * fields are optional; missing fields fall back to the defaults above.
 *
 * `similarityThreshold` is treated as a *minimum* — chunks whose
 * cosine similarity to the query vector is `>= threshold` are kept,
 * matching the design's "above 0.4" wording with the inclusive
 * convention used everywhere else in the codebase (see
 * `vectorMath.cosineSimilarity` semantics).
 *
 * `maxResults` is clamped at the call site by `Math.max(0, ...)` so
 * negative or non-integer overrides cannot blow past the array bounds
 * silently; pass `0` to disable the search entirely.
 */
export interface KBSearchOptions {
  similarityThreshold?: number;
  maxResults?: number;
}

/**
 * Decode a stored chunk to a plain `number[]` vector regardless of
 * whether it was persisted in the raw `vector` shape or the int8
 * `vectorQ` shape (Requirement 6.4). Callers inject this so the pure
 * helper does not depend on the Vector_Index module.
 */
export type ChunkVectorDecoder = (chunk: KBChunk) => number[] | null;

/**
 * Cosine-similarity callback. Injected so the helper can be tested
 * against deterministic stubs without standing up the Transformers.js
 * pipeline (Property 17 strategy: simulate cosine via a deterministic
 * stub).
 */
export type SimilarityFn = (a: number[], b: number[]) => number;

/**
 * Filter and rank Knowledge_Base chunks against a query vector.
 *
 * Behaviour:
 *
 *   1. Iterate every chunk across every document.
 *   2. Decode the chunk vector (`decodeChunkVector`); skip on failure.
 *   3. Compute `similarity(queryVector, chunkVector)` and keep the
 *      chunk iff the score is `>= similarityThreshold`.
 *   4. Sort kept chunks by score descending. The sort is stable on
 *      engines that ship a stable `Array.prototype.sort` (every modern
 *      browser since 2018 + V8 / SpiderMonkey / JavaScriptCore), so
 *      chunks with identical scores retain their original document /
 *      chunk order — this is what the property test expects.
 *   5. Return the top `maxResults` chunk *texts*. The original chunk
 *      objects never leave this module; callers receive a `string[]`
 *      so they can interpolate the text directly into a prompt.
 *
 * Pure: no module-level state read or written, no side effects.
 *
 * @param documents - readonly snapshot of the Knowledge_Base
 * @param queryVector - the query embedding to score against
 * @param decodeChunkVector - chunk → vector decoder (raw or quantized)
 * @param similarity - cosine-similarity implementation
 * @param opts - optional `similarityThreshold` / `maxResults` overrides
 */
export function searchChunks(
  documents: readonly KBDocument[],
  queryVector: number[],
  decodeChunkVector: ChunkVectorDecoder,
  similarity: SimilarityFn,
  opts?: KBSearchOptions,
): string[] {
  const threshold =
    opts?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const maxResultsRaw = opts?.maxResults ?? DEFAULT_MAX_RESULTS;
  // Clamp to a non-negative integer floor. `Number.isFinite` excludes
  // `Infinity` and `NaN` so a corrupted Settings value cannot blow up
  // `Array.prototype.slice` with a non-finite length.
  const maxResults =
    Number.isFinite(maxResultsRaw) && maxResultsRaw > 0
      ? Math.floor(maxResultsRaw)
      : 0;

  if (maxResults === 0) return [];

  const ranked: { text: string; score: number }[] = [];
  for (const doc of documents) {
    for (const chunk of doc.chunks) {
      const vec = decodeChunkVector(chunk);
      if (!vec || vec.length === 0) continue;
      const score = similarity(queryVector, vec);
      if (score >= threshold) {
        ranked.push({ text: chunk.text, score });
      }
    }
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, maxResults).map((r) => r.text);
}
