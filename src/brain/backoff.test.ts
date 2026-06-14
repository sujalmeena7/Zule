// Property-based + unit tests for restartBackoff.
//
// **Property 1: Restart backoff is bounded and monotonic**
//
// *For all* non-negative integer attempt counts `k`,
//     restartBackoff(k) === Math.min(8000, 250 * 2 ** k)
// in milliseconds, and for any `k1 ≤ k2`,
//     restartBackoff(k1) ≤ restartBackoff(k2).
//
// **Validates: Requirements 1.2, 4.5**

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  restartBackoff,
  RESTART_BACKOFF_INITIAL_MS,
  RESTART_BACKOFF_MAX_MS,
} from './backoff';

describe('restartBackoff (unit)', () => {
  it('returns the initial 250 ms delay for the first attempt', () => {
    expect(restartBackoff(0)).toBe(RESTART_BACKOFF_INITIAL_MS);
    expect(restartBackoff(0)).toBe(250);
  });

  it('doubles the delay each step until reaching the cap', () => {
    expect(restartBackoff(1)).toBe(500);
    expect(restartBackoff(2)).toBe(1_000);
    expect(restartBackoff(3)).toBe(2_000);
    expect(restartBackoff(4)).toBe(4_000);
    expect(restartBackoff(5)).toBe(8_000);
  });

  it('caps at 8 000 ms for k >= 5', () => {
    expect(restartBackoff(5)).toBe(RESTART_BACKOFF_MAX_MS);
    expect(restartBackoff(6)).toBe(RESTART_BACKOFF_MAX_MS);
    expect(restartBackoff(20)).toBe(RESTART_BACKOFF_MAX_MS);
    expect(restartBackoff(1_000)).toBe(RESTART_BACKOFF_MAX_MS);
  });
});

describe('restartBackoff (Property 1: bounded and monotonic)', () => {
  it('matches the closed-form min(8000, 250 * 2^k) for all non-negative integers k', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 60 }), (k) => {
        const expected = Math.min(8_000, 250 * 2 ** k);
        return restartBackoff(k) === expected;
      }),
      { numRuns: 200 },
    );
  });

  it('is monotonically non-decreasing in k', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: 0, max: 60 }),
        (a, b) => {
          const [k1, k2] = a <= b ? [a, b] : [b, a];
          return restartBackoff(k1) <= restartBackoff(k2);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('is bounded above by 8 000 ms for every non-negative integer k', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000 }), (k) => {
        return restartBackoff(k) <= RESTART_BACKOFF_MAX_MS;
      }),
      { numRuns: 200 },
    );
  });

  it('is bounded below by the initial 250 ms for every non-negative integer k', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000 }), (k) => {
        return restartBackoff(k) >= RESTART_BACKOFF_INITIAL_MS;
      }),
      { numRuns: 200 },
    );
  });
});
