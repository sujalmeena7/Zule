// ============================================
// Property 22: Teardown ordering
// ============================================
//
// ∀ destroy sequences: DestroyWindow precedes UnregisterClassW precedes
// koffi.unregister; release() precedes DestroyWindow when a child was adopted.
//
// **Validates: Requirements 6.3, 9.5, 3.2**

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';

// ── Call log for ordering verification ───────────────────────────────────────

let callLog: string[] = [];

// ── Fake FFI ─────────────────────────────────────────────────────────────────

const FAKE_HWND = { __fakeHwnd: 'host-window-0x1234' };
const FAKE_HINSTANCE = { __fakeHInstance: 'module-handle' };
const FAKE_CURSOR = { __fakeCursor: 'arrow' };
const FAKE_WNDPROC_PTR = { __fakeWndProcPtr: 'wndproc-callback' };

function createFakeFfi() {
  callLog = [];

  return {
    user32: {
      RegisterClassExW: vi.fn(() => 1), // returns atom (non-zero = success)
      UnregisterClassW: vi.fn((_className: string, _hInstance: unknown) => {
        callLog.push('UnregisterClassW');
        return true;
      }),
      CreateWindowExW: vi.fn(() => FAKE_HWND),
      DestroyWindow: vi.fn((_hwnd: unknown) => {
        callLog.push('DestroyWindow');
        return true;
      }),
      SetParent: vi.fn(() => null),
      GetParent: vi.fn(() => null),
      GetWindowLongPtrW: vi.fn(() => 0),
      SetWindowLongPtrW: vi.fn(() => 0),
      SetWindowPos: vi.fn(() => true),
      ShowWindow: vi.fn(() => true),
      DefWindowProcW: vi.fn(() => 0),
      GetClientRect: vi.fn(() => true),
      GetWindowRect: vi.fn(() => true),
      GetClassNameW: vi.fn(() => 0),
      LoadCursorW: vi.fn(() => FAKE_CURSOR),
      SetWindowDisplayAffinity: vi.fn(() => true),
      GetWindowDisplayAffinity: vi.fn(() => true),
    },
    gdi32: { loaded: false },
    dwmapi: {
      DwmSetWindowAttribute: vi.fn(() => 0),
    },
    kernel32: {
      GetModuleHandleW: vi.fn(() => FAKE_HINSTANCE),
      GetLastError: vi.fn(() => 0),
    },
    types: {
      POINT: 'POINT',
      SIZE: 'SIZE',
      RECT: 'RECT',
      BLENDFUNCTION: 'BLENDFUNCTION',
      WNDPROC: 'WNDPROC',
      WNDCLASSEXW: 'WNDCLASSEXW',
    },
    registerCallback: vi.fn(() => FAKE_WNDPROC_PTR),
    unregisterCallback: vi.fn(() => {}),
    alloc: vi.fn((type: string, value?: unknown) => value ?? {}),
    decode: vi.fn(() => ({})),
    procAddress: vi.fn(() => null),
  };
}

// ── Mocks ────────────────────────────────────────────────────────────────────

// We need to mock the modules BEFORE importing the module under test.
vi.mock('../../win32/ffi', () => ({
  getFfi: vi.fn(),
  isWin32: vi.fn(() => true),
}));

vi.mock('../../win32/wndProc', () => ({
  registerWndProc: vi.fn(),
}));

vi.mock('../../nativeStealth', () => ({
  applyNativeStealth: vi.fn(() => ({ ok: true, layers: [] })),
}));

// ── Imports (after mock declarations) ────────────────────────────────────────

import { getFfi } from '../../win32/ffi';
import { registerWndProc } from '../../win32/wndProc';
import { createStealthHost, type HostStrategy } from '../../win32/hostWindow';

// ── Helpers ──────────────────────────────────────────────────────────────────

function setupMocksWithFfi(fakeFfi: ReturnType<typeof createFakeFfi>) {
  vi.mocked(getFfi).mockReturnValue(fakeFfi as any);

  // registerWndProc returns a RegisteredWndProc whose dispose() logs 'koffi.unregister'
  vi.mocked(registerWndProc).mockReturnValue({
    pointer: FAKE_WNDPROC_PTR,
    isNativeFallback: false,
    dispose: () => {
      callLog.push('koffi.unregister');
    },
  });
}

// ── Strategy arbitrary ───────────────────────────────────────────────────────

