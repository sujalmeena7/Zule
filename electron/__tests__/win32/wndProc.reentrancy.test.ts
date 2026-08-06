// Feature: stealth-window-host, Property 18: No reentrant WNDPROC dispatch
// **Validates: Requirements 9.4**
//
// ∀ message sequences causing `SetWindowPos` or `sendInputEvent` during handling:
// handler body never executes more than once simultaneously.
// The reentrancy guard returns DefWindowProcW result and defers via setImmediate.

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';
import { makeSafeWndProc, _resetWndProcState, _ALLOWED_MESSAGES } from '../../win32/wndProc';

// ── Fake DefWindowProcW ──────────────────────────────────────────────────────

const DEF_RESULT = 42;

function fakeDefWindowProc(_hwnd: unknown, _msg: number, _wParam: number, _lParam: number): number {
  return DEF_RESULT;
}

// ── Generators ───────────────────────────────────────────────────────────────

/** Generate sequences of allowlisted messages to drive reentrant call patterns. */
const arbAllowedMessages = fc.array(
  fc.constantFrom(...Array.from(_ALLOWED_MESSAGES)),
  { minLength: 1, maxLength: 20 },
);

// A fake HWND value for testing.
const FAKE_HWND = 0x12345678;

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Property 18: No reentrant WNDPROC dispatch', () => {
  beforeEach(() => {
    _resetWndProcState();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('handler body never executes more than once simultaneously under reentrant calls', () => {
    fc.assert(
      fc.property(arbAllowedMessages, (messages) => {
        _resetWndProcState();

        let maxConcurrency = 0;
        let currentConcurrency = 0;
        // Only trigger reentrancy during the top-level (non-deferred) dispatch.
        // This prevents infinite setImmediate loops while still testing the guard.
        let isPrimaryDispatch = false;

        let wndProc: ReturnType<typeof makeSafeWndProc> | null = null;

        const handlers = {
          onMessage(msg: number, _wParam: number, _lParam: number): number | null {
            currentConcurrency++;
            if (currentConcurrency > maxConcurrency) {
              maxConcurrency = currentConcurrency;
            }

            // Only trigger reentrant call during primary dispatch, not during
            // deferred setImmediate callbacks. This simulates what happens when
            // SetWindowPos or sendInputEvent triggers another message synchronously.
            if (isPrimaryDispatch && wndProc && messages.length > 1) {
              const reentrantMsg = messages[(messages.indexOf(msg) + 1) % messages.length];
              wndProc(FAKE_HWND, reentrantMsg, 0, 0);
            }

            currentConcurrency--;
            return null; // fall through to DefWindowProcW
          },
        };

        wndProc = makeSafeWndProc(handlers, fakeDefWindowProc);

        // Drive the wndproc with each message in the generated sequence.
        for (const msg of messages) {
          isPrimaryDispatch = true;
          const result = wndProc(FAKE_HWND, msg, 0, 0);
          isPrimaryDispatch = false;

          // Must always return a safe integer (either handler result or DefWindowProcW).
          expect(typeof result).toBe('number');
          expect(Number.isSafeInteger(Number(result))).toBe(true);
        }

        // The reentrancy guard must ensure the handler body never ran concurrently.
        expect(maxConcurrency).toBeLessThanOrEqual(1);
      }),
      { numRuns: 200 },
    );
  });

  test('reentrant calls return DefWindowProcW result immediately (not dropped)', () => {
    fc.assert(
      fc.property(arbAllowedMessages, (messages) => {
        _resetWndProcState();

        let handlerCallCount = 0;
        let reentrantResult: bigint | number | null = null;
        let isPrimaryDispatch = false;

        let wndProc: ReturnType<typeof makeSafeWndProc> | null = null;

        const handlers = {
          onMessage(_msg: number, _wParam: number, _lParam: number): number | null {
            handlerCallCount++;

            // Trigger reentrancy on the first primary call only.
            if (handlerCallCount === 1 && isPrimaryDispatch && wndProc && messages.length > 0) {
              reentrantResult = wndProc(FAKE_HWND, messages[0], 0, 0);
            }

            return null;
          },
        };

        wndProc = makeSafeWndProc(handlers, fakeDefWindowProc);

        if (messages.length > 0) {
          isPrimaryDispatch = true;
          wndProc(FAKE_HWND, messages[0], 0, 0);
          isPrimaryDispatch = false;

          // The reentrant call must have returned the DefWindowProcW result
          // because the reentrancy guard diverts it.
          if (reentrantResult !== null) {
            expect(Number(reentrantResult)).toBe(DEF_RESULT);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  test('deferred handlers eventually execute via setImmediate after reentrancy guard releases', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Array.from(_ALLOWED_MESSAGES)),
        (msg) => {
          _resetWndProcState();

          let deferredExecutionCount = 0;
          let isPrimaryDispatch = false;
          let reentryAttempted = false;

          let wndProc: ReturnType<typeof makeSafeWndProc> | null = null;

          const handlers = {
            onMessage(_msg: number, _wParam: number, _lParam: number): number | null {
              if (isPrimaryDispatch && !reentryAttempted) {
                reentryAttempted = true;
                // Trigger one reentrant call. The guard should defer it.
                if (wndProc) {
                  wndProc(FAKE_HWND, msg, 0, 0);
                }
              } else if (!isPrimaryDispatch) {
                // This is the deferred execution from setImmediate.
                deferredExecutionCount++;
              }
              return null;
            },
          };

          wndProc = makeSafeWndProc(handlers, fakeDefWindowProc);

          isPrimaryDispatch = true;
          wndProc(FAKE_HWND, msg, 0, 0);
          isPrimaryDispatch = false;

          // Before flushing timers: deferred handler should NOT have run.
          expect(deferredExecutionCount).toBe(0);

          // After flushing one setImmediate tick: deferred handler should execute.
          vi.runOnlyPendingTimers();
          expect(deferredExecutionCount).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  test('reentrancy guard handles deeply nested reentrant attempts', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10 }),
        fc.constantFrom(...Array.from(_ALLOWED_MESSAGES)),
        (depth, msg) => {
          _resetWndProcState();

          let maxConcurrency = 0;
          let currentConcurrency = 0;
          let reentryDepth = 0;
          let isPrimaryDispatch = false;

          let wndProc: ReturnType<typeof makeSafeWndProc> | null = null;

          const handlers = {
            onMessage(_msg: number, _wParam: number, _lParam: number): number | null {
              currentConcurrency++;
              if (currentConcurrency > maxConcurrency) {
                maxConcurrency = currentConcurrency;
              }

              // Attempt nested reentry up to `depth` levels.
              if (isPrimaryDispatch && reentryDepth < depth && wndProc) {
                reentryDepth++;
                wndProc(FAKE_HWND, msg, 0, 0);
              }

              currentConcurrency--;
              return null;
            },
          };

          wndProc = makeSafeWndProc(handlers, fakeDefWindowProc);

          isPrimaryDispatch = true;
          wndProc(FAKE_HWND, msg, 0, 0);
          isPrimaryDispatch = false;

          // Even with multiple reentry attempts, concurrency must never exceed 1.
          expect(maxConcurrency).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 100 },
    );
  });
});
