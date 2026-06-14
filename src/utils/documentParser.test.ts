// ============================================
// Zule AI — Document_Parser tests
// ============================================
//
// Covers the unit and property-based tests for the chunker, the
// paragraph splitter, and the extension validator. Property numbers
// refer to design.md §"Correctness Properties":
//
//   * Property 56 — chunker round-trip preserves words in order
//                  (Requirement 25.5)
//   * Property 57 — token-aware chunker respects size
//                  (Requirement 25.4)
//   * Property 58 — DOCX paragraph preservation
//                  (Requirement 25.2)
//   * Property 59 — extension validation is total
//                  (Requirements 25.3, 18.7)
//
// PDF / DOCX file-level parsing is intentionally NOT covered here:
// those code paths exercise pdfjs-dist and mammoth, which require real
// binary fixtures and a browser-like worker environment. The
// `paragraphs()` helper is the unit under test for the DOCX paragraph
// invariant (Property 58 / Requirement 25.2) — `parseDOCX` is a thin
// wrapper around `mammoth.extractRawText` that hands its output to
// `paragraphs()` at the call-site.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  SUPPORTED_EXTENSIONS,
  chunkText,
  dedupOverlap,
  paragraphs,
  validateExtension,
} from './documentParser';

// ---------------------------------------------------------------------
// Local helpers — match the chunker's internal `tokenizeWords` so the
// round-trip property is expressed in terms of the same word notion.
// ---------------------------------------------------------------------

const tokenizeWords = (s: string): string[] =>
  s.split(/\s+/u).filter((w) => w.length > 0);

// ---------------------------------------------------------------------
// chunkText — unit tests
// ---------------------------------------------------------------------

describe('chunkText — unit', () => {
  it('returns [] for empty input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\t  ')).toEqual([]);
  });

  it('returns one chunk for input shorter than the chunk size', () => {
    expect(chunkText('one two three', { chunkSize: 10, overlap: 2 })).toEqual([
      'one two three',
    ]);
  });

  it('produces overlapping chunks for input longer than chunkSize', () => {
    const text = 'a b c d e f g h i j';
    const chunks = chunkText(text, { chunkSize: 5, overlap: 2 });
    expect(chunks).toEqual(['a b c d e', 'd e f g h', 'g h i j']);
  });

  it('rejects non-positive chunkSize', () => {
    expect(() => chunkText('a b c', { chunkSize: 0 })).toThrow(RangeError);
    expect(() => chunkText('a b c', { chunkSize: -1 })).toThrow(RangeError);
  });

  it('rejects overlap outside [0, chunkSize)', () => {
    expect(() => chunkText('a b c', { chunkSize: 5, overlap: -1 })).toThrow(RangeError);
    expect(() => chunkText('a b c', { chunkSize: 5, overlap: 5 })).toThrow(RangeError);
    expect(() => chunkText('a b c', { chunkSize: 5, overlap: 6 })).toThrow(RangeError);
  });

  it('uses the default 300 / 50 parameters when none are supplied', () => {
    const words = Array.from({ length: 600 }, (_, k) => `w${k}`);
    const chunks = chunkText(words.join(' '));
    // Step = 300 - 50 = 250. Chunks at offsets 0, 250, 500.
    expect(chunks).toHaveLength(3);
    expect(tokenizeWords(chunks[0])).toHaveLength(300);
    expect(tokenizeWords(chunks[1])).toHaveLength(300);
    // Last chunk runs to end-of-input.
    expect(tokenizeWords(chunks[2])).toHaveLength(100);
  });
});

// ---------------------------------------------------------------------
// Property 56 — chunker round-trip preserves words in order
// (Requirement 25.5)
//
// For any plain-text input s and any (chunkSize, overlap) with
// 0 < overlap < chunkSize, the dedup-of-overlap reconstruction
// recovers the original whitespace-separated word sequence verbatim.
// ---------------------------------------------------------------------

