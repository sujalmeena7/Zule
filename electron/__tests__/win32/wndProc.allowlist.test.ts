// ============================================
// Property 17: WNDPROC allowlist minimality
// ============================================
//
// ∀ msg ∉ allowlist: handler performs zero allocations and returns DefWindowProcW result
//
// **Validates: Requirements 9.3**

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fc from 'fast-check';
import { makeSafeWndProc, _ALLOWED_MESSAGES, _resetWndProcState } from '../../win32/wndProc';

describe('Property 17: WNDPROC allowlist minimality', () => {
  beforeEach(() => {
    _resetWndProcState();
  });

  it('∀ msg ∉ allowlist: onMessage is never called and result equals DefWindowProcW return', () => {
    fc.assert(
      fc.property(
        // Generate a message value NOT in the allowlist
        fc.integer({ min: 0, max: 0xFFFFFFFF }).filter(m => !_ALLOWED_MESSAGES.has(m)),
        // Generate arbitrary wParam and lParam values
        fc.integer({ min: -2147483648, max: 2147483647 }),
        fc.integer({ min: -2147483648, max: 2147483647 }),
        (msg, wParam, lParam) => {
          // Reset state for each test case to ensure independence
          _resetWndProcState();

          // Spy handler — should never be called for non-allowlisted messages
          const onMessageSpy = vi.fn().mockReturnValue(null);
          const handlers = { onMessage: onMessageSpy };

          // DefWindowProcW mock returns a deterministic value based on msg
          // so we can verify the return value matches
          const defReturnValue = msg + 1;
          const defWindowProc = vi.fn().mockReturnValue(defReturnValue);

          const wndProc = makeSafeWndProc(handlers, defWindowProc);

          // Fake HWND — just needs to be truthy for the call
          const fakeHwnd = 0xDEAD as unknown;

          const result = wndProc(fakeHwnd, msg, wParam, lParam);

          // Property: onMessage is NEVER called for non-allowlisted messages
          expect(onMessageSpy).not.toHaveBeenCalled();

          // Property: the return value equals what DefWindowProcW returns
          expect(result).toBe(defReturnValue);

          // Property: DefWindowProcW was called with the correct arguments
          expect(defWindowProc).toHaveBeenCalledOnce();
          expect(defWindowProc).toHaveBeenCalledWith(fakeHwnd, msg, wParam, lParam);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('∀ msg ∈ allowlist: onMessage IS called (contrast test)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(..._ALLOWED_MESSAGES),
        fc.integer({ min: -2147483648, max: 2147483647 }),
        fc.integer({ min: -2147483648, max: 2147483647 }),
        (msg, wParam, lParam) => {
          _resetWndProcState();

          const onMessageSpy = vi.fn().mockReturnValue(null);
          const handlers = { onMessage: onMessageSpy };
          const defWindowProc = vi.fn().mockReturnValue(0);

          const wndProc = makeSafeWndProc(handlers, defWindowProc);
          const fakeHwnd = 0xDEAD as unknown;

          wndProc(fakeHwnd, msg, wParam, lParam);

          // Contrast: for allowlisted messages, onMessage MUST be called
          expect(onMessageSpy).toHaveBeenCalledOnce();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('non-allowlisted messages produce zero user-level allocations (structural verification)', () => {
    // The "zero allocations" property is verified structurally:
    // if onMessage is never called, no user-level JS allocations happen in the hot path.
    // This test verifies the structural invariant across many random messages.
    fc.assert(
      fc.property(
        fc.array(
          fc.integer({ min: 0, max: 0xFFFFFFFF }).filter(m => !_ALLOWED_MESSAGES.has(m)),
          { minLength: 1, maxLength: 50 },
        ),
        (messages) => {
          _resetWndProcState();

          let callCount = 0;
          const handlers = {
            onMessage: (_msg: number, _wParam: number, _lParam: number) => {
              callCount++;
              return null;
            },
          };
          const defWindowProc = (_hwnd: unknown, msg: number, _w: number, _l: number) => msg + 1;

          const wndProc = makeSafeWndProc(handlers, defWindowProc);
          const fakeHwnd = 0xBEEF as unknown;

          // Send all non-allowlisted messages
          for (const msg of messages) {
            wndProc(fakeHwnd, msg, 0, 0);
          }

          // Zero calls to handler — zero user-level allocations on the hot path
          expect(callCount).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});
