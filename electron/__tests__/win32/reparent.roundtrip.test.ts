// ============================================
// Property 2: Release/adopt round-trip fidelity
// ============================================
//
// ∀ initial style s, exStyle e, rect r: adopt then release restores
// GWL_STYLE = s, GWL_EXSTYLE = e, rect = r exactly, GetParent(c) = NULL
//
// **Validates: Requirements 3.3, 3.4**

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

// ── Win32 Constants ──────────────────────────────────────────────────────────

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;

// ── Fake window state ────────────────────────────────────────────────────────

interface WindowState {
  style: number;
  exStyle: number;
  parent: unknown;
  rect: { left: number; top: number; right: number; bottom: number };
}

const HOST_HWND = { __host: true };
const CHILD_HWND = { __child: true };

// Host client rect (the area the child gets refitted to during adopt)
const HOST_CLIENT_WIDTH = 800;
const HOST_CLIENT_HEIGHT = 600;

let childState: WindowState;

function createFakeFfi() {
  return {
    user32: {
      GetWindowLongPtrW: (hwnd: unknown, index: number): number => {
        if (hwnd === CHILD_HWND) {
          if (index === GWL_STYLE) return childState.style;
          if (index === GWL_EXSTYLE) return childState.exStyle;
        }
        return 0;
      },
      SetWindowLongPtrW: (hwnd: unknown, index: number, value: number): number => {
        if (hwnd === CHILD_HWND) {
          if (index === GWL_STYLE) {
            const old = childState.style;
            childState.style = value;
            return old;
          }
          if (index === GWL_EXSTYLE) {
            const old = childState.exStyle;
            childState.exStyle = value;
            return old;
          }
        }
        return 0;
      },
      GetWindowRect: (hwnd: unknown, rectBuf: unknown): boolean => {
        if (hwnd === CHILD_HWND) {
          // The rectBuf is a mutable object from alloc — write into it
          const buf = rectBuf as { left: number; top: number; right: number; bottom: number };
          buf.left = childState.rect.left;
          buf.top = childState.rect.top;
          buf.right = childState.rect.right;
          buf.bottom = childState.rect.bottom;
        }
        return true;
      },
      GetClientRect: (hwnd: unknown, rectBuf: unknown): boolean => {
        if (hwnd === HOST_HWND) {
          const buf = rectBuf as { left: number; top: number; right: number; bottom: number };
          buf.left = 0;
          buf.top = 0;
          buf.right = HOST_CLIENT_WIDTH;
          buf.bottom = HOST_CLIENT_HEIGHT;
        }
        return true;
      },
      SetParent: (child: unknown, newParent: unknown): unknown => {
        if (child === CHILD_HWND) {
          const oldParent = childState.parent;
          childState.parent = newParent;
          return oldParent;
        }
        return null;
      },
      GetParent: (hwnd: unknown): unknown => {
        if (hwnd === CHILD_HWND) {
          return childState.parent;
        }
        return null;
      },
      SetWindowPos: (
        hwnd: unknown,
        _insertAfter: unknown,
        x: number,
        y: number,
        cx: number,
        cy: number,
        _flags: number,
      ): boolean => {
        if (hwnd === CHILD_HWND) {
          childState.rect = {
            left: x,
            top: y,
            right: x + cx,
            bottom: y + cy,
          };
        }
        return true;
      },
    },
    gdi32: { loaded: false },
    dwmapi: {
      DwmSetWindowAttribute: () => 0,
    },
    kernel32: {
      GetModuleHandleW: () => null,
      GetLastError: () => 0,
    },
    types: {
      POINT: 'POINT',
      SIZE: 'SIZE',
      RECT: 'RECT',
      BLENDFUNCTION: 'BLENDFUNCTION',
      WNDPROC: 'WNDPROC',
      WNDCLASSEXW: 'WNDCLASSEXW',
    },
    registerCallback: () => ({ __cb: true }),
    unregisterCallback: () => {},
    alloc: (_type: string, value?: unknown) => {
      // Return a mutable object that the fake FFI functions can write into
      if (value && typeof value === 'object') {
        return { ...value as object };
      }
      return {};
    },
    decode: (_ptr: unknown, _type: string) => {
      // decode is called on rectBuf after GetWindowRect/GetClientRect fills it
      // The fake FFI writes directly into the alloc'd object, so return it as-is
      return _ptr;
    },
    procAddress: () => ({ __fakeProc: true }),
  };
}

// ── Mock modules ─────────────────────────────────────────────────────────────

vi.mock('../../win32/ffi', () => ({
  getFfi: () => createFakeFfi(),
  isWin32: () => true,
}));

vi.mock('../../nativeStealth', () => ({
  applyNativeStealth: () => ({ ok: true, layers: [] }),
}));

// ── Import module under test (after mocks) ───────────────────────────────────

