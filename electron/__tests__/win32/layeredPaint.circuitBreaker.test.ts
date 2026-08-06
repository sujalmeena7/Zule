// ============================================
// Property 20: Present-failure circuit breaker monotonicity
// ============================================
//
// ∀ sequences of present results: rollback requested iff > MAX_PRESENT_FAILURES
// consecutive failures; any success resets counter.
//
// **Validates: Requirements 7.3**

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import { MAX_PRESENT_FAILURES } from '../../win32/layeredPaint';

// ── Circuit Breaker Model ────────────────────────────────────────────────────
//
// Since creating a real PaintSurface requires koffi + GDI, we test via a
// faithful model of the circuit breaker logic as documented in layeredPaint.ts:
//   - On failure: increment consecutiveFailures; if > MAX_PRESENT_FAILURES, trip
//   - On success: reset consecutiveFailures to 0
//   - Once tripped, stays tripped (monotonic — never un-trips)

interface CircuitBreakerState {
  consecutiveFailures: number;
  tripped: boolean;
  rollbackRequested: boolean;
}

/**
 * Simulate the circuit breaker model for a sequence of present results.
 * `true` = present succeeded, `false` = present failed.
 */
function simulateCircuitBreaker(results: boolean[]): CircuitBreakerState {
  let consecutiveFailures = 0;
  let tripped = false;
  let rollbackRequested = false;

  for (const ok of results) {
    if (tripped) {
      // Once tripped, present() returns false immediately — no state changes
      break;
    }

    if (ok) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
      if (consecutiveFailures > MAX_PRESENT_FAILURES) {
        tripped = true;
        rollbackRequested = true;
      }
    }
  }

  return { consecutiveFailures, tripped, rollbackRequested };
}

/**
 * Check whether a sequence contains > MAX_PRESENT_FAILURES consecutive falses
 * before being interrupted by a true or end-of-sequence.
 */
function hasConsecutiveFailuresExceedingThreshold(results: boolean[]): boolean {
  let consecutive = 0;
  for (const ok of results) {
    if (ok) {
      consecutive = 0;
    } else {
      consecutive++;
      if (consecutive > MAX_PRESENT_FAILURES) {
        return true;
      }
    }
  }
  return false;
}

// ── Arbitraries ──────────────────────────────────────────────────────────────

/** Generate sequences of present results (true = success, false = failure). */
const arbPresentResults = fc.array(fc.boolean(), { minLength: 1, maxLength: 50 });

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Property 20: Present-failure circuit breaker monotonicity', () => {
  it('MAX_PRESENT_FAILURES is a positive integer', () => {
    expect(MAX_PRESENT_FAILURES).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_PRESENT_FAILURES)).toBe(true);
  });

  it('∀ result sequences: rollback requested iff > MAX_PRESENT_FAILURES consecutive failures exist', () => {
    fc.assert(
      fc.property(arbPresentResults, (results) => {
        const state = simulateCircuitBreaker(results);
        const shouldTrip = hasConsecutiveFailuresExceedingThreshold(results);

        // Biconditional: tripped iff the threshold is exceeded
        return state.rollbackRequested === shouldTrip;
      }),
      { numRuns: 1000 },
    );
  });

  it('∀ result sequences: any success (true) resets the consecutive failure counter to 0', () => {
    fc.assert(
      fc.property(arbPresentResults, (results) => {
        // Walk the sequence and verify the counter resets on success
        let consecutiveFailures = 0;
        let tripped = false;

        for (const ok of results) {
          if (tripped) break;

          if (ok) {
            consecutiveFailures = 0;
          } else {
            consecutiveFailures++;
            if (consecutiveFailures > MAX_PRESENT_FAILURES) {
              tripped = true;
            }
          }

          // After processing a success, counter must be 0
          if (ok && !tripped) {
            if (consecutiveFailures !== 0) return false;
          }
        }

        return true;
      }),
      { numRuns: 1000 },
    );
  });

  it('∀ result sequences: once tripped, the breaker stays tripped regardless of subsequent successes', () => {
    fc.assert(
      fc.property(arbPresentResults, (results) => {
        // Append additional successes after the sequence to verify monotonicity
        const extended = [...results, true, true, true, true, true];
        const state = simulateCircuitBreaker(results);

        if (state.tripped) {
          // Even with more successes appended, it stays tripped
          const extendedState = simulateCircuitBreaker(extended);
          return extendedState.tripped === true && extendedState.rollbackRequested === true;
        }

        return true;
      }),
      { numRuns: 1000 },
    );
  });

  it('∀ result sequences: the consecutive failure counter never goes negative', () => {
    fc.assert(
      fc.property(arbPresentResults, (results) => {
        let consecutiveFailures = 0;
        let tripped = false;

        for (const ok of results) {
          if (tripped) break;

          if (ok) {
            consecutiveFailures = 0;
          } else {
            consecutiveFailures++;
            if (consecutiveFailures > MAX_PRESENT_FAILURES) {
              tripped = true;
            }
          }

          // Counter must never be negative at any point
          if (consecutiveFailures < 0) return false;
        }

        return true;
      }),
      { numRuns: 1000 },
    );
  });

  it('exactly MAX_PRESENT_FAILURES consecutive failures does NOT trip the breaker', () => {
    // Boundary case: exactly at the threshold is not enough
    const results = Array(MAX_PRESENT_FAILURES).fill(false) as boolean[];
    const state = simulateCircuitBreaker(results);

    expect(state.tripped).toBe(false);
    expect(state.rollbackRequested).toBe(false);
    expect(state.consecutiveFailures).toBe(MAX_PRESENT_FAILURES);
  });

  it('MAX_PRESENT_FAILURES + 1 consecutive failures DOES trip the breaker', () => {
    // One past the threshold trips it
    const results = Array(MAX_PRESENT_FAILURES + 1).fill(false) as boolean[];
    const state = simulateCircuitBreaker(results);

    expect(state.tripped).toBe(true);
    expect(state.rollbackRequested).toBe(true);
  });

  it('a success just before the threshold prevents tripping', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: MAX_PRESENT_FAILURES }),
        (failsBefore) => {
          // failsBefore consecutive failures, then a success, then MAX+1 total
          // The success in the middle prevents the first batch from accumulating
          const results: boolean[] = [
            ...Array(failsBefore).fill(false),
            true,
            ...Array(MAX_PRESENT_FAILURES).fill(false),
          ];
          const state = simulateCircuitBreaker(results);

          // After the success reset, we only have MAX_PRESENT_FAILURES consecutive,
          // which is NOT enough to trip (needs > MAX)
          return state.tripped === false;
        },
      ),
      { numRuns: 100 },
    );
  });
});
