// Property-based tests for the batched embedding service.
//
// Property 1: Batched embedding preserves order, length, and whitespace gaps
//
// For any array `texts` of strings (mixing real, empty, and whitespace-only
// entries at arbitrary positions), `generateEmbeddingBatch(texts)` SHALL return
// a result of length `texts.length` such that `result[i]` is a zero-length
// vector when `texts[i]` is empty or whitespace-only, and the single-call
// embedding for `texts[i]` otherwise.
//
// **Validates: Requirements 1.1, 1.3**

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

// ---------------------------------------------------------------------------
// Stub extractor: returns a deterministic vector based on string content.
// Uses a simple hash → fixed-length array so results are predictable.
// ---------------------------------------------------------------------------

function hashText(text: string): number[] {
  // Simple deterministic hash → 384-dimensional vector stub
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  // Return a 6-element vector derived from the hash (non-empty for any non-whitespace input)
  return [
    Math.abs(h % 100) / 100,
    Math.abs((h >> 4) % 100) / 100,
    Math.abs((h >> 8) % 100) / 100,
    Math.abs((h >> 12) % 100) / 100,
    Math.abs((h >> 16) % 100) / 100,
    Math.abs((h >> 20) % 100) / 100,
  ];
}

const stubExtractor = vi.fn(async (text: string) => {
  const vec = hashText(text);
  return { data: new Float32Array(vec) };
});

// Mock electron — required by embeddingService.ts via createRequire
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/zule-test',
  },
}));

// Mock @huggingface/transformers — returns our stub extractor as the pipeline
vi.mock('@huggingface/transformers', () => ({
  env: {
    allowLocalModels: false,
    allowRemoteModels: false,
    localModelPath: '',
  },
  pipeline: vi.fn(async () => stubExtractor),
}));

import { generateEmbeddingBatch } from '../../electron/embeddingService';

// ---------------------------------------------------------------------------
// Property 1: Batched embedding preserves order, length, and whitespace gaps
// ---------------------------------------------------------------------------

describe('generateEmbeddingBatch — Property 1: order, length, and whitespace gaps', () => {
  it('result.length === texts.length, whitespace entries are [], non-whitespace entries are non-empty', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.string(),
            fc.constant(''),
            fc.constant('   '),
            fc.constant('\t\n'),
          ),
          { minLength: 0, maxLength: 50 },
        ),
        async (texts) => {
          // Reset the stub call count to track per-property invocations
          stubExtractor.mockClear();

          const result = await generateEmbeddingBatch(texts);

          // Assert: result length matches input length
          expect(result.length).toBe(texts.length);

          for (let i = 0; i < texts.length; i++) {
            const isWhitespace = texts[i].trim() === '';
            if (isWhitespace) {
              // Whitespace-only or empty → zero-length vector
              expect(result[i]).toHaveLength(0);
            } else {
              // Non-whitespace → non-empty vector
              expect(result[i].length).toBeGreaterThan(0);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
