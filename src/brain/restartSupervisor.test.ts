// Property-based + unit tests for RestartSupervisor.
//
// **Property 2: Supervisor pauses after 5 consecutive restarts inside 60 s**
//
// *For all* finite event sequences over `{ restart(t), finalResult(t),
// reset(t) }` with timestamps `t` in any order, the supervisor enters the
// `paused` state if and only if there exists a window of length ≤ 60 000 ms
// containing five `restart` events with no intervening `finalResult` or
// `reset`.
//
// **Validates: Requirements 1.3, 20.3**
//
// The PBT compares the optimized supervisor implementation against an
// independent naive simulation oracle (`oracleSimulate` below). Both apply
// the same latching semantics — once paused, the supervisor stays paused
// until `reset()`. Unit tests cover the boundary cases and the reset / final
// clearing behaviour.

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { RestartSupervisor } from './restartSupervisor';
import { restartBackoff } from './backoff';

type Event =
  | { type: 'restart'; t: number }
  | { type: 'final'; t: number }
  | { type: 'reset'; t: number };

const WINDOW_MS = 60_000;
const MAX_IN_WINDOW = 5;

/**
 * Independent naive simulation oracle. Processes events in arrival order;
 * once 5 valid (uncleared) restart timestamps fit inside a 60 s window, the
 * oracle latches to `paused` until a `reset` event is observed.
 *
 * This oracle is intentionally written in a different idiom from the
 * supervisor (mutating local arrays, `sort` on every insert, no early-exit)
 * so that a typo in one is unlikely to match the other.
 */
function oracleSimulate(events: Event[]): 'ready' | 'paused' {
  let lastClearAt = Number.NEGATIVE_INFINITY;
  let restarts: number[] = [];
  let state: 'ready' | 'paused' = 'ready';

  const checkPause = (): boolean => {
    for (let i = 0; i + MAX_IN_WINDOW - 1 < restarts.length; i++) {
      if (restarts[i + MAX_IN_WINDOW - 1] - restarts[i] <= WINDOW_MS) return true;
    }
    return false;
  };

  for (const e of events) {
    if (e.type === 'reset') {
      state = 'ready';
      if (e.t > lastClearAt) lastClearAt = e.t;
      restarts = restarts.filter((rt) => rt > lastClearAt);
      continue;
    }
    if (state === 'paused') continue; // latched until reset
    if (e.type === 'restart') {
      if (e.t > lastClearAt) {
        restarts = [...restarts, e.t].sort((a, b) => a - b);
      }
      if (checkPause()) state = 'paused';
    } else {
      // final
      if (e.t > lastClearAt) {
        lastClearAt = e.t;
        restarts = restarts.filter((rt) => rt > lastClearAt);
      }
    }
  }
  return state;
}

const eventArb: fc.Arbitrary<Event> = fc.record({
  type: fc.constantFrom<'restart' | 'final' | 'reset'>('restart', 'final', 'reset'),
  t: fc.integer({ min: 0, max: 600_000 }),
});

