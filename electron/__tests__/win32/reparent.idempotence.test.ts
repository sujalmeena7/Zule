// ============================================
// Property 1: Reparenting idempotence
// ============================================
//
// ∀ host h, child c, n ≥ 1: adopt(h, c) applied n times yields same state
// as once, and exactly one SetParent call reaches FFI.
//
// **Validates: Requirements 1.2, 6.2**

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

// ── Win32 constants (mirror reparent.ts) ─────────────────────────────────────

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;

// ── Fake FFI with call tracking ──────────────────────────────────────────────

interface FakeFFI {
  user32: {
    GetWindowLongPtrW: (hwnd: unknown, index: number) => number;
    SetWindowLongPtrW: ReturnType<typeof vi.fn>;
    GetWindowRect: (hwnd: unknown, rectBuf: unknown) => boolean;
    GetClientRect: (hwnd: unknown, rectBuf: unknown) => boolean;
    SetParent: ReturnType<typeof vi.fn>;
    GetParent: (hwnd: unknown) => unknown;
    SetWindowPos: ReturnType<typeof vi.fn>;
  };
  alloc: (type: string, value?: unknown) => unknown;
  decode: (ptr: unknown, type: string) => unknown;
}

function createFakeFfi(hostHwnd: unknown): FakeFFI {
  let adopted = false;

  const setParentSpy = vi.fn((_child: unknown, _newParent: unknown) => {
    adopted = true;
    return null; // previous parent (NULL = was top-level)
  });

  return {
    user32: {
      GetWindowLongPtrW: (_hwnd: unknown, index: number) => {
        if (index === GWL_STYLE) {
          // Return WS_CHILD if adopted, WS_POPUP initially
          return adopted ? WS_CHILD : WS_POPUP;
        }
        if (index === GWL_EXSTYLE) {
          return 0x00000008; // WS_EX_TOPMOST initially
        }
        return 0;
      },
      SetWindowLongPtrW: vi.fn(() => 0),
      GetWindowRect: (_hwnd: unknown, _rectBuf: unknown) => true,
      GetClientRect: (_hwnd: unknown, _rectBuf: unknown) => true,
      SetParent: setParentSpy,
      GetParent: (_hwnd: unknown) => {
        // After adoption, GetParent returns the host
        return adopted ? hostHwnd : null;
      },
      SetWindowPos: vi.fn(() => true),
    },
    alloc: (_type: string, value?: unknown) => value ?? { left: 0, top: 0, right: 800, bottom: 600 },
    decode: (_ptr: unknown, _type: string) => ({ left: 0, top: 0, right: 800, bottom: 600 }),
  };
}

// ── Mock nativeStealth to prevent real imports ───────────────────────────────

vi.mock('../../nativeStealth', () => ({
  applyNativeStealth: () => ({ ok: true, layers: [] }),
}));

// ── Import module under test ─────────────────────────────────────────────────

import { createReparenter } from '../../win32/reparent';
import type { Win32Ffi } from '../../win32/ffi';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Property 1: Reparenting idempotence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('∀ n ≥ 1: adopt(h, c) applied n times yields same state as once and exactly one SetParent call', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        (n: number) => {
          const hostHwnd = { __host: 'host-hwnd' };
          const childHwnd = { __child: 'child-hwnd' };
          const fakeFfi = createFakeFfi(hostHwnd);

          const reparenter = createReparenter(fakeFfi as unknown as Win32Ffi);

          // First adoption
          const firstResult = reparenter.adopt(hostHwnd, childHwnd);
          expect(firstResult.success).toBe(true);
          expect(firstResult.state.adopted).toBe(true);

          const firstState = { ...firstResult.state };

          // Apply adopt n-1 more times (total n calls)
          for (let i = 1; i < n; i++) {
            const result = reparenter.adopt(hostHwnd, childHwnd);

            // Every subsequent call must return the same state
            expect(result.success).toBe(true);
            expect(result.state).toEqual(firstState);
          }

          // SetParent must have been called exactly once
          expect(fakeFfi.user32.SetParent).toHaveBeenCalledTimes(1);

          // Final state must show adopted
          expect(reparenter.getState().adopted).toBe(true);

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('after first adopt, getState().adopted === true regardless of n', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        (n: number) => {
          const hostHwnd = { __host: 'h' };
          const childHwnd = { __child: 'c' };
          const fakeFfi = createFakeFfi(hostHwnd);

          const reparenter = createReparenter(fakeFfi as unknown as Win32Ffi);

          for (let i = 0; i < n; i++) {
            reparenter.adopt(hostHwnd, childHwnd);
          }

          expect(reparenter.getState().adopted).toBe(true);
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('all n adopt calls return deep-equal state objects', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 20 }),
        (n: number) => {
          const hostHwnd = { __host: 'host' };
          const childHwnd = { __child: 'child' };
          const fakeFfi = createFakeFfi(hostHwnd);

          const reparenter = createReparenter(fakeFfi as unknown as Win32Ffi);

          const results: Array<{ success: boolean; state: unknown }> = [];

          for (let i = 0; i < n; i++) {
            results.push(reparenter.adopt(hostHwnd, childHwnd));
          }

          // All results must be identical
          const firstResult = results[0];
          for (let i = 1; i < results.length; i++) {
            expect(results[i].success).toBe(firstResult.success);
            expect(results[i].state).toEqual(firstResult.state);
          }

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});
