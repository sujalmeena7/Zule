// ============================================
// Zule AI — Rating Aggregation Property Test
// ============================================
//
// **Validates: Requirements 26.1**
//
// Property 61: Rating aggregation conserves count.
// For any sequence of N rating records, aggregateRatings(ratings).total === ratings.length.
// No duplicates, no drops — every input record is counted exactly once.

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { aggregateRatings, type RatingRecord, type RatingValue } from './ratings';

// --- Arbitrary generators ---

const ratingValueArb: fc.Arbitrary<RatingValue> = fc.constantFrom('up', 'down');

const ratingRecordArb: fc.Arbitrary<RatingRecord> = fc.record({
  id: fc.uuid(),
  providerId: fc.string({ minLength: 1, maxLength: 20, unit: 'grapheme' }),
  modelId: fc.string({ minLength: 1, maxLength: 30, unit: 'grapheme' }),
  rating: ratingValueArb,
  createdAt: fc.nat({ max: 2_000_000_000_000 }),
});

const ratingsArrayArb: fc.Arbitrary<RatingRecord[]> = fc.array(ratingRecordArb, {
  minLength: 0,
  maxLength: 200,
});

// --- Property tests ---

describe('Rating aggregation (Property 61)', () => {
  it('total count equals input length for any sequence of ratings', () => {
    fc.assert(
      fc.property(ratingsArrayArb, (ratings) => {
        const agg = aggregateRatings(ratings);
        expect(agg.total).toBe(ratings.length);
      }),
      { numRuns: 500 },
    );
  });

  it('up + down counts sum to total', () => {
    fc.assert(
      fc.property(ratingsArrayArb, (ratings) => {
        const agg = aggregateRatings(ratings);
        expect(agg.up + agg.down).toBe(agg.total);
      }),
      { numRuns: 500 },
    );
  });

  it('per-provider counts sum to total', () => {
    fc.assert(
      fc.property(ratingsArrayArb, (ratings) => {
        const agg = aggregateRatings(ratings);
        let providerTotal = 0;
        for (const key of Object.keys(agg.byProvider)) {
          providerTotal += agg.byProvider[key].up + agg.byProvider[key].down;
        }
        expect(providerTotal).toBe(agg.total);
      }),
      { numRuns: 500 },
    );
  });

  it('per-model counts sum to total', () => {
    fc.assert(
      fc.property(ratingsArrayArb, (ratings) => {
        const agg = aggregateRatings(ratings);
        let modelTotal = 0;
        for (const key of Object.keys(agg.byModel)) {
          modelTotal += agg.byModel[key].up + agg.byModel[key].down;
        }
        expect(modelTotal).toBe(agg.total);
      }),
      { numRuns: 500 },
    );
  });

  it('empty input produces zero aggregates', () => {
    const agg = aggregateRatings([]);
    expect(agg.total).toBe(0);
    expect(agg.up).toBe(0);
    expect(agg.down).toBe(0);
    expect(Object.keys(agg.byProvider)).toHaveLength(0);
    expect(Object.keys(agg.byModel)).toHaveLength(0);
  });
});
