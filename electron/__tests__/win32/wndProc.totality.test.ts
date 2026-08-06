// ============================================
// Property 16: WNDPROC totality
// ============================================
//
// ∀ message triples (msg, wParam, lParam) from uint32 × int64 × int64,
// including throwing handlers: wrapper returns a safe integer and never throws.
// After MAX_WNDPROC_FAULTS faults, returns only DefWindowProcW results.
//
// **Validates: Requirements 9.2, 9.6**

import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';

import {
  makeSafeWndProc,
  MAX_WNDPROC_FAULTS,
  _resetWndProcState,
  _ALLOWED_MESSAGES,
} from '../../win32/wndProc';

// ── Fake FFI helpers ─────────────────────────────────────────────────────────

/** Constant value returned by the fake DefWindowProcW. */
const DEF_RETURN = 42;

/** Fake DefWindowProcW that returns a constant safe integer. */
function fakeDefWindowProc(
  _hwnd: unknown,
  _msg: number,
  _wParam: number,
  _lParam: number,
): number {
  return DEF_RETURN;
}

/** Fake HWND pointer for testing. */
const FAKE_HWND = { __fakeHwnd: true };

// ── Arbitraries ──────────────────────────────────────────────────────────────

/** msg: uint32 range */
const arbMsg = fc.integer({ min: 0, max: 0xFFFFFFFF });

/** wParam: large signed integer range (simulating int64) */
const arbWParam = fc.integer({ min: -2_147_483_648, max: 2_147_483_647 });

/** lParam: large signed integer range (simulating int64) */
const arbLParam = fc.integer({ min: -2_147_483_648, max: 2_147_483_647 });