describe('chunkText — Property 56: round-trip preserves words in order', () => {
  it('dedupOverlap(chunkText(s, opts)).join(" ") tokenises back to tokenizeWords(s)', () => {
    fc.assert(
      fc.property(
        // Words are non-empty strings drawn from a small alphabet so
        // the test is fast and the failure shrinking yields readable
        // counterexamples.
        fc.array(
          fc
            .stringMatching(/^[a-zA-Z0-9]+$/)
            .filter((s) => s.length > 0 && s.length <= 8),
          { minLength: 0, maxLength: 200 },
        ),
        // chunkSize ∈ [2, 50], overlap ∈ [1, chunkSize - 1] — the
        // non-degenerate regime the requirement specifies.
        fc.integer({ min: 2, max: 50 }),
        fc.integer({ min: 1, max: 49 }),
        (words, chunkSize, rawOverlap) => {
          const overlap = (rawOverlap % (chunkSize - 1)) + 1;
          const text = words.join(' ');

          const chunks = chunkText(text, { chunkSize, overlap });
          const dedup = dedupOverlap(chunks, overlap);
          const reconstructed = tokenizeWords(dedup.join(' '));

          expect(reconstructed).toEqual(tokenizeWords(text));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('produces no chunk longer than chunkSize words in the fallback path', () => {
    // Closely related sanity invariant: the word-mode chunker honours
    // its own size bound. (The dedicated token-mode bound test is
    // Property 57 below.)
    fc.assert(
      fc.property(
        fc.array(
          fc
            .stringMatching(/^[a-zA-Z0-9]+$/)
            .filter((s) => s.length > 0 && s.length <= 8),
          { minLength: 0, maxLength: 200 },
        ),
        fc.integer({ min: 2, max: 50 }),
        fc.integer({ min: 1, max: 49 }),
        (words, chunkSize, rawOverlap) => {
          const overlap = (rawOverlap % (chunkSize - 1)) + 1;
          const chunks = chunkText(words.join(' '), { chunkSize, overlap });
          for (const c of chunks) {
            expect(tokenizeWords(c).length).toBeLessThanOrEqual(chunkSize);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------
// Property 57 — token-aware chunker respects size
// (Requirement 25.4)
//
// For every chunk produced by `chunkText(s, { ..., countTokens })`,
// `countTokens(chunk) <= chunkSize`, provided no individual word
// tokenises to more than `chunkSize` tokens. The test uses a
// deterministic char-count tokenizer so the precondition is enforceable
// at generator time.
// ---------------------------------------------------------------------

describe('chunkText — Property 57: token-aware chunker respects size', () => {
  it('no chunk exceeds chunkSize tokens under a char-count tokenizer', () => {
    // `countTokens(s) = s.length` — strictly monotone in the number of
    // characters, so the property is meaningful for any input where
    // each individual word has length <= chunkSize.
    const countTokens = (s: string): number => s.length;

    fc.assert(
      fc.property(
        // Words are length-bounded so the per-word precondition holds.
        fc.array(
          fc
            .stringMatching(/^[a-zA-Z0-9]+$/)
            .filter((s) => s.length >= 1 && s.length <= 4),
          { minLength: 0, maxLength: 100 },
        ),
        // chunkSize >= 8 so any word (max len 4) plus a separating
        // space fits comfortably and the chunker has room to grow each
        // chunk past a single word.
        fc.integer({ min: 8, max: 60 }),
        fc.integer({ min: 1, max: 59 }),
        (words, chunkSize, rawOverlap) => {
          const overlap = (rawOverlap % (chunkSize - 1)) + 1;
          const chunks = chunkText(words.join(' '), {
            chunkSize,
            overlap,
            countTokens,
          });
          for (const c of chunks) {
            expect(countTokens(c)).toBeLessThanOrEqual(chunkSize);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('still emits a chunk for each input under the default 300-token budget', () => {
    // Smoke-check the realistic path: a sentence-transformer-style
    // tokenizer that approximates one token per ~4 characters.
    const countTokens = (s: string): number => Math.ceil(s.length / 4);
    const text = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(80);
    const chunks = chunkText(text, { chunkSize: 300, overlap: 50, countTokens });
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(countTokens(c)).toBeLessThanOrEqual(300);
    }
  });
});

// ---------------------------------------------------------------------
// Property 58 — DOCX paragraph preservation
// (Requirement 25.2)
//
// `paragraphs("p1\n\np2\n\np3")` returns `['p1', 'p2', 'p3']`. The
// property generalises this: for any list of non-empty paragraphs that
// contain no `\n\n` substring, `paragraphs(joinWith\n\n) === paragraphs`.
// ---------------------------------------------------------------------

describe('paragraphs — Property 58: DOCX paragraph preservation', () => {
  it('round-trips para1\\n\\npara2\\n\\npara3', () => {
    expect(paragraphs('para1\n\npara2\n\npara3')).toEqual([
      'para1',
      'para2',
      'para3',
    ]);
  });

  it('returns [] for empty input', () => {
    expect(paragraphs('')).toEqual([]);
  });

  it('drops empty paragraphs and trims whitespace', () => {
    expect(paragraphs('alpha\n\n\n\nbeta\n\n   \n\ngamma')).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  it('paragraphs(p1\\n\\np2\\n\\n...\\n\\npn) === [p1, p2, ..., pn]', () => {
    fc.assert(
      fc.property(
        fc.array(
          // Paragraph bodies are non-empty trimmed strings that do not
          // contain `\n\n` — the boundary marker — and whose trim is
          // non-empty so the round-trip is exact.
          fc
            .string({ minLength: 1, maxLength: 40 })
            .map((s) => s.replace(/\n/gu, ' ').trim())
            .filter((s) => s.length > 0),
          { minLength: 1, maxLength: 10 },
        ),
        (paras) => {
          const joined = paras.join('\n\n');
          expect(paragraphs(joined)).toEqual(paras);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------
// Property 59 — extension validation is total
// (Requirements 25.3, 18.7)
//
// `validateExtension(x)` is total: returns a boolean for every input,
// and the boolean equals `x ∈ {txt, md, json, pdf, docx}` after
// case-folding and stripping a leading `.`.
// ---------------------------------------------------------------------

describe('validateExtension — Property 59: extension validation is total', () => {
  it('accepts each member of SUPPORTED_EXTENSIONS', () => {
    for (const ext of SUPPORTED_EXTENSIONS) {
      expect(validateExtension(ext)).toBe(true);
    }
  });

  it('is case-insensitive and tolerates a leading dot', () => {
    expect(validateExtension('PDF')).toBe(true);
    expect(validateExtension('.docx')).toBe(true);
    expect(validateExtension('  .Md  ')).toBe(true);
  });

  it('rejects extensions outside the closed set', () => {
    for (const ext of ['exe', 'jpg', 'png', 'doc', 'rtf', 'csv', '']) {
      expect(validateExtension(ext)).toBe(false);
    }
  });

  it('returns boolean for any input (totality)', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        const r = validateExtension(input);
        expect(typeof r).toBe('boolean');
      }),
      { numRuns: 200 },
    );
  });

  it('agrees with set membership on string inputs', () => {
    const allowed = new Set<string>(['txt', 'md', 'json', 'pdf', 'docx']);
    fc.assert(
      fc.property(fc.string({ maxLength: 12 }), (s) => {
        const normalised = s.trim().toLowerCase().replace(/^\./u, '');
        expect(validateExtension(s)).toBe(allowed.has(normalised));
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------
// dedupOverlap — sanity tests
// ---------------------------------------------------------------------

describe('dedupOverlap', () => {
  it('returns [] for an empty chunk list', () => {
    expect(dedupOverlap([], 5)).toEqual([]);
  });

  it('returns a copy unchanged when overlap is 0', () => {
    expect(dedupOverlap(['a b', 'c d'], 0)).toEqual(['a b', 'c d']);
  });

  it('drops the first `overlap` words from each non-leading chunk', () => {
    expect(dedupOverlap(['a b c d e', 'd e f g h', 'g h i j'], 2)).toEqual([
      'a b c d e',
      'f g h',
      'i j',
    ]);
  });

  it('rejects a negative overlap', () => {
    expect(() => dedupOverlap(['a'], -1)).toThrow(RangeError);
  });
});