describe('RestartSupervisor (unit)', () => {
  it('starts ready with zero attempts', () => {
    const sup = new RestartSupervisor();
    expect(sup.state).toBe('ready');
    expect(sup.attemptCount).toBe(0);
  });

  it('returns the configured backoff for the first restart', () => {
    const sup = new RestartSupervisor({ now: () => 0 });
    const decision = sup.recordRestart();
    expect(decision.state).toBe('ready');
    if (decision.state === 'ready') {
      expect(decision.attempt).toBe(1);
      expect(decision.delayMs).toBe(restartBackoff(0));
      expect(decision.delayMs).toBe(250);
    }
  });

  it('returns increasing backoff for consecutive restarts within the window', () => {
    const sup = new RestartSupervisor();
    const d0 = sup.recordRestart(0);
    const d1 = sup.recordRestart(100);
    const d2 = sup.recordRestart(200);
    expect(d0.state).toBe('ready');
    expect(d1.state).toBe('ready');
    expect(d2.state).toBe('ready');
    if (d0.state === 'ready' && d1.state === 'ready' && d2.state === 'ready') {
      expect(d0.delayMs).toBe(restartBackoff(0)); // 250
      expect(d1.delayMs).toBe(restartBackoff(1)); // 500
      expect(d2.delayMs).toBe(restartBackoff(2)); // 1000
    }
  });

  it('pauses on the 5th consecutive restart inside a 60 s window', () => {
    const sup = new RestartSupervisor();
    sup.recordRestart(0);
    sup.recordRestart(1_000);
    sup.recordRestart(2_000);
    sup.recordRestart(3_000);
    expect(sup.state).toBe('ready');
    const fifth = sup.recordRestart(4_000);
    expect(fifth.state).toBe('paused');
    expect(sup.state).toBe('paused');
  });

  it('does not pause when 5 restarts span more than 60 s', () => {
    const sup = new RestartSupervisor();
    sup.recordRestart(0);
    sup.recordRestart(20_000);
    sup.recordRestart(40_000);
    sup.recordRestart(60_001); // span 0..60_001 > window
    sup.recordRestart(80_000);
    expect(sup.state).toBe('ready');
  });

  it('clears the consecutive-restart counter on a final result', () => {
    const sup = new RestartSupervisor();
    sup.recordRestart(0);
    sup.recordRestart(100);
    sup.recordRestart(200);
    sup.recordRestart(300);
    sup.recordFinal(400);
    expect(sup.attemptCount).toBe(0);
    // Four more post-final restarts — should remain ready.
    sup.recordRestart(500);
    sup.recordRestart(600);
    sup.recordRestart(700);
    sup.recordRestart(800);
    expect(sup.state).toBe('ready');
    // The fifth crosses the threshold post-final.
    const fifth = sup.recordRestart(900);
    expect(fifth.state).toBe('paused');
  });

  it('latches paused until reset() is called', () => {
    const sup = new RestartSupervisor();
    for (let i = 0; i < 5; i++) sup.recordRestart(i * 100);
    expect(sup.state).toBe('paused');
    // recordFinal must not silently un-pause.
    sup.recordFinal(10_000);
    expect(sup.state).toBe('paused');
    // recordRestart must not advance counters or change state.
    const decision = sup.recordRestart(11_000);
    expect(decision.state).toBe('paused');
    // Only reset() resumes.
    sup.reset(12_000);
    expect(sup.state).toBe('ready');
    expect(sup.attemptCount).toBe(0);
  });

  it('can pause again after a reset', () => {
    const sup = new RestartSupervisor();
    for (let i = 0; i < 5; i++) sup.recordRestart(i * 100);
    expect(sup.state).toBe('paused');
    sup.reset(1_000);
    expect(sup.state).toBe('ready');
    for (let i = 0; i < 4; i++) sup.recordRestart(2_000 + i * 100);
    expect(sup.state).toBe('ready');
    sup.recordRestart(2_500);
    expect(sup.state).toBe('paused');
  });

  it('honours configurable threshold and window', () => {
    const sup = new RestartSupervisor({ maxRestartsInWindow: 3, windowMs: 1_000 });
    sup.recordRestart(0);
    sup.recordRestart(500);
    expect(sup.state).toBe('ready');
    sup.recordRestart(900);
    expect(sup.state).toBe('paused');
  });

  it('ignores out-of-order restart events that predate the most recent clear', () => {
    const sup = new RestartSupervisor();
    sup.recordFinal(1_000);
    // Stale restarts whose timestamps are <= lastClearAt do not count.
    sup.recordRestart(100);
    sup.recordRestart(500);
    sup.recordRestart(900);
    sup.recordRestart(1_000);
    expect(sup.attemptCount).toBe(0);
    // A restart strictly after the clear is recorded as the first.
    sup.recordRestart(1_500);
    expect(sup.attemptCount).toBe(1);
  });
});

describe('RestartSupervisor (Property 2: pause iff window with no intervening clear)', () => {
  it('agrees with the naive oracle on arbitrary event sequences', () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 30 }), (events) => {
        const sup = new RestartSupervisor();
        for (const e of events) {
          if (e.type === 'restart') sup.recordRestart(e.t);
          else if (e.type === 'final') sup.recordFinal(e.t);
          else sup.reset(e.t);
        }
        const expected = oracleSimulate(events);
        return sup.state === expected;
      }),
      { numRuns: 300 },
    );
  });

  it('never pauses on event sequences with at most 4 restart timestamps', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            type: fc.constantFrom<'restart' | 'final'>('restart', 'final'),
            t: fc.integer({ min: 0, max: 600_000 }),
          }),
          { maxLength: 30 },
        ),
        (events) => {
          const restartCount = events.filter((e) => e.type === 'restart').length;
          fc.pre(restartCount <= 4);
          const sup = new RestartSupervisor();
          for (const e of events) {
            if (e.type === 'restart') sup.recordRestart(e.t);
            else sup.recordFinal(e.t);
          }
          return sup.state === 'ready';
        },
      ),
      { numRuns: 200 },
    );
  });

  it('always pauses on 5 restarts within a 60 s window with no intervening clear', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: WINDOW_MS }), {
          minLength: 5,
          maxLength: 5,
        }),
        (offsets) => {
          const base = 1_000_000;
          const sup = new RestartSupervisor();
          for (const off of offsets) {
            sup.recordRestart(base + off);
          }
          return sup.state === 'paused';
        },
      ),
      { numRuns: 100 },
    );
  });
});
