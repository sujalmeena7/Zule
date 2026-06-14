// ============================================
// Zule AI — Coaching_Module tests
// ============================================
//
// Covers unit and property-based tests for `src/brain/coaching.ts`. The
// property numbers refer to design.md §"Correctness Properties":
//
//   - Property 24 (Requirements 9.5, 9.2): coaching is a pure function.
//   - Property 25 (Requirement 9.6): confidence score is bounded.
//   - Property 26 (Requirement 9.3): WPM is the formula
//                                    `Math.round(words/duration * 60)`.
//
// Tests are structured as:
//   1. Unit tests pinning the contract on representative examples
//      (filler word boundaries, WPM rounding, sentiment polarity).
//   2. Property tests exercising the contract across the input space.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  analyzeSentiment,
  calculateConfidence,
  calculateWPM,
  countFillers,
  getFullAnalysis,
  type CoachingMetrics,
} from './coaching';

// ---------------------------------------------------------------------
// analyzeSentiment — unit tests
// ---------------------------------------------------------------------

describe('analyzeSentiment', () => {
  it('returns neutral with score 0 when no lexicon words are present', () => {
    expect(analyzeSentiment('the meeting starts at noon')).toEqual({
      sentiment: 'neutral',
      score: 0,
    });
  });

  it('labels positive-only text as positive with score 1', () => {
    expect(analyzeSentiment('that was great and amazing')).toEqual({
      sentiment: 'positive',
      score: 1,
    });
  });

  it('labels negative-only text as negative with score -1', () => {
    expect(analyzeSentiment('that was bad and terrible')).toEqual({
      sentiment: 'negative',
      score: -1,
    });
  });

  it('matches lexicon words across punctuation via word boundaries', () => {
    // The original implementation split on whitespace and missed "great." —
    // the refactored version uses `\bgreat\b` so the trailing "." does not
    // prevent the match.
    expect(analyzeSentiment('Honestly, great.')).toEqual({
      sentiment: 'positive',
      score: 1,
    });
  });

  it('does not match lexicon words inside other words', () => {
    // "ungreat" should not match "great"; "harder" should not match "hard".
    expect(analyzeSentiment('ungreat performances are harder to forget')).toEqual({
      sentiment: 'neutral',
      score: 0,
    });
  });
});

// ---------------------------------------------------------------------
// countFillers — unit tests
// ---------------------------------------------------------------------

describe('countFillers', () => {
  it('returns zero matches for filler-free text', () => {
    expect(countFillers('the agenda is straightforward')).toEqual({
      count: 0,
      found: [],
    });
  });

  it('matches filler words across word boundaries', () => {
    // "drumstick um" matches "um" once; "umbrella" matches zero times.
    const result = countFillers('drumstick um umbrella');
    expect(result.count).toBe(1);
    expect(result.found).toEqual(['um']);
  });

  it('matches multi-word fillers with whitespace tolerance', () => {
    expect(countFillers('you  know what I mean')).toEqual({
      count: 2,
      found: ['you know', 'I mean'],
    });
  });

  it('is case-insensitive', () => {
    expect(countFillers('UH that is, Like, totally fine')).toEqual({
      count: 2,
      found: ['uh', 'like'],
    });
  });
});

// ---------------------------------------------------------------------
// calculateWPM — unit tests
// ---------------------------------------------------------------------

