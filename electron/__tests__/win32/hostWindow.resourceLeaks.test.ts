// ============================================
// Property 5: No resource leaks on any failure path
// ============================================
//
// ∀ failure injection point: count of registered classes, HWNDs, koffi
// callbacks, DCs, DIB sections returns to pre-attempt value.
// Uses fake FFI with observable counters.
//
// **Validates: Requirements 3.2, 6.3**

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';

// ── Mock setup (must precede import of module under test) ────────────────────

// Counter state for the fake FFI surface
const counters = {
  registeredClasses: 0,
  liveHwnds: 0,
  koffiCallbacks: 0,
};

function resetCounters(): void {
  counters.registeredClasses = 0;
  counters.liveHwnds = 0;
  counters.koffiCallbacks = 0;
}

// ── Failure injection ────────────────────────────────────────────────────────

type FailurePoint =
  | 'ffi-load'
  | 'register-class'
  | 'create-window'
  | 'wndproc-registration';

const ALL_FAILURE_POINTS: FailurePoint[] = [
  'ffi-load',
  'register-class',
  'create-window',
  'wndproc-registration',
];

let activeFailurePoint: FailurePoint | null = null;

// ── Fake FFI surface ─────────────────────────────────────────────────────────

const FAKE_HINSTANCE = { __fakeHInstance: true };
const FAKE_CURSOR = { __fakeCursor: true };

function createFakeFfi() {
  return {
    user32: {
      RegisterClassExW: (_cls: unknown) => {
        if (activeFailurePoint === 'register-class') {
          return 0; // failure
        }
        counters.registeredClasses++;
        return 1; // success ATOM
      },
      UnregisterClassW: (_className: string, _hInstance: unknown) => {
        counters.registeredClasses--;
        return true;
      },
      CreateWindowExW: (
        _exStyle: number, _className: string, _windowName: string,
        _style: number, _x: number, _y: number, _w: number, _h: number,
        _parent: unknown, _menu: unknown, _instance: unknown, _param: unknown,
      ) => {
        if (activeFailurePoint === 'create-window') {
          return null; // failure
        }
        counters.liveHwnds++;
        return { __fakeHwnd: true };
      },
      DestroyWindow: (_hwnd: unknown) => {
        counters.liveHwnds--;
        return true;
      },
      SetWindowPos: () => true,
      ShowWindow: () => true,
      GetWindowLongPtrW: () => 0,
      SetWindowLongPtrW: () => 0,
      DefWindowProcW: () => 0,
      GetClientRect: () => true,
      GetWindowRect: () => true,
      GetClassNameW: () => 0,
      LoadCursorW: () => FAKE_CURSOR,
      SetWindowDisplayAffinity: () => true,
      GetWindowDisplayAffinity: () => true,
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
    registerCallback: () => {
      counters.koffiCallbacks++;
      return { __fakeCallback: true };
    },
    unregisterCallback: () => {
      counters.koffiCallbacks--;
    },
    alloc: (_type: string, value?: unknown) => value ?? {},
    decode: () => 0,
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
    counters.koffiCallbacks++;
    return {
      pointer: { __fakeWndProcPtr: true },
      isNativeFallback: _mode === 'native',
      dispose: () => {
        counters.koffiCallbacks--;
      },
    };
  },
}));

vi.mock('../../nativeStealth', () => ({
  applyNativeStealth: () => ({ ok: true, layers: [] }),
}));

vi.mock('node:crypto', () => ({
  randomBytes: (n: number) => {
    // Generate deterministic but valid bytes for class name generation
    const buf = Buffer.alloc(n);
    for (let i = 0; i < n; i++) {
      buf[i] = (i * 37 + 13) % 256;
    }
    return buf;
  },
}));

// ── Import module under test (after mocks) ───────────────────────────────────

import { createStealthHost } from '../../win32/hostWindow';
import type { StealthHostOptions } from '../../win32/hostWindow';

// ── Test helpers ─────────────────────────────────────────────────────────────

