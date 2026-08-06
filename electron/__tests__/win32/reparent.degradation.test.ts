// ============================================
// Property 4: Graceful degradation — overlay always functional
// ============================================
//
// ∀ failure injection point: after failure the overlay BrowserWindow is still
// created, visible, at intended bounds, hostStrategy = 'none',
// failure.rolledBack = true.
//
// This test verifies that stealth host creation failures degrade cleanly
// without leaving resources allocated. The "overlay BrowserWindow is still
// created" part is verified at the OverlayManager integration level (task 6.x).
// This test verifies the host module's clean degradation and the reparent
// module's self-check failure path.
//
// Failure injection points:
//   1. FFI load (getFfi returns null)
//   2. WNDPROC registration fails (registerWndProc returns null)
//   3. RegisterClassExW fails (returns 0)
//   4. CreateWindowExW fails (returns null)
//   5. Self-check fails after reparent (GetParent returns wrong value)
//
// **Validates: Requirements 3.1, 3.4, 2.3, 2.6**

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';

// ── Failure injection points for hostWindow.create() ─────────────────────────

type HostFailurePoint =
  | 'ffi-load'
  | 'wndproc-registration'
  | 'register-class'
  | 'create-window';

const HOST_FAILURE_POINTS: HostFailurePoint[] = [
  'ffi-load',
  'wndproc-registration',
  'register-class',
  'create-window',
];

let activeFailurePoint: string | null = null;

// ── Fake FFI surface with failure injection ──────────────────────────────────

const FAKE_HINSTANCE = { __fakeHInstance: true };
const FAKE_CURSOR = { __fakeCursor: true };
const FAKE_HOST_HWND = { __fakeHostHwnd: true };
const FAKE_CHILD_HWND = { __fakeChildHwnd: true };

