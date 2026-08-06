// ============================================
// Property 3: Idempotent release
// ============================================
//
// ∀ n ≥ 1: release() applied n times equals once; releasing a never-adopted
// host is a no-op.
//
// **Validates: Requirements 3.3, 3.5**

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

// ── Fake FFI with state tracking ─────────────────────────────────────────────

interface WindowState {
  style: number;
  exStyle: number;
  rect: { left: number; top: number; right: number; bottom: number };
  parent: unknown;
}

let setParentCallCount: number;
let windowState: WindowState;

const FAKE_HOST_HWND = { __fakeHost: true };
const FAKE_CHILD_HWND = { __fakeChild: true };

const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;

function createFakeFfi(initialStyle: number, initialExStyle: number, initialRect: { x: number; y: number; width: number; height: number }) {
  windowState = {
    style: initialStyle,
    exStyle: initialExStyle,
    rect: {
      left: initialRect.x,
      top: initialRect.y,
      right: initialRect.x + initialRect.width,
      bottom: initialRect.y + initialRect.height,
    },
    parent: null,
  };
  setParentCallCount = 0;

  return {
    user32: {
      GetWindowLongPtrW: (_hwnd: unknown, index: number) => {
        if (index === GWL_STYLE) return windowState.style;
        if (index === GWL_EXSTYLE) return windowState.exStyle;
        return 0;
      },
      SetWindowLongPtrW: (_hwnd: unknown, index: number, value: number) => {
        if (index === GWL_STYLE) windowState.style = value;
        if (index === GWL_EXSTYLE) windowState.exStyle = value;
        return 0;
      },
      SetParent: (_child: unknown, newParent: unknown) => {
        setParentCallCount++;
        const oldParent = windowState.parent;
        windowState.parent = newParent;
        return oldParent;
      },
      GetParent: (_hwnd: unknown) => {
        return windowState.parent;
      },
      GetWindowRect: (_hwnd: unknown, rectBuf: unknown) => {
        // The rectBuf will be decoded via ffi.decode
        return true;
      },
      GetClientRect: (_hwnd: unknown, _rectBuf: unknown) => {
        return true;
      },
      SetWindowPos: (_hwnd: unknown, _insertAfter: unknown, x: number, y: number, w: number, h: number, _flags: number) => {
        windowState.rect = { left: x, top: y, right: x + w, bottom: y + h };
        return true;
      },
    },
    alloc: (_type: string, value?: unknown) => value ?? {},
    decode: (_ptr: unknown, _type: string) => {
      // Return current rect for GetWindowRect decode
      return { ...windowState.rect };
    },
  };
}

// ── Mock applyNativeStealth ──────────────────────────────────────────────────

vi.mock('../../nativeStealth', () => ({
  applyNativeStealth: () => ({ ok: true, layers: [] }),
}));

// ── Import module under test ─────────────────────────────────────────────────

import { createReparenter } from '../../win32/reparent';
import type { Win32Ffi } from '../../win32/ffi';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Property 3: Idempotent release', () => {
  beforeEach(() => {
    setParentCallCount = 0;
  });

  it('∀ n ≥ 1: after adopt + n calls to release(), state equals adopt + 1 release', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 0x7FFFFFFF }),
        fc.integer({ min: 0, max: 0x7FFFFFFF }),
        fc.record({
          x: fc.integer({ min: -2000, max: 4000 }),
          y: fc.integer({ min: -2000, max: 4000 }),
          width: fc.integer({ min: 1, max: 3840 }),
          height: fc.integer({ min: 1, max: 2160 }),
        }),
        (n, initialStyle, initialExStyle, initialRect) => {
          // Run once: adopt then release once
          const ffi1 = createFakeFfi(initialStyle, initialExStyle, initialRect);
          const reparenter1 = createReparenter(ffi1 as unknown as Win32Ffi);
          reparenter1.adopt(FAKE_HOST_HWND, FAKE_CHILD_HWND);
          reparenter1.release();
          const stateAfterOne = reparenter1.getState();
          const setParentAfterOne = setParentCallCount;

          // Run n times: adopt then release n times
          const ffi2 = createFakeFfi(initialStyle, initialExStyle, initialRect);
          const reparenter2 = createReparenter(ffi2 as unknown as Win32Ffi);
          reparenter2.adopt(FAKE_HOST_HWND, FAKE_CHILD_HWND);
          for (let i = 0; i < n; i++) {
            reparenter2.release();
          }
          const stateAfterN = reparenter2.getState();

          // States must be identical
          expect(stateAfterN.adopted).toBe(stateAfterOne.adopted);
          expect(stateAfterN.hostHwnd).toBe(stateAfterOne.hostHwnd);
          expect(stateAfterN.childHwnd).toBe(stateAfterOne.childHwnd);
          expect(stateAfterN.savedStyle).toBe(stateAfterOne.savedStyle);
          expect(stateAfterN.savedExStyle).toBe(stateAfterOne.savedExStyle);
          expect(stateAfterN.savedRect).toEqual(stateAfterOne.savedRect);

          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('∀ n ≥ 1: SetParent(NULL) is called exactly once regardless of how many times release() is called after adopt', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        (n) => {
          const ffi = createFakeFfi(WS_POPUP, 0, { x: 0, y: 0, width: 800, height: 600 });
          const reparenter = createReparenter(ffi as unknown as Win32Ffi);

          reparenter.adopt(FAKE_HOST_HWND, FAKE_CHILD_HWND);

          // Reset counter after adopt (adopt also calls SetParent)
          const callsAfterAdopt = setParentCallCount;

          for (let i = 0; i < n; i++) {
            reparenter.release();
          }

          // Exactly one more SetParent call for the release (the first one)
          const releaseCalls = setParentCallCount - callsAfterAdopt;
          expect(releaseCalls).toBe(1);

          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('∀ n ≥ 1: on a reparenter that was never adopted, release() is a no-op (returns success, state unchanged)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        (n) => {
          const ffi = createFakeFfi(WS_POPUP, 0, { x: 100, y: 100, width: 640, height: 480 });
          const reparenter = createReparenter(ffi as unknown as Win32Ffi);

          const stateBefore = reparenter.getState();

          for (let i = 0; i < n; i++) {
            const result = reparenter.release();
            // Each call should return success
            expect(result.success).toBe(true);
          }

          const stateAfter = reparenter.getState();

          // State remains un-adopted (default state)
          expect(stateAfter.adopted).toBe(false);
          expect(stateAfter.hostHwnd).toBeNull();
          expect(stateAfter.childHwnd).toBeNull();
          expect(stateAfter).toEqual(stateBefore);

          // No SetParent calls at all
          expect(setParentCallCount).toBe(0);

          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});
