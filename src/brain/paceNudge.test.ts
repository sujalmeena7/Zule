// ============================================
// Zule AI — PaceNudgeMachine tests
// ============================================
//
// Covers unit and property-based tests for `src/brain/paceNudge.ts`.
//
//   - Property 27 (Requirement 9.4): pace nudge state machine — the machine
//     enters `nudge` if and only if the current sample sits in a contiguous
//     out-of-band run whose cumulative user-speech duration is at least 15 s,
//     and re-clears when the run ends (the band returns to `normal` or
//     switches between `slow` and `fast`).
//
// The property test exercises arbitrary tick sequences and compares the
// machine's output against an independent reference simulator at every step.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  PaceNudgeMachine,
  classifyBand,
  type PaceBand,
  type PaceNudgeTickResult,
} from './paceNudge';

// ---------------------------------------------------------------------
// Reference simulator
// ---------------------------------------------------------------------
//
// A small re-derivation of the spec rules used as an oracle for the
// property test. Keeping it deliberately separate from the production
// implementation guards against the test "marking its own homework".

interface SimOptions {
  slow: number;
  fast: number;
  sustained: number;
}

function simulate(
  ticks: ReadonlyArray<{ wpm: number; dt: number }>,
  opts: SimOptions = { slow: 90, fast: 180, sustained: 15_000 },
): PaceNudgeTickResult[] {
  let band: PaceBand = 'normal';
  let accumulated = 0;
  const out: PaceNudgeTickResult[] = [];

  for (const { wpm, dt } of ticks) {
    const validDt = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const newBand: PaceBand = !Number.isFinite(wpm)
      ? 'normal'
      : wpm < opts.slow
        ? 'slow'
        : wpm > opts.fast
          ? 'fast'
          : 'normal';

    if (newBand !== band) {
      band = newBand;
      accumulated = newBand === 'normal' ? 0 : validDt;
    } else if (newBand === 'normal') {
      accumulated = 0;
    } else {
      accumulated += validDt;
    }

    const isNudge =
      (band === 'slow' || band === 'fast') && accumulated >= opts.sustained;
    out.push({
      state: isNudge ? 'nudge' : 'normal',
      reason: isNudge ? (band === 'slow' ? 'too-slow' : 'too-fast') : null,
    });
  }

  return out;
}

// ---------------------------------------------------------------------
// classifyBand — unit tests
// ---------------------------------------------------------------------

describe('classifyBand', () => {
  it('classifies samples below the slow threshold as "slow"', () => {
    expect(classifyBand(89, 90, 180)).toBe('slow');
    expect(classifyBand(0, 90, 180)).toBe('slow');
  });

  it('classifies samples above the fast threshold as "fast"', () => {
    expect(classifyBand(181, 90, 180)).toBe('fast');
    expect(classifyBand(500, 90, 180)).toBe('fast');
  });

  it('classifies samples at the threshold boundaries as "normal"', () => {
    // Thresholds are exclusive: 90 is in band, 180 is in band.
    expect(classifyBand(90, 90, 180)).toBe('normal');
    expect(classifyBand(180, 90, 180)).toBe('normal');
    expect(classifyBand(135, 90, 180)).toBe('normal');
  });

  it('treats non-finite WPM as "normal"', () => {
    expect(classifyBand(Number.NaN, 90, 180)).toBe('normal');
    expect(classifyBand(Number.POSITIVE_INFINITY, 90, 180)).toBe('normal');
    expect(classifyBand(Number.NEGATIVE_INFINITY, 90, 180)).toBe('normal');
  });
});

// ---------------------------------------------------------------------
// PaceNudgeMachine — unit tests
// ---------------------------------------------------------------------

describe('PaceNudgeMachine — construction', () => {
  it('rejects threshold ranges where slow ≥ fast', () => {
    expect(() => new PaceNudgeMachine({ slowThresholdWpm: 200, fastThresholdWpm: 100 })).toThrow();
    expect(() => new PaceNudgeMachine({ slowThresholdWpm: 100, fastThresholdWpm: 100 })).toThrow();
  });

  it('rejects negative sustainedMs', () => {
    expect(() => new PaceNudgeMachine({ sustainedMs: -1 })).toThrow();
    expect(() => new PaceNudgeMachine({ sustainedMs: Number.NaN })).toThrow();
  });

  it('exposes default thresholds when none are supplied', () => {
    const m = new PaceNudgeMachine();
    expect(m.slowThresholdWpm).toBe(90);
    expect(m.fastThresholdWpm).toBe(180);
    expect(m.sustainedThresholdMs).toBe(15_000);
  });
});