function createFakeFfi() {
  return {
    user32: {
      RegisterClassExW: (_cls: unknown) => {
        if (activeFailurePoint === 'register-class') {
          return 0; // failure
        }
        return 1; // success ATOM
      },
      UnregisterClassW: (_className: string, _hInstance: unknown) => true,
      CreateWindowExW: (
        _exStyle: number, _className: string, _windowName: string,
        _style: number, _x: number, _y: number, _w: number, _h: number,
        _parent: unknown, _menu: unknown, _instance: unknown, _param: unknown,
      ) => {
        if (activeFailurePoint === 'create-window') {
          return null; // failure
        }
        return FAKE_HOST_HWND;
      },
      DestroyWindow: (_hwnd: unknown) => true,
      SetWindowPos: () => true,
      ShowWindow: () => true,
      GetWindowLongPtrW: (_hwnd: unknown, _index: number) => 0x40000000, // WS_CHILD
      SetWindowLongPtrW: () => 0,
      DefWindowProcW: () => 0,
      GetClientRect: () => true,
      GetWindowRect: () => true,
      GetClassNameW: () => 0,
      LoadCursorW: () => FAKE_CURSOR,
      SetWindowDisplayAffinity: () => true,
      GetWindowDisplayAffinity: () => true,
      GetParent: (_hwnd: unknown) => {
        if (activeFailurePoint === 'self-check') {
          return { __wrongParent: true }; // wrong parent → self-check fails
        }
        return FAKE_HOST_HWND; // correct parent
      },
      SetParent: () => null, // previous parent (desktop) returns null
    },
    gdi32: { loaded: false },
    dwmapi: {
      DwmSetWindowAttribute: () => 0,
    },
    kernel32: {
      GetModuleHandleW: () => FAKE_HINSTANCE,
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
    registerCallback: () => ({ __fakeCallback: true }),
    unregisterCallback: () => {},
    alloc: (_type: string, value?: unknown) => value ?? {},
    decode: () => ({ left: 0, top: 0, right: 800, bottom: 600 }),
    procAddress: () => ({ __fakeProc: true }),
  };
}

// ── Mock modules ─────────────────────────────────────────────────────────────

vi.mock('../../win32/ffi', () => ({
  getFfi: () => {
    if (activeFailurePoint === 'ffi-load') {
      return null;
    }
    return createFakeFfi();
  },
  isWin32: () => true,
}));

vi.mock('../../win32/wndProc', () => ({
  registerWndProc: (_mode: string, _handlers?: unknown) => {
    if (activeFailurePoint === 'wndproc-registration') {
      return null;
    }
    return {
      pointer: { __fakeWndProcPtr: true },
      isNativeFallback: _mode === 'native',
      dispose: () => {},
    };
  },
}));

vi.mock('../../nativeStealth', () => ({
  applyNativeStealth: () => ({ ok: true, layers: [] }),
}));

vi.mock('node:crypto', () => ({
  randomBytes: (n: number) => {
    const buf = Buffer.alloc(n);
    for (let i = 0; i < n; i++) {
      buf[i] = (i * 41 + 7) % 256;
    }
    return buf;
  },
}));

// ── Import modules under test (after mocks) ─────────────────────────────────

import { createStealthHost } from '../../win32/hostWindow';
import type { StealthHostOptions } from '../../win32/hostWindow';
import { createReparenter } from '../../win32/reparent';

// ── Bounds arbitrary ─────────────────────────────────────────────────────────

const arbBounds = fc.record({
  x: fc.integer({ min: -4096, max: 4096 }),
  y: fc.integer({ min: -4096, max: 4096 }),
  width: fc.nat({ max: 3840 }),
  height: fc.nat({ max: 2160 }),
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Property 4: Graceful degradation — overlay always functional', () => {
  beforeEach(() => {
    activeFailurePoint = null;
    Object.defineProperty(process, 'type', { value: 'browser', writable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Host creation failure points (1-4) ─────────────────────────────────

  it('∀ host failure point and bounds: state.strategy === "none" after failure', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...HOST_FAILURE_POINTS),
        arbBounds,
        (failurePoint, bounds) => {
          activeFailurePoint = failurePoint;

          const opts: StealthHostOptions = {
            bounds,
            strategy: 'reparent',
          };

          const host = createStealthHost(opts);
          const state = host.create();

          expect(state.strategy).toBe('none');
        },
      ),
      { numRuns: 200 },
    );
  });

  it('∀ host failure point and bounds: state.failure !== null and failure.rolledBack === true', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...HOST_FAILURE_POINTS),
        arbBounds,
        (failurePoint, bounds) => {
          activeFailurePoint = failurePoint;

          const opts: StealthHostOptions = {
            bounds,
            strategy: 'reparent',
          };

          const host = createStealthHost(opts);
          const state = host.create();

          expect(state.failure).not.toBeNull();
          expect(state.failure!.rolledBack).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('∀ host failure point and bounds: hostHwnd === null and active === false', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...HOST_FAILURE_POINTS),
        arbBounds,
        (failurePoint, bounds) => {
          activeFailurePoint = failurePoint;

          const opts: StealthHostOptions = {
            bounds,
            strategy: 'reparent',
          };

          const host = createStealthHost(opts);
          const state = host.create();

          expect(state.hostHwnd).toBeNull();
          expect(state.active).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('∀ host failure point: degraded host methods are safe no-ops', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...HOST_FAILURE_POINTS),
        arbBounds,
        (failurePoint, bounds) => {
          activeFailurePoint = failurePoint;

          const opts: StealthHostOptions = {
            bounds,
            strategy: 'reparent',
          };

          const host = createStealthHost(opts);
          host.create();

          // All operations on a degraded host should be safe no-ops
          expect(host.show()).toBe(false);
          expect(host.hide()).toBe(false);
          expect(host.reassert()).toBe(false);
          expect(host.setBounds({ x: 0, y: 0, width: 100, height: 100 })).toBe(false);

          // destroy should not throw
          expect(() => host.destroy()).not.toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });

  it('∀ host failure point: getState() returns consistent degraded state', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...HOST_FAILURE_POINTS),
        arbBounds,
        (failurePoint, bounds) => {
          activeFailurePoint = failurePoint;

          const opts: StealthHostOptions = {
            bounds,
            strategy: 'reparent',
          };

          const host = createStealthHost(opts);
          host.create();

          const state = host.getState();

          // Consistent degraded state
          expect(state.strategy).toBe('none');
          expect(state.hostHwnd).toBeNull();
          expect(state.active).toBe(false);
          expect(state.failure).not.toBeNull();
          expect(state.failure!.rolledBack).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('∀ host failure point with "layered" strategy: same degradation guarantees hold', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...HOST_FAILURE_POINTS),
        arbBounds,
        (failurePoint, bounds) => {
          activeFailurePoint = failurePoint;

          const opts: StealthHostOptions = {
            bounds,
            strategy: 'layered',
          };

          const host = createStealthHost(opts);
          const state = host.create();

          expect(state.strategy).toBe('none');
          expect(state.failure).not.toBeNull();
          expect(state.failure!.rolledBack).toBe(true);
          expect(state.hostHwnd).toBeNull();
          expect(state.active).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('∀ host failure point: failure stage is correctly identified', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...HOST_FAILURE_POINTS),
        (failurePoint) => {
          activeFailurePoint = failurePoint;

          const opts: StealthHostOptions = {
            bounds: { x: 0, y: 0, width: 800, height: 600 },
            strategy: 'reparent',
          };

          const host = createStealthHost(opts);
          const state = host.create();

          const expectedStageMap: Record<HostFailurePoint, string> = {
            'ffi-load': 'ffi',
            'wndproc-registration': 'wndproc',
            'register-class': 'register-class',
            'create-window': 'create-window',
          };

          expect(state.failure!.stage).toBe(expectedStageMap[failurePoint]);
        },
      ),
      { numRuns: 100 },
    );
  });

  // ── Self-check failure (failure point 5: reparent module) ──────────────

  it('self-check failure during adopt(): result indicates failure with rolledBack = true', () => {
    fc.assert(
      fc.property(
        arbBounds,
        (bounds) => {
          activeFailurePoint = 'self-check';

          // createReparenter needs a real-looking FFI
          const ffi = createFakeFfi();
          const reparenter = createReparenter(ffi as any);

          const result = reparenter.adopt(FAKE_HOST_HWND, FAKE_CHILD_HWND);

          // Self-check fails because GetParent returns wrong value
          expect(result.success).toBe(false);
          expect(result.failure).toBeDefined();
          expect(result.failure!.rolledBack).toBe(true);

          // After failed adopt, state indicates no active adoption
          const state = reparenter.getState();
          expect(state.adopted).toBe(false);
          expect(state.hostHwnd).toBeNull();
          expect(state.childHwnd).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('self-check failure: reparenter state is fully reset (no lingering references)', () => {
    activeFailurePoint = 'self-check';

    const ffi = createFakeFfi();
    const reparenter = createReparenter(ffi as any);

    const result = reparenter.adopt(FAKE_HOST_HWND, FAKE_CHILD_HWND);

    expect(result.success).toBe(false);
    expect(result.failure!.rolledBack).toBe(true);

    // State must be fully clean
    const state = reparenter.getState();
    expect(state.adopted).toBe(false);
    expect(state.hostHwnd).toBeNull();
    expect(state.childHwnd).toBeNull();
    expect(state.savedStyle).toBe(0);
    expect(state.savedExStyle).toBe(0);
    expect(state.savedRect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  // ── strategy 'none' is a no-op, not a degradation ─────────────────────

  it('∀ bounds: strategy "none" short-circuits with no failure (not a degradation)', () => {
    fc.assert(
      fc.property(
        arbBounds,
        (bounds) => {
          activeFailurePoint = null;

          const opts: StealthHostOptions = {
            bounds,
            strategy: 'none',
          };

          const host = createStealthHost(opts);
          const state = host.getState();

          // strategy 'none' yields a no-op host, not a failure
          expect(state.strategy).toBe('none');
          expect(state.failure).toBeNull();
          expect(state.hostHwnd).toBeNull();
          expect(state.active).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