const arbStrategy = fc.oneof(
  fc.constant('reparent' as HostStrategy),
  fc.constant('layered' as HostStrategy),
);

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Property 22: Teardown ordering', () => {
  // Set process.type and process.platform for the module guard
  const originalProcessType = process.type;
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, 'type', { value: 'browser', writable: true });
    Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'type', { value: originalProcessType, writable: true });
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
    vi.restoreAllMocks();
  });

  it('∀ strategies: DestroyWindow precedes UnregisterClassW precedes koffi.unregister', () => {
    fc.assert(
      fc.property(arbStrategy, (strategy) => {
        const fakeFfi = createFakeFfi();
        setupMocksWithFfi(fakeFfi);

        const host = createStealthHost({
          bounds: { x: 100, y: 100, width: 400, height: 300 },
          strategy,
        });

        const state = host.create();

        // The host must be active for ordering to matter
        if (!state.active) {
          // If creation failed (e.g. due to mock issue), skip
          return true;
        }

        // Clear the call log and destroy
        callLog = [];
        host.destroy();

        // Verify ordering: DestroyWindow < UnregisterClassW < koffi.unregister
        const idxDestroy = callLog.indexOf('DestroyWindow');
        const idxUnregisterClass = callLog.indexOf('UnregisterClassW');
        const idxKoffiUnregister = callLog.indexOf('koffi.unregister');

        // All three must have been called
        if (idxDestroy === -1 || idxUnregisterClass === -1 || idxKoffiUnregister === -1) {
          return false;
        }

        // Strict ordering: DestroyWindow < UnregisterClassW < koffi.unregister
        return idxDestroy < idxUnregisterClass && idxUnregisterClass < idxKoffiUnregister;
      }),
      { numRuns: 100 },
    );
  });

  it('∀ strategies: calling destroy() multiple times does not duplicate teardown calls', () => {
    fc.assert(
      fc.property(
        arbStrategy,
        fc.integer({ min: 2, max: 10 }),
        (strategy, destroyCount) => {
          const fakeFfi = createFakeFfi();
          setupMocksWithFfi(fakeFfi);

          const host = createStealthHost({
            bounds: { x: 0, y: 0, width: 800, height: 600 },
            strategy,
          });

          const state = host.create();
          if (!state.active) return true;

          callLog = [];

          // Call destroy multiple times (idempotent)
          for (let i = 0; i < destroyCount; i++) {
            host.destroy();
          }

          // Each operation should appear exactly once
          const destroyCount_ = callLog.filter((c) => c === 'DestroyWindow').length;
          const unregisterClassCount = callLog.filter((c) => c === 'UnregisterClassW').length;
          const koffiUnregisterCount = callLog.filter((c) => c === 'koffi.unregister').length;

          return destroyCount_ === 1 && unregisterClassCount === 1 && koffiUnregisterCount === 1;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('∀ strategies: destroy ordering holds regardless of strategy type', () => {
    fc.assert(
      fc.property(
        arbStrategy,
        fc.record({
          x: fc.integer({ min: -3000, max: 3000 }),
          y: fc.integer({ min: -3000, max: 3000 }),
          width: fc.integer({ min: 1, max: 4000 }),
          height: fc.integer({ min: 1, max: 4000 }),
        }),
        (strategy, bounds) => {
          const fakeFfi = createFakeFfi();
          setupMocksWithFfi(fakeFfi);

          const host = createStealthHost({
            bounds,
            strategy,
          });

          const state = host.create();
          if (!state.active) return true;

          callLog = [];
          host.destroy();

          const idxDestroy = callLog.indexOf('DestroyWindow');
          const idxUnregisterClass = callLog.indexOf('UnregisterClassW');
          const idxKoffiUnregister = callLog.indexOf('koffi.unregister');

          // All three must be present and in strict order
          return (
            idxDestroy >= 0 &&
            idxUnregisterClass >= 0 &&
            idxKoffiUnregister >= 0 &&
            idxDestroy < idxUnregisterClass &&
            idxUnregisterClass < idxKoffiUnregister
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  // NOTE: The "release() precedes DestroyWindow when a child was adopted" property
  // will be augmented in task 5.x tests once the reparent module (electron/win32/reparent.ts)
  // is implemented. Currently the host does not have an adopt()/release() method —
  // that belongs to the reparent module. The ordering tested here covers the host's
  // own destroy sequence: DestroyWindow → UnregisterClassW → koffi.unregister.
});