describe('PaceNudgeMachine — slow band', () => {
  it('stays normal until cumulative slow time crosses 15 s', () => {
    const m = new PaceNudgeMachine();
    expect(m.tick(60, 5_000)).toEqual({ state: 'normal', reason: null });
    expect(m.tick(60, 5_000)).toEqual({ state: 'normal', reason: null });
    // After 14 s cumulative we are still under threshold.
    expect(m.tick(60, 4_000)).toEqual({ state: 'normal', reason: null });
    // Crossing 15 s now flips the state.
    const result = m.tick(60, 1_500);
    expect(result.state).toBe('nudge');
    expect(result.reason).toBe('too-slow');
  });

  it('flips on the exact tick that reaches sustainedMs', () => {
    const m = new PaceNudgeMachine();
    expect(m.tick(60, 14_999).state).toBe('normal');
    expect(m.tick(60, 1).state).toBe('nudge'); // 15 000 ms exactly
  });
});

describe('PaceNudgeMachine — fast band', () => {
  it('reports too-fast when cumulative fast time crosses 15 s', () => {
    const m = new PaceNudgeMachine();
    expect(m.tick(220, 7_000).state).toBe('normal');
    expect(m.tick(220, 7_000).state).toBe('normal');
    const result = m.tick(220, 2_000);
    expect(result.state).toBe('nudge');
    expect(result.reason).toBe('too-fast');
  });
});

describe('PaceNudgeMachine — band transitions reset the run', () => {
  it('returning to the normal band re-clears the state', () => {
    const m = new PaceNudgeMachine();
    expect(m.tick(60, 16_000).state).toBe('nudge');
    // Next sample is in-band; nudge must clear immediately.
    expect(m.tick(140, 1_000)).toEqual({ state: 'normal', reason: null });
  });

  it('switching from slow to fast re-clears the slow accumulator', () => {
    const m = new PaceNudgeMachine();
    m.tick(60, 14_000); // 14 s of slow — not yet a nudge
    // Switching to fast must NOT carry over the slow accumulator.
    const r = m.tick(220, 5_000);
    expect(r.state).toBe('normal');
    expect(m.band).toBe('fast');
    expect(m.accumulated).toBe(5_000);
  });

  it('switching from fast to slow re-clears the fast accumulator', () => {
    const m = new PaceNudgeMachine();
    m.tick(220, 14_000);
    const r = m.tick(60, 5_000);
    expect(r.state).toBe('normal');
    expect(m.band).toBe('slow');
    expect(m.accumulated).toBe(5_000);
  });

  it('a brief in-band tick wipes the accumulated run', () => {
    const m = new PaceNudgeMachine();
    m.tick(60, 14_000); // 14 s slow
    m.tick(140, 100); // ¹⁄₁₀ of a second of in-band speech
    // The slow run is over; we must accumulate ≥ 15 s of new slow time again.
    expect(m.tick(60, 14_000).state).toBe('normal');
    expect(m.tick(60, 1_500).state).toBe('nudge');
  });
});

describe('PaceNudgeMachine — input hygiene', () => {
  it('coerces negative and non-finite dt to 0', () => {
    const m = new PaceNudgeMachine();
    m.tick(60, -1_000);
    expect(m.accumulated).toBe(0);
    m.tick(60, Number.NaN);
    expect(m.accumulated).toBe(0);
    m.tick(60, Number.POSITIVE_INFINITY);
    expect(m.accumulated).toBe(0);
  });

  it('treats non-finite WPM as in-band normal', () => {
    const m = new PaceNudgeMachine();
    m.tick(60, 14_000);
    m.tick(Number.NaN, 1_000);
    expect(m.band).toBe('normal');
    expect(m.accumulated).toBe(0);
  });

  it('reset() clears the band and accumulator', () => {
    const m = new PaceNudgeMachine();
    m.tick(60, 16_000);
    m.reset();
    expect(m.band).toBe('normal');
    expect(m.accumulated).toBe(0);
    expect(m.tick(60, 1_000)).toEqual({ state: 'normal', reason: null });
  });
});

// ---------------------------------------------------------------------
// Property 27: Pace nudge state machine
// ---------------------------------------------------------------------
//
// **Validates: Requirements 9.4**
//
// The machine enters `nudge` if and only if the current sample sits in a
// contiguous out-of-band run whose cumulative user-speech duration is at
// least the configured sustained threshold (default 15 000 ms). Switching
// bands or returning to `normal` resets the run.

