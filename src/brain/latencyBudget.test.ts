// ============================================
// Zule AI — LatencyBudget tests
// ============================================
//
// Layered as:
//
//   1. Unit tests covering recordSample, stream separation,
//      degraded-state transitions, and reset.
//   2. Property 40: cache hits and TTFT samples are routed to
//      separate streams (Requirement 14.4).
//   3. Property 41: latency-degraded indicator after two consecutive
//      over-budget requests (Requirement 14.3).

import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

import {
  LatencyBudget,
  type LatencySample,
} from './latencyBudget';

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/** Create a non-cache sample with specific TTFT. */
function makeSample(opts: {
  ttft: number;
  total?: number;
  fromCache?: boolean;
  tDetected?: number;
}): LatencySample {
  const tDetected = opts.tDetected ?? 1000;
  return {
    tDetected,
    tRequestSent: tDetected + 10,
    tFirstToken: tDetected + opts.ttft,
    tComplete: tDetected + (opts.total ?? opts.ttft + 200),
    fromCache: opts.fromCache ?? false,
  };
}

// ---------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------

describe('LatencyBudget', () => {
  it('defaults to 1500 ms TTFT budget and 4000 ms total budget', () => {
    const lb = new LatencyBudget();
    expect(lb.budget).toBe(1500);
    expect(lb.totalBudget).toBe(4000);
  });

  it('accepts custom budget configuration', () => {
    const lb = new LatencyBudget({ ttftBudgetMs: 2000, totalBudgetMs: 5000 });
    expect(lb.budget).toBe(2000);
    expect(lb.totalBudget).toBe(5000);
  });

  it('records non-cache samples into TTFT stream', () => {
    const lb = new LatencyBudget();
    lb.recordSample(makeSample({ ttft: 800 }));

    expect(lb.getTTFTSamples().length).toBe(1);
    expect(lb.getTTFTSamples()[0].ttft).toBe(800);
    expect(lb.getCacheHitSamples().length).toBe(0);
  });

  it('records cache-hit samples into cache stream', () => {
    const lb = new LatencyBudget();
    lb.recordSample(makeSample({ ttft: 0, fromCache: true }));

    expect(lb.getCacheHitSamples().length).toBe(1);
    expect(lb.getTTFTSamples().length).toBe(0);
  });

  it('is not degraded initially', () => {
    const lb = new LatencyBudget();
    expect(lb.isDegraded).toBe(false);
  });

  it('is not degraded after a single over-budget TTFT', () => {
    const lb = new LatencyBudget({ ttftBudgetMs: 1000 });
    lb.recordSample(makeSample({ ttft: 1500 }));
    expect(lb.isDegraded).toBe(false);
  });

  it('becomes degraded after two consecutive over-budget TTFTs', () => {
    const lb = new LatencyBudget({ ttftBudgetMs: 1000 });
    lb.recordSample(makeSample({ ttft: 1500 }));
    lb.recordSample(makeSample({ ttft: 1200 }));
    expect(lb.isDegraded).toBe(true);
  });

  it('calls onDegraded callback when entering degraded state', () => {
    const onDegraded = vi.fn();
    const lb = new LatencyBudget({ ttftBudgetMs: 1000, onDegraded });
    lb.recordSample(makeSample({ ttft: 1500 }));
    expect(onDegraded).not.toHaveBeenCalled();
    lb.recordSample(makeSample({ ttft: 1200 }));
    expect(onDegraded).toHaveBeenCalledTimes(1);
  });

  it('does not call onDegraded again while already degraded', () => {
    const onDegraded = vi.fn();
    const lb = new LatencyBudget({ ttftBudgetMs: 1000, onDegraded });
    lb.recordSample(makeSample({ ttft: 1500 }));
    lb.recordSample(makeSample({ ttft: 1200 }));
    lb.recordSample(makeSample({ ttft: 1800 }));
    expect(onDegraded).toHaveBeenCalledTimes(1);
  });

  it('resets degraded state when a within-budget TTFT arrives', () => {
    const lb = new LatencyBudget({ ttftBudgetMs: 1000 });
    lb.recordSample(makeSample({ ttft: 1500 }));
    lb.recordSample(makeSample({ ttft: 1200 }));
    expect(lb.isDegraded).toBe(true);

    lb.recordSample(makeSample({ ttft: 800 }));
    expect(lb.isDegraded).toBe(false);
  });

  it('cache hits do not affect degraded-state tracking', () => {
    const lb = new LatencyBudget({ ttftBudgetMs: 1000 });
    lb.recordSample(makeSample({ ttft: 1500 }));
    // A cache hit in between should not reset the consecutive counter
    lb.recordSample(makeSample({ ttft: 0, fromCache: true }));
    lb.recordSample(makeSample({ ttft: 1200 }));
    expect(lb.isDegraded).toBe(true);
  });

  it('reset clears all state', () => {
    const lb = new LatencyBudget({ ttftBudgetMs: 1000 });
    lb.recordSample(makeSample({ ttft: 1500 }));
    lb.recordSample(makeSample({ ttft: 1200 }));
    lb.recordSample(makeSample({ ttft: 0, fromCache: true }));
    expect(lb.isDegraded).toBe(true);

    lb.reset();

    expect(lb.isDegraded).toBe(false);
    expect(lb.getTTFTSamples().length).toBe(0);
    expect(lb.getCacheHitSamples().length).toBe(0);
  });

  it('correctly computes TTFT as tFirstToken - tDetected', () => {
    const lb = new LatencyBudget();
    lb.recordSample({
      tDetected: 100,
      tRequestSent: 150,
      tFirstToken: 600,
      tComplete: 1000,
      fromCache: false,
    });
    expect(lb.getTTFTSamples()[0].ttft).toBe(500);
  });

  it('correctly marks over-budget samples', () => {
    const lb = new LatencyBudget({ ttftBudgetMs: 1000 });
    lb.recordSample(makeSample({ ttft: 800 }));
    lb.recordSample(makeSample({ ttft: 1200 }));

    expect(lb.getTTFTSamples()[0].overBudget).toBe(false);
    expect(lb.getTTFTSamples()[1].overBudget).toBe(true);
  });
});