import { createReparenter } from '../../win32/reparent';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Property 2: Release/adopt round-trip fidelity', () => {
  beforeEach(() => {
    // Reset child state before each test
    childState = {
      style: 0,
      exStyle: 0,
      parent: null,
      rect: { left: 0, top: 0, right: 0, bottom: 0 },
    };
  });

  it('∀ initial style s, exStyle e, rect r: adopt then release restores exact state', () => {
    fc.assert(
      fc.property(
        // Generate arbitrary style with WS_POPUP set (typical overlay window)
        fc.integer({ min: 0, max: 0xFFFFFFFF }).map((s) => s | 0x80000000), // WS_POPUP = 0x80000000
        fc.integer({ min: 0, max: 0xFFFFFFFF }),
        fc.record({
          x: fc.integer({ min: -3000, max: 3000 }),
          y: fc.integer({ min: -3000, max: 3000 }),
          width: fc.integer({ min: 1, max: 4000 }),
          height: fc.integer({ min: 1, max: 4000 }),
        }),
        (style, exStyle, rect) => {
          // Set the initial state on the fake child window
          childState = {
            style,
            exStyle,
            parent: null,
            rect: {
              left: rect.x,
              top: rect.y,
              right: rect.x + rect.width,
              bottom: rect.y + rect.height,
            },
          };

          // Create a reparenter with the fake FFI
          const ffi = createFakeFfi();
          const reparenter = createReparenter(ffi as any);

          // Perform adopt
          const adoptResult = reparenter.adopt(HOST_HWND, CHILD_HWND);
          expect(adoptResult.success).toBe(true);

          // The child should now be parented to the host
          expect(childState.parent).toBe(HOST_HWND);

          // Perform release
          const releaseResult = reparenter.release();
          expect(releaseResult.success).toBe(true);

          // After release: style must be restored exactly
          expect(childState.style).toBe(style);

          // After release: exStyle must be restored exactly
          expect(childState.exStyle).toBe(exStyle);

          // After release: rect must be restored exactly
          expect(childState.rect).toEqual({
            left: rect.x,
            top: rect.y,
            right: rect.x + rect.width,
            bottom: rect.y + rect.height,
          });

          // After release: parent must be NULL
          expect(childState.parent).toBeNull();

          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('round-trip preserves style bits that adopt modifies (WS_POPUP, WS_CHILD, WS_EX_TOPMOST)', () => {
    fc.assert(
      fc.property(
        // Style always has WS_POPUP since it's a typical overlay
        fc.integer({ min: 0, max: 0xFFFFFFFF }).map((s) => s | 0x80000000),
        // exStyle may or may not have WS_EX_TOPMOST (0x00000008)
        fc.integer({ min: 0, max: 0xFFFFFFFF }),
        (style, exStyle) => {
          childState = {
            style,
            exStyle,
            parent: null,
            rect: { left: 100, top: 200, right: 500, bottom: 600 },
          };

          const ffi = createFakeFfi();
          const reparenter = createReparenter(ffi as any);

          // Adopt modifies WS_POPUP → WS_CHILD and removes WS_EX_TOPMOST
          const adoptResult = reparenter.adopt(HOST_HWND, CHILD_HWND);
          expect(adoptResult.success).toBe(true);

          // Verify the intermediate state was modified
          const WS_POPUP = 0x80000000;
          const WS_CHILD = 0x40000000;
          const WS_EX_TOPMOST = 0x00000008;

          // During adoption, style should have WS_CHILD set and WS_POPUP cleared
          expect(childState.style & WS_CHILD).toBe(WS_CHILD);
          expect(childState.style & WS_POPUP).toBe(0);
          // exStyle should have WS_EX_TOPMOST cleared
          expect(childState.exStyle & WS_EX_TOPMOST).toBe(0);

          // Release should restore original values
          reparenter.release();

          // After release, original bits are back
          expect(childState.style).toBe(style);
          expect(childState.exStyle).toBe(exStyle);

          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('adopt result records failure.rolledBack = true when self-check fails', () => {
    // Create a specially broken FFI where GetParent returns wrong value after SetParent
    const brokenFfi = createFakeFfi();
    let setParentCalled = false;
    brokenFfi.user32.GetParent = () => {
      // After SetParent is called, return wrong value to trigger self-check failure
      if (setParentCalled) return { __wrong: true };
      return null;
    };
    const originalSetParent = brokenFfi.user32.SetParent;
    brokenFfi.user32.SetParent = (child: unknown, newParent: unknown) => {
      setParentCalled = true;
      return originalSetParent(child, newParent);
    };

    childState = {
      style: 0x80000000, // WS_POPUP
      exStyle: 0x00000008, // WS_EX_TOPMOST
      parent: null,
      rect: { left: 0, top: 0, right: 400, bottom: 300 },
    };

    const reparenter = createReparenter(brokenFfi as any);
    const result = reparenter.adopt(HOST_HWND, CHILD_HWND);

    // Self-check fails → rollback should have occurred
    expect(result.success).toBe(false);
    expect(result.failure).toBeDefined();
    expect(result.failure!.rolledBack).toBe(true);
  });
});