describe('PaceNudgeMachine — Property 27: pace nudge state machine', () => {
  // Generators are constrained to an intelligible space:
  //   - WPM samples are non-negative finite numbers up to 400 wpm; this
  //     covers the realistic sub-90 / super-180 / in-band cases.
  //   - dt is bounded by 5 000 ms per tick to mirror typical 2 s update
  //     cadences while still letting the test cross 15 s within a few
  //     ticks.
  const tickArb = fc.record({
    wpm: fc.float({ min: 0, max: 400, noNaN: true, noDefaultInfinity: true }),
    dt: fc.integer({ min: 0, max: 5_000 }),
  });

  it('matches the reference simulator on arbitrary tick sequences', () => {
    fc.assert(
      fc.property(fc.array(tickArb, { maxLength: 60 }), (ticks) => {
        const machine = new PaceNudgeMachine();
        const expected = simulate(ticks);
        for (let i = 0; i < ticks.length; i += 1) {
          const t = ticks[i];
          const actual = machine.tick(t.wpm, t.dt);
          expect(actual).toEqual(expected[i]);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('all-slow runs that cumulate ≥ 15 s end in nudge with reason too-slow', () => {
    fc.assert(
      fc.property(
        // Each tick is unambiguously in the slow band.
        fc.array(
          fc.record({
            wpm: fc.float({ min: 0, max: Math.fround(89.99), noNaN: true, noDefaultInfinity: true }),
            dt: fc.integer({ min: 1, max: 5_000 }),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        (ticks) => {
          const total = ticks.reduce((s, t) => s + t.dt, 0);
          fc.pre(total >= 15_000); // skip cases that cannot possibly nudge
          const m = new PaceNudgeMachine();
          let last: PaceNudgeTickResult = { state: 'normal', reason: null };
          for (const t of ticks) last = m.tick(t.wpm, t.dt);
          expect(last.state).toBe('nudge');
          expect(last.reason).toBe('too-slow');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('all-fast runs that cumulate ≥ 15 s end in nudge with reason too-fast', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            wpm: fc.float({ min: Math.fround(180.01), max: 400, noNaN: true, noDefaultInfinity: true }),
            dt: fc.integer({ min: 1, max: 5_000 }),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        (ticks) => {
          const total = ticks.reduce((s, t) => s + t.dt, 0);
          fc.pre(total >= 15_000);
          const m = new PaceNudgeMachine();
          let last: PaceNudgeTickResult = { state: 'normal', reason: null };
          for (const t of ticks) last = m.tick(t.wpm, t.dt);
          expect(last.state).toBe('nudge');
          expect(last.reason).toBe('too-fast');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('all-in-band runs never enter nudge', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            // Strictly inside [90, 180]; the boundaries themselves are
            // classified as normal so this generator stays in band.
            wpm: fc.float({ min: 90, max: 180, noNaN: true, noDefaultInfinity: true }),
            dt: fc.integer({ min: 0, max: 5_000 }),
          }),
          { maxLength: 60 },
        ),
        (ticks) => {
          const m = new PaceNudgeMachine();
          for (const t of ticks) {
            const r = m.tick(t.wpm, t.dt);
            expect(r.state).toBe('normal');
            expect(r.reason).toBe(null);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('a single in-band sample resets the accumulator', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: Math.fround(89.99), noNaN: true, noDefaultInfinity: true }),
        fc.integer({ min: 1, max: 14_000 }),
        fc.float({ min: 90, max: 180, noNaN: true, noDefaultInfinity: true }),
        fc.integer({ min: 0, max: 5_000 }),
        (slowWpm, slowDt, normalWpm, normalDt) => {
          const m = new PaceNudgeMachine();
          m.tick(slowWpm, slowDt);
          const before = m.accumulated;
          expect(before).toBe(slowDt);
          m.tick(normalWpm, normalDt);
          expect(m.band).toBe('normal');
          expect(m.accumulated).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('switching between slow and fast resets the accumulator', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: Math.fround(89.99), noNaN: true, noDefaultInfinity: true }),
        fc.integer({ min: 1, max: 14_000 }),
        fc.float({ min: Math.fround(180.01), max: 400, noNaN: true, noDefaultInfinity: true }),
        fc.integer({ min: 1, max: 5_000 }),
        (slowWpm, slowDt, fastWpm, fastDt) => {
          const m = new PaceNudgeMachine();
          m.tick(slowWpm, slowDt);
          m.tick(fastWpm, fastDt);
          expect(m.band).toBe('fast');
          expect(m.accumulated).toBe(fastDt);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('returning to the in-band re-clears nudge immediately', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: Math.fround(89.99), noNaN: true, noDefaultInfinity: true }),
        fc.float({ min: 90, max: 180, noNaN: true, noDefaultInfinity: true }),
        fc.integer({ min: 0, max: 5_000 }),
        (slowWpm, normalWpm, normalDt) => {
          const m = new PaceNudgeMachine();
          // Force the machine into nudge with a single fat slow tick.
          const first = m.tick(slowWpm, 16_000);
          expect(first.state).toBe('nudge');
          // Returning in-band must clear the nudge immediately.
          const second = m.tick(normalWpm, normalDt);
          expect(second).toEqual({ state: 'normal', reason: null });
        },
      ),
      { numRuns: 100 },
    );
  });
});