// ---------------------------------------------------------------------
// Property 40 (Requirement 14.4)
// ---------------------------------------------------------------------
//
// **Validates: Requirements 14.4**
//
// Cache hits never appear in getTTFTSamples(); non-cache samples never
// appear in getCacheHitSamples(). The two streams are strictly partitioned
// by the fromCache flag.

describe('Property 40: cache hits and TTFT samples are routed to separate streams', () => {
  /** Arbitrary for a latency sample with a random fromCache flag. */
  const sampleArb: fc.Arbitrary<LatencySample> = fc.record({
    tDetected: fc.nat({ max: 100_000 }),
    tRequestSent: fc.nat({ max: 100_000 }),
    tFirstToken: fc.nat({ max: 200_000 }),
    tComplete: fc.nat({ max: 300_000 }),
    fromCache: fc.boolean(),
  });

  it('**Validates: Requirements 14.4**', () => {
    fc.assert(
      fc.property(
        fc.array(sampleArb, { minLength: 1, maxLength: 50 }),
        (samples) => {
          const lb = new LatencyBudget();

          for (const sample of samples) {
            lb.recordSample(sample);
          }

          const ttftSamples = lb.getTTFTSamples();
          const cacheHitSamples = lb.getCacheHitSamples();

          const expectedTtftCount = samples.filter((s) => !s.fromCache).length;
          const expectedCacheCount = samples.filter((s) => s.fromCache).length;

          // Stream sizes match partition counts
          if (ttftSamples.length !== expectedTtftCount) return false;
          if (cacheHitSamples.length !== expectedCacheCount) return false;

          // Total across both streams equals input count
          if (ttftSamples.length + cacheHitSamples.length !== samples.length) return false;

          return true;
        },
      ),
      { numRuns: 500 },
    );
  });

  it('cache-hit samples never contain TTFT values', () => {
    fc.assert(
      fc.property(
        fc.array(sampleArb, { minLength: 1, maxLength: 30 }),
        (samples) => {
          const lb = new LatencyBudget();
          for (const sample of samples) {
            lb.recordSample(sample);
          }

          // Cache hit samples only have timestamp — no ttft field
          for (const hit of lb.getCacheHitSamples()) {
            if ('ttft' in hit) return false;
          }

          return true;
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------
// Property 41 (Requirement 14.3)
// ---------------------------------------------------------------------
//
// **Validates: Requirements 14.3**
//
// isDegraded becomes true iff the last 2 consecutive non-cache samples
// have TTFT > budget. Cache hits do not reset or advance the consecutive
// counter. A within-budget sample resets the degraded state.

describe('Property 41: latency-degraded indicator after two consecutive over-budget requests', () => {
  /**
   * We generate a sequence of actions: either a non-cache sample with
   * a specific TTFT, or a cache-hit. We then replay them and assert
   * the degraded invariant.
   */
  type Action =
    | { kind: 'sample'; ttft: number }
    | { kind: 'cache' };

  const actionArb: fc.Arbitrary<Action> = fc.oneof(
    fc.record({
      kind: fc.constant<'sample'>('sample'),
      ttft: fc.nat({ max: 5000 }),
    }),
    fc.record({
      kind: fc.constant<'cache'>('cache'),
    }),
  );

  it('**Validates: Requirements 14.3**', () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 1, maxLength: 40 }),
        fc.nat({ max: 5000 }),
        (actions, budgetMs) => {
          // Ensure budget is at least 1 to avoid edge case of 0
          const budget = Math.max(1, budgetMs);
          const lb = new LatencyBudget({ ttftBudgetMs: budget });

          // Track consecutive over-budget count ourselves
          let consecutive = 0;
          let expectedDegraded = false;

          for (const action of actions) {
            if (action.kind === 'cache') {
              lb.recordSample({
                tDetected: 1000,
                tRequestSent: 1010,
                tFirstToken: 1000,
                tComplete: 1000,
                fromCache: true,
              });
              // Cache hits don't affect the consecutive counter
            } else {
              const { ttft } = action;
              lb.recordSample({
                tDetected: 1000,
                tRequestSent: 1010,
                tFirstToken: 1000 + ttft,
                tComplete: 1000 + ttft + 200,
                fromCache: false,
              });

              if (ttft > budget) {
                consecutive++;
              } else {
                consecutive = 0;
                expectedDegraded = false;
              }

              if (consecutive >= 2) {
                expectedDegraded = true;
              }
            }
          }

          return lb.isDegraded === expectedDegraded;
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('onDegraded is called exactly once per degraded-state entry', () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { minLength: 2, maxLength: 30 }),
        fc.integer({ min: 1, max: 3000 }),
        (actions, budgetMs) => {
          const degradedCalls: number[] = [];
          const lb = new LatencyBudget({
            ttftBudgetMs: budgetMs,
            onDegraded: () => degradedCalls.push(1),
          });

          // Track expected onDegraded calls
          let consecutive = 0;
          let wasDegraded = false;
          let expectedCalls = 0;

          for (const action of actions) {
            if (action.kind === 'cache') {
              lb.recordSample({
                tDetected: 1000,
                tRequestSent: 1010,
                tFirstToken: 1000,
                tComplete: 1000,
                fromCache: true,
              });
            } else {
              const { ttft } = action;
              lb.recordSample({
                tDetected: 1000,
                tRequestSent: 1010,
                tFirstToken: 1000 + ttft,
                tComplete: 1000 + ttft + 200,
                fromCache: false,
              });

              if (ttft > budgetMs) {
                consecutive++;
              } else {
                consecutive = 0;
                wasDegraded = false;
              }

              if (consecutive >= 2 && !wasDegraded) {
                wasDegraded = true;
                expectedCalls++;
              }
            }
          }

          return degradedCalls.length === expectedCalls;
        },
      ),
      { numRuns: 500 },
    );
  });
});