describe('calculateWPM', () => {
  it('returns Math.round(words / duration * 60) for positive durations', () => {
    expect(calculateWPM(150, 60)).toBe(150); // 150 wpm
    expect(calculateWPM(50, 30)).toBe(100); // 100 wpm
    expect(calculateWPM(7, 3)).toBe(140); // 140 wpm
  });

  it('returns 0 when durationSeconds is zero or negative', () => {
    expect(calculateWPM(100, 0)).toBe(0);
    expect(calculateWPM(100, -5)).toBe(0);
  });

  it('returns 0 for non-finite inputs', () => {
    expect(calculateWPM(Number.NaN, 60)).toBe(0);
    expect(calculateWPM(100, Number.NaN)).toBe(0);
    expect(calculateWPM(100, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('returns 0 for negative word counts', () => {
    expect(calculateWPM(-1, 60)).toBe(0);
  });
});

// ---------------------------------------------------------------------
// calculateConfidence — unit tests
// ---------------------------------------------------------------------

describe('calculateConfidence', () => {
  it('peaks in the 120–160 wpm pace band with no fillers', () => {
    const c = calculateConfidence(140, 0);
    expect(c).toBeGreaterThanOrEqual(95);
    expect(c).toBeLessThanOrEqual(100);
  });

  it('penalises heavy filler usage', () => {
    const noFillers = calculateConfidence(140, 0);
    const heavy = calculateConfidence(140, 0.2);
    expect(heavy).toBeLessThan(noFillers);
  });

  it('clamps the result to [0, 100] for extreme inputs', () => {
    expect(calculateConfidence(0, 1)).toBeGreaterThanOrEqual(0);
    expect(calculateConfidence(0, 1)).toBeLessThanOrEqual(100);
    expect(calculateConfidence(1000, 0)).toBeGreaterThanOrEqual(0);
    expect(calculateConfidence(1000, 0)).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------
// getFullAnalysis — unit tests
// ---------------------------------------------------------------------

describe('getFullAnalysis', () => {
  it('returns a CoachingMetrics record with the correct shape', () => {
    const result = getFullAnalysis({
      text: 'um, that was great',
      totalWordCount: 4,
      durationSeconds: 2,
    });

    expect(result.sentiment).toBe('positive');
    expect(result.score).toBe(1);
    expect(result.fillerCount).toBe(1);
    expect(result.fillerWords).toEqual(['um']);
    // 4 words / 2 seconds * 60 = 120 wpm.
    expect(result.wordsPerMinute).toBe(120);
    expect(result.confidenceScore).toBeGreaterThanOrEqual(0);
    expect(result.confidenceScore).toBeLessThanOrEqual(100);
  });

  it('uses the user-attributed word count rather than the surface word count', () => {
    // Twelve surface words; caller says only 6 belong to the user.
    const text = 'this is a long transcript with several words across it here';
    const a = getFullAnalysis({ text, totalWordCount: 12, durationSeconds: 6 });
    const b = getFullAnalysis({ text, totalWordCount: 6, durationSeconds: 6 });

    expect(a.wordsPerMinute).toBe(120);
    expect(b.wordsPerMinute).toBe(60);
  });

  it('returns wordsPerMinute = 0 when durationSeconds is 0', () => {
    const result = getFullAnalysis({
      text: 'anything',
      totalWordCount: 100,
      durationSeconds: 0,
    });
    expect(result.wordsPerMinute).toBe(0);
  });

  it('does not mutate its input', () => {
    const input = { text: 'um great', totalWordCount: 2, durationSeconds: 1 };
    const snapshot = { ...input };
    getFullAnalysis(input);
    expect(input).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------
// Property 24: Coaching is a pure function
// ---------------------------------------------------------------------
//
// **Validates: Requirements 9.5, 9.2**
//
// For all tuples `(text, totalWordCount, durationSeconds)`, two
// successive calls to `getFullAnalysis` produce deeply equal outputs.
// This pins down the absence of module-level mutable state.

describe('getFullAnalysis — Property 24: pure', () => {
  it('returns deeply equal results for the same input on every call', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 500 }),
        fc.nat({ max: 100_000 }),
        fc.float({ min: 0, max: 100_000, noNaN: true, noDefaultInfinity: true }),
        (text, totalWordCount, durationSeconds) => {
          const first = getFullAnalysis({ text, totalWordCount, durationSeconds });
          const second = getFullAnalysis({ text, totalWordCount, durationSeconds });
          expect(second).toEqual(first);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('intermediate calls with different inputs do not affect a fixed input', () => {
    fc.assert(
      fc.property(
        // Fixed reference input.
        fc.record({
          text: fc.string({ maxLength: 200 }),
          totalWordCount: fc.nat({ max: 10_000 }),
          durationSeconds: fc.float({
            min: 0,
            max: 10_000,
            noNaN: true,
            noDefaultInfinity: true,
          }),
        }),
        // Arbitrary "perturbing" inputs in between.
        fc.array(
          fc.record({
            text: fc.string({ maxLength: 200 }),
            totalWordCount: fc.nat({ max: 10_000 }),
            durationSeconds: fc.float({
              min: 0,
              max: 10_000,
              noNaN: true,
              noDefaultInfinity: true,
            }),
          }),
          { maxLength: 5 },
        ),
        (fixed, perturbations) => {
          const before = getFullAnalysis(fixed);
          for (const p of perturbations) getFullAnalysis(p);
          const after = getFullAnalysis(fixed);
          expect(after).toEqual(before);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------
// Property 25: Confidence score is bounded
// ---------------------------------------------------------------------
//
// **Validates: Requirements 9.6**
//
// For all `wpm ≥ 0` and `fillerRatio ∈ [0, 1]`,
// `calculateConfidence(wpm, fillerRatio)` is a finite number in [0, 100].

describe('calculateConfidence — Property 25: bounded', () => {
  it('produces a finite value in [0, 100] for any non-negative wpm and any fillerRatio in [0, 1]', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1_000, noNaN: true, noDefaultInfinity: true }),
        fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        (wpm, fillerRatio) => {
          const c = calculateConfidence(wpm, fillerRatio);
          expect(Number.isFinite(c)).toBe(true);
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(100);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('the full pipeline confidenceScore is also in [0, 100]', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 300 }),
        fc.nat({ max: 50_000 }),
        fc.float({ min: 0, max: 10_000, noNaN: true, noDefaultInfinity: true }),
        (text, totalWordCount, durationSeconds) => {
          const result: CoachingMetrics = getFullAnalysis({
            text,
            totalWordCount,
            durationSeconds,
          });
          expect(result.confidenceScore).toBeGreaterThanOrEqual(0);
          expect(result.confidenceScore).toBeLessThanOrEqual(100);
          expect(Number.isFinite(result.confidenceScore)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------
// Property 26: WPM aggregates only user-attributed words
// ---------------------------------------------------------------------
//
// **Validates: Requirements 9.3**
//
// `calculateWPM(totalWordCount, durationSeconds)` is a pure function of its
// two arguments. Specifically, when `durationSeconds > 0`, it equals
// `Math.round(totalWordCount / durationSeconds * 60)`. When `durationSeconds`
// is zero or negative, it returns 0. The function therefore neither inspects
// the transcript text nor relies on speaker-role information; it is the
// caller's responsibility to pass user-attributed word counts and user-
// active duration.
//
// We also verify, at the `getFullAnalysis` boundary, that
// `wordsPerMinute === calculateWPM(totalWordCount, durationSeconds)` so that
// the aggregation does not silently re-derive WPM from the raw text.

describe('calculateWPM — Property 26: WPM formula and aggregation invariant', () => {
  it('matches Math.round(totalWordCount / durationSeconds * 60) for any positive duration', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 100_000 }),
        fc.float({
          min: Math.fround(0.001),
          max: 100_000,
          noNaN: true,
          noDefaultInfinity: true,
        }),
        (totalWordCount, durationSeconds) => {
          const expected = Math.round((totalWordCount / durationSeconds) * 60);
          expect(calculateWPM(totalWordCount, durationSeconds)).toBe(expected);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('returns 0 for any non-positive durationSeconds', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 100_000 }),
        fc.float({ min: -100, max: 0, noNaN: true, noDefaultInfinity: true }),
        (totalWordCount, durationSeconds) => {
          expect(calculateWPM(totalWordCount, durationSeconds)).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('getFullAnalysis.wordsPerMinute equals calculateWPM(totalWordCount, durationSeconds)', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 300 }),
        fc.nat({ max: 50_000 }),
        fc.float({ min: 0, max: 10_000, noNaN: true, noDefaultInfinity: true }),
        (text, totalWordCount, durationSeconds) => {
          const { wordsPerMinute } = getFullAnalysis({
            text,
            totalWordCount,
            durationSeconds,
          });
          expect(wordsPerMinute).toBe(calculateWPM(totalWordCount, durationSeconds));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('wordsPerMinute does not depend on the surface word count of text', () => {
    // For any pair of (text₁, text₂), if (totalWordCount, durationSeconds)
    // are equal, the returned wordsPerMinute must be equal.
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        fc.string({ maxLength: 200 }),
        fc.nat({ max: 10_000 }),
        fc.float({ min: 0, max: 10_000, noNaN: true, noDefaultInfinity: true }),
        (text1, text2, totalWordCount, durationSeconds) => {
          const a = getFullAnalysis({ text: text1, totalWordCount, durationSeconds });
          const b = getFullAnalysis({ text: text2, totalWordCount, durationSeconds });
          expect(a.wordsPerMinute).toBe(b.wordsPerMinute);
        },
      ),
      { numRuns: 200 },
    );
  });
});