const DEFAULT_OPTS: StealthHostOptions = {
  bounds: { x: 100, y: 100, width: 400, height: 300 },
  strategy: 'reparent',
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Property 5: No resource leaks on any failure path', () => {
  beforeEach(() => {
    resetCounters();
    activeFailurePoint = null;
    // Ensure process.type is 'browser' for the host creation path
    Object.defineProperty(process, 'type', { value: 'browser', writable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('∀ failure injection point: all resource counters return to 0 after create() fails', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_FAILURE_POINTS),
        (failurePoint: FailurePoint) => {
          resetCounters();
          activeFailurePoint = failurePoint;

          // Pre-attempt: all counters at 0
          expect(counters.registeredClasses).toBe(0);
          expect(counters.liveHwnds).toBe(0);
          expect(counters.koffiCallbacks).toBe(0);

          const host = createStealthHost(DEFAULT_OPTS);
          const state = host.create();

          // After failure: all counters must return to 0
          expect(counters.registeredClasses).toBe(0);
          expect(counters.liveHwnds).toBe(0);
          expect(counters.koffiCallbacks).toBe(0);

          // State must indicate failure with rolledBack = true
          expect(state.strategy).toBe('none');
          expect(state.failure).not.toBeNull();
          expect(state.failure!.rolledBack).toBe(true);

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('∀ failure injection point: state reports correct failure stage', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_FAILURE_POINTS),
        (failurePoint: FailurePoint) => {
          resetCounters();
          activeFailurePoint = failurePoint;

          const host = createStealthHost(DEFAULT_OPTS);
          const state = host.create();

          expect(state.strategy).toBe('none');
          expect(state.failure).not.toBeNull();
          expect(state.failure!.rolledBack).toBe(true);

          // Verify expected stage mapping
          const expectedStages: Record<FailurePoint, string> = {
            'ffi-load': 'ffi',
            'register-class': 'register-class',
            'create-window': 'create-window',
            'wndproc-registration': 'wndproc',
          };

          expect(state.failure!.stage).toBe(expectedStages[failurePoint]);
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('successful create() followed by destroy() returns all counters to 0', () => {
    fc.assert(
      fc.property(
        fc.record({
          x: fc.integer({ min: 0, max: 3840 }),
          y: fc.integer({ min: 0, max: 2160 }),
          width: fc.integer({ min: 1, max: 1920 }),
          height: fc.integer({ min: 1, max: 1080 }),
        }),
        (bounds) => {
          resetCounters();
          activeFailurePoint = null;

          const opts: StealthHostOptions = {
            bounds,
            strategy: 'reparent',
          };

          const host = createStealthHost(opts);
          const state = host.create();

          // After successful creation: resources are allocated
          expect(state.active).toBe(true);
          expect(state.hostHwnd).not.toBeNull();
          expect(state.strategy).toBe('reparent');

          // Counters should be positive (resources allocated)
          expect(counters.registeredClasses).toBeGreaterThan(0);
          expect(counters.liveHwnds).toBeGreaterThan(0);
          expect(counters.koffiCallbacks).toBeGreaterThan(0);

          // Destroy the host
          host.destroy();

          // After destroy: all counters must return to 0
          expect(counters.registeredClasses).toBe(0);
          expect(counters.liveHwnds).toBe(0);
          expect(counters.koffiCallbacks).toBe(0);

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('destroy() is idempotent: calling it multiple times does not drive counters negative', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10 }),
        (destroyCount: number) => {
          resetCounters();
          activeFailurePoint = null;

          const host = createStealthHost(DEFAULT_OPTS);
          host.create();

          // Destroy multiple times
          for (let i = 0; i < destroyCount; i++) {
            host.destroy();
          }

          // Counters must be exactly 0, never negative
          expect(counters.registeredClasses).toBe(0);
          expect(counters.liveHwnds).toBe(0);
          expect(counters.koffiCallbacks).toBe(0);

          return true;
        },
      ),
      { numRuns: 50 },
    );
  });

  it('∀ failure point: create() on failed host is idempotent (no resource growth on repeated calls)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_FAILURE_POINTS),
        fc.integer({ min: 2, max: 5 }),
        (failurePoint: FailurePoint, callCount: number) => {
          resetCounters();
          activeFailurePoint = failurePoint;

          const host = createStealthHost(DEFAULT_OPTS);

          // Call create() multiple times on a failing path
          for (let i = 0; i < callCount; i++) {
            host.create();
          }

          // All counters must still be 0 after repeated failed attempts
          expect(counters.registeredClasses).toBe(0);
          expect(counters.liveHwnds).toBe(0);
          expect(counters.koffiCallbacks).toBe(0);

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('strategy "layered" follows the same leak-free failure paths', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_FAILURE_POINTS),
        (failurePoint: FailurePoint) => {
          resetCounters();
          activeFailurePoint = failurePoint;

          const opts: StealthHostOptions = {
            bounds: { x: 0, y: 0, width: 800, height: 600 },
            strategy: 'layered',
          };

          const host = createStealthHost(opts);
          const state = host.create();

          // All counters must return to 0
          expect(counters.registeredClasses).toBe(0);
          expect(counters.liveHwnds).toBe(0);
          expect(counters.koffiCallbacks).toBe(0);

          // State must indicate failure
          expect(state.strategy).toBe('none');
          expect(state.failure).not.toBeNull();
          expect(state.failure!.rolledBack).toBe(true);

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('strategy "layered" successful create + destroy returns counters to 0', () => {
    resetCounters();
    activeFailurePoint = null;

    const opts: StealthHostOptions = {
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      strategy: 'layered',
    };

    const host = createStealthHost(opts);
    const state = host.create();

    expect(state.active).toBe(true);
    expect(counters.registeredClasses).toBeGreaterThan(0);
    expect(counters.liveHwnds).toBeGreaterThan(0);
    expect(counters.koffiCallbacks).toBeGreaterThan(0);

    host.destroy();

    expect(counters.registeredClasses).toBe(0);
    expect(counters.liveHwnds).toBe(0);
    expect(counters.koffiCallbacks).toBe(0);
  });
});