/** A triple of (msg, wParam, lParam). */
const arbMessageTriple = fc.tuple(arbMsg, arbWParam, arbLParam);

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Property 16: WNDPROC totality', () => {
  beforeEach(() => {
    _resetWndProcState();
  });

  it('∀ (msg, wParam, lParam): wrapper with a normal handler returns a safe integer and never throws', () => {
    fc.assert(
      fc.property(arbMessageTriple, ([msg, wParam, lParam]) => {
        _resetWndProcState();

        const handlers = {
          onMessage: (_msg: number, _wParam: number, _lParam: number) => 7,
        };

        const wndProc = makeSafeWndProc(handlers, fakeDefWindowProc);

        // Must not throw
        let result: bigint | number;
        try {
          result = wndProc(FAKE_HWND, msg, wParam, lParam);
        } catch (e) {
          return false; // Property violated: threw
        }

        // Must return a safe integer (number) or bigint
        if (typeof result === 'bigint') {
          return true; // bigint is always a safe integer representation
        }
        return Number.isSafeInteger(result);
      }),
      { numRuns: 500 },
    );
  });

  it('∀ (msg, wParam, lParam): wrapper with a THROWING handler returns a safe integer and never throws', () => {
    fc.assert(
      fc.property(arbMessageTriple, ([msg, wParam, lParam]) => {
        _resetWndProcState();

        const handlers = {
          onMessage: () => {
            throw new Error('intentional handler explosion');
          },
        };

        const wndProc = makeSafeWndProc(handlers, fakeDefWindowProc);

        let result: bigint | number;
        try {
          result = wndProc(FAKE_HWND, msg, wParam, lParam);
        } catch (e) {
          return false; // Property violated: exception escaped the wrapper
        }

        if (typeof result === 'bigint') {
          return true;
        }
        return Number.isSafeInteger(result);
      }),
      { numRuns: 500 },
    );
  });

  it('∀ (msg, wParam, lParam) with arbitrary error types: wrapper never throws', () => {
    fc.assert(
      fc.property(
        arbMessageTriple,
        fc.oneof(
          fc.constant(() => { throw new Error('Error object'); }),
          fc.constant(() => { throw 'string error'; }),
          fc.constant(() => { throw null; }),
          fc.constant(() => { throw undefined; }),
          fc.constant(() => { throw 42; }),
          fc.constant(() => { throw { custom: 'object' }; }),
        ),
        ([msg, wParam, lParam], thrower) => {
          _resetWndProcState();

          const handlers = {
            onMessage: () => {
              (thrower as () => never)();
              return null; // unreachable
            },
          };

          const wndProc = makeSafeWndProc(handlers, fakeDefWindowProc);

          let result: bigint | number;
          try {
            result = wndProc(FAKE_HWND, msg, wParam, lParam);
          } catch (e) {
            return false; // Property violated
          }

          if (typeof result === 'bigint') {
            return true;
          }
          return Number.isSafeInteger(result);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('after MAX_WNDPROC_FAULTS throwing invocations, subsequent calls bypass the handler entirely (circuit breaker)', () => {
    // Use an allowed message so the handler is actually invoked (not short-circuited by allowlist)
    const allowedMsg = [..._ALLOWED_MESSAGES][0]; // first allowed message

    let handlerCallCount = 0;

    const handlers = {
      onMessage: () => {
        handlerCallCount++;
        throw new Error('fault');
      },
    };

    const wndProc = makeSafeWndProc(handlers, fakeDefWindowProc);

    // Trip the circuit breaker by invoking MAX_WNDPROC_FAULTS times
    for (let i = 0; i < MAX_WNDPROC_FAULTS; i++) {
      const result = wndProc(FAKE_HWND, allowedMsg, 0, 0);
      // Each call should still return a safe value
      expect(
        typeof result === 'bigint' || Number.isSafeInteger(result),
      ).toBe(true);
    }

    expect(handlerCallCount).toBe(MAX_WNDPROC_FAULTS);

    // Now verify the circuit breaker is tripped: handler should NOT be called
    const preCount = handlerCallCount;

    fc.assert(
      fc.property(arbMessageTriple, ([msg, wParam, lParam]) => {
        let result: bigint | number;
        try {
          result = wndProc(FAKE_HWND, msg, wParam, lParam);
        } catch (e) {
          return false; // Must never throw
        }

        // Must return a safe integer
        if (typeof result === 'bigint') {
          // ok
        } else if (!Number.isSafeInteger(result)) {
          return false;
        }

        return true;
      }),
      { numRuns: 200 },
    );

    // Handler should never have been called again after circuit breaker tripped
    // (for allowed messages it would have been called; since circuit breaker is tripped, it's bypassed)
    // Note: non-allowed messages skip the handler regardless, so we verify with allowed messages specifically
    const postCount = handlerCallCount;
    expect(postCount).toBe(preCount); // no additional handler calls
  });

  it('after circuit breaker trips, all allowed messages return DefWindowProcW result', () => {
    const allowedMsg = [..._ALLOWED_MESSAGES][0];

    const handlers = {
      onMessage: () => {
        throw new Error('fault');
      },
    };

    const wndProc = makeSafeWndProc(handlers, fakeDefWindowProc);

    // Trip the circuit breaker
    for (let i = 0; i < MAX_WNDPROC_FAULTS; i++) {
      wndProc(FAKE_HWND, allowedMsg, 0, 0);
    }

    // After tripping, all calls should return DEF_RETURN (the fake DefWindowProcW value)
    for (const msg of _ALLOWED_MESSAGES) {
      const result = wndProc(FAKE_HWND, msg, 0, 0);
      expect(result).toBe(DEF_RETURN);
    }
  });

  it('∀ (msg, wParam, lParam): even when DefWindowProcW itself throws, wrapper still returns a safe integer', () => {
    fc.assert(
      fc.property(arbMessageTriple, ([msg, wParam, lParam]) => {
        _resetWndProcState();

        const throwingDef = () => {
          throw new Error('DefWindowProcW failed');
        };

        const handlers = {
          onMessage: () => null, // fall through to def
        };

        const wndProc = makeSafeWndProc(handlers, throwingDef as any);

        let result: bigint | number;
        try {
          result = wndProc(FAKE_HWND, msg, wParam, lParam);
        } catch (e) {
          return false; // Property violated
        }

        if (typeof result === 'bigint') {
          return true;
        }
        return Number.isSafeInteger(result);
      }),
      { numRuns: 300 },
    );
  });
});
