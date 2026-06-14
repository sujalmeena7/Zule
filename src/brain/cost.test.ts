// Property-based + unit tests for computeCost.
//
// **Property 60: Cost calculation is non-negative and additive**
//
// *For all* `(promptTokens >= 0, completionTokens >= 0,
//   pricePerMTokens.{input, output} >= 0)`, the computed cost
//
//     c = (promptTokens / 1e6) * pricePerMTokens.input
//       + (completionTokens / 1e6) * pricePerMTokens.output
//
// satisfies `c >= 0`. For any partition of a request set into subsets,
// the sum of subset costs equals the total cost (within floating-point
// tolerance). The same shared price means addition over token counts is
// preserved: `computeCost(a) + computeCost(b)` equals
// `computeCost(a + b)` when both share the same prices.
//
// **Validates: Requirements 28.1, 28.2, 28.3**

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { computeCost, type PricePerMTokens } from './cost';

// Floating-point tolerance shared by additivity assertions. We pick
// 1e-9 USD because per-token prices are bounded at $1 000 / M-tokens
// and token counts at 1e9 in our generators, putting absolute
// rounding error well under this floor.
const FP_TOLERANCE = 1e-9;

const nonNegPrice = () =>
  fc.double({ min: 0, max: 1_000, noNaN: true, noDefaultInfinity: true });

const tokenCount = () =>
  fc.integer({ min: 0, max: 1_000_000_000 });

const pricePair = (): fc.Arbitrary<PricePerMTokens> =>
  fc.record({ input: nonNegPrice(), output: nonNegPrice() });

describe('computeCost (unit)', () => {
  it('returns 0 for zero tokens regardless of price', () => {
    expect(
      computeCost({
        promptTokens: 0,
        completionTokens: 0,
        pricePerMTokens: { input: 3, output: 6 },
      }),
    ).toBe(0);
  });

  it('returns 0 when both prices are 0 regardless of token counts', () => {
    expect(
      computeCost({
        promptTokens: 12_345,
        completionTokens: 67_890,
        pricePerMTokens: { input: 0, output: 0 },
      }),
    ).toBe(0);
  });

  it('matches the closed-form formula on a worked example', () => {
    // 1 000 000 prompt tokens at $3 / M = $3.
    // 500 000 completion tokens at $6 / M = $3.
    // Total = $6.
    expect(
      computeCost({
        promptTokens: 1_000_000,
        completionTokens: 500_000,
        pricePerMTokens: { input: 3, output: 6 },
      }),
    ).toBeCloseTo(6, 12);
  });

  it('throws RangeError on negative promptTokens', () => {
    expect(() =>
      computeCost({
        promptTokens: -1,
        completionTokens: 0,
        pricePerMTokens: { input: 1, output: 1 },
      }),
    ).toThrow(RangeError);
  });

  it('throws RangeError on negative completionTokens', () => {
    expect(() =>
      computeCost({
        promptTokens: 0,
        completionTokens: -1,
        pricePerMTokens: { input: 1, output: 1 },
      }),
    ).toThrow(RangeError);
  });

  it('throws RangeError on negative input price', () => {
    expect(() =>
      computeCost({
        promptTokens: 100,
        completionTokens: 100,
        pricePerMTokens: { input: -0.01, output: 1 },
      }),
    ).toThrow(RangeError);
  });

  it('throws RangeError on negative output price', () => {
    expect(() =>
      computeCost({
        promptTokens: 100,
        completionTokens: 100,
        pricePerMTokens: { input: 1, output: -0.01 },
      }),
    ).toThrow(RangeError);
  });

  it('throws RangeError on NaN or non-finite inputs', () => {
    expect(() =>
      computeCost({
        promptTokens: Number.NaN,
        completionTokens: 0,
        pricePerMTokens: { input: 1, output: 1 },
      }),
    ).toThrow(RangeError);

    expect(() =>
      computeCost({
        promptTokens: 0,
        completionTokens: 0,
        pricePerMTokens: { input: Number.POSITIVE_INFINITY, output: 1 },
      }),
    ).toThrow(RangeError);
  });
});

describe('computeCost (Property 60: non-negative and additive)', () => {
  it('is non-negative for all non-negative inputs', () => {
    fc.assert(
      fc.property(tokenCount(), tokenCount(), pricePair(), (p, c, price) => {
        const cost = computeCost({
          promptTokens: p,
          completionTokens: c,
          pricePerMTokens: price,
        });
        return Number.isFinite(cost) && cost >= 0;
      }),
      { numRuns: 200 },
    );
  });

  it('is additive over token counts when prices are shared', () => {
    fc.assert(
      fc.property(
        tokenCount(),
        tokenCount(),
        tokenCount(),
        tokenCount(),
        pricePair(),
        (p1, c1, p2, c2, price) => {
          const a = computeCost({
            promptTokens: p1,
            completionTokens: c1,
            pricePerMTokens: price,
          });
          const b = computeCost({
            promptTokens: p2,
            completionTokens: c2,
            pricePerMTokens: price,
          });
          const combined = computeCost({
            promptTokens: p1 + p2,
            completionTokens: c1 + c2,
            pricePerMTokens: price,
          });
          // Allow a tiny relative tolerance for floating-point
          // accumulation; absolute tolerance handles the near-zero
          // case where relative error is ill-defined.
          const diff = Math.abs(a + b - combined);
          const scale = Math.max(1, Math.abs(combined));
          return diff <= FP_TOLERANCE * scale;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('is commutative under token-count swap (input/output prices held fixed)', () => {
    fc.assert(
      fc.property(
        tokenCount(),
        tokenCount(),
        tokenCount(),
        tokenCount(),
        pricePair(),
        (p1, c1, p2, c2, price) => {
          const ab = computeCost({
            promptTokens: p1 + p2,
            completionTokens: c1 + c2,
            pricePerMTokens: price,
          });
          const ba = computeCost({
            promptTokens: p2 + p1,
            completionTokens: c2 + c1,
            pricePerMTokens: price,
          });
          return ab === ba;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('the sum of per-request costs equals the cost of the aggregated request set (partition additivity)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            promptTokens: tokenCount(),
            completionTokens: tokenCount(),
          }),
          { minLength: 0, maxLength: 25 },
        ),
        pricePair(),
        (requests, price) => {
          const perRequestSum = requests.reduce(
            (acc, r) =>
              acc +
              computeCost({
                promptTokens: r.promptTokens,
                completionTokens: r.completionTokens,
                pricePerMTokens: price,
              }),
            0,
          );

          const totals = requests.reduce(
            (acc, r) => ({
              promptTokens: acc.promptTokens + r.promptTokens,
              completionTokens: acc.completionTokens + r.completionTokens,
            }),
            { promptTokens: 0, completionTokens: 0 },
          );

          const aggregated = computeCost({
            promptTokens: totals.promptTokens,
            completionTokens: totals.completionTokens,
            pricePerMTokens: price,
          });

          const diff = Math.abs(perRequestSum - aggregated);
          const scale = Math.max(1, Math.abs(aggregated));
          // Allow tolerance proportional to the number of summands
          // since each addition can introduce one ULP of error.
          const allowance = FP_TOLERANCE * scale * (requests.length + 1);
          return diff <= allowance;
        },
      ),
      { numRuns: 200 },
    );
  });
});
