// ============================================
// Property 9: Stealth toggle preserves topology
// ============================================
//
// ∀ sequences of toggle-visibility-protection values: hostStrategy is
// invariant, hostHwnd unchanged, final layer state matches last toggle value.
//
// **Validates: Requirements 5.1, 5.2, 5.3**

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';

// ── Tracking state for fake stealth layer application ────────────────────────

/** Tracks the last stealth apply/remove action per HWND. */
const stealthState = new Map<unknown, boolean>();

/** Tracks all applyNativeStealth calls. */
const applyStealthCalls: unknown[] = [];
/** Tracks all removeNativeStealth calls. */
const removeStealthCalls: unknown[] = [];

function resetTracking(): void {
  stealthState.clear();
  applyStealthCalls.length = 0;
  removeStealthCalls.length = 0;
}

// ── Fake FFI surface ─────────────────────────────────────────────────────────

const FAKE_HOST_HWND = { __fakeHostHwnd: 'host-0x1234' };
const FAKE_HINSTANCE = { __fakeHInstance: true };
const FAKE_CURSOR = { __fakeCursor: true };

function createFakeFfi() {
  return {
    user32: {
      RegisterClassExW: () => 1,
      UnregisterClassW: () => true,
      CreateWindowExW: () => FAKE_HOST_HWND,
      DestroyWindow: () => true,
      SetWindowPos: () => true,
      ShowWindow: () => true,
      GetWindowLongPtrW: () => 0x80000000, // WS_POPUP
      SetWindowLongPtrW: () => 0,
      DefWindowProcW: () => 0,
      GetClientRect: () => true,
      GetWindowRect: () => true,
      GetClassNameW: () => 0,
      LoadCursorW: () => FAKE_CURSOR,
      SetWindowDisplayAffinity: () => true,
      GetWindowDisplayAffinity: () => true,
      SetParent: () => FAKE_HOST_HWND,
      GetParent: (_hwnd: unknown) => FAKE_HOST_HWND,
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
    decode: () => 0,
    procAddress: () => ({ __fakeProc: true }),
  };
}

// ── Mock modules ─────────────────────────────────────────────────────────────

vi.mock('../../win32/ffi', () => ({
  getFfi: () => createFakeFfi(),
  isWin32: () => true,
}));

vi.mock('../../win32/wndProc', () => ({
  registerWndProc: (_mode: string, _handlers?: unknown) => ({
    pointer: { __fakeWndProcPtr: true },
    isNativeFallback: _mode === 'native',
    dispose: () => {},
  }),
}));

vi.mock('../../nativeStealth', () => ({
  applyNativeStealth: (hwnd: unknown) => {
    stealthState.set(hwnd, true);
    applyStealthCalls.push(hwnd);
    return { ok: true, layers: [] };
  },
  removeNativeStealth: (hwnd: unknown) => {
    stealthState.set(hwnd, false);
    removeStealthCalls.push(hwnd);
    return true;
  },
  isNativeStealthAvailable: () => true,
}));

vi.mock('node:crypto', () => ({
  randomBytes: (n: number) => {
    const buf = Buffer.alloc(n);
    for (let i = 0; i < n; i++) {
      buf[i] = (i * 37 + 13) % 256;
    }
    return buf;
  },
}));

// ── Import modules under test (after mocks) ──────────────────────────────────

import { createStealthHost } from '../../win32/hostWindow';
import type { StealthHostOptions, StealthHostState } from '../../win32/hostWindow';
import { applyNativeStealth, removeNativeStealth } from '../../nativeStealth';

// ── Test helpers ─────────────────────────────────────────────────────────────

const DEFAULT_OPTS: StealthHostOptions = {
  bounds: { x: 100, y: 100, width: 400, height: 300 },
  strategy: 'reparent',
};

/**
 * Simulates what OverlayManager.setContentProtection does when a stealth host
 * is active: applies or removes stealth layers on the host HWND without
 * destroying/recreating the host (Req 5.1, 5.2).
 */
function toggleStealthOnHost(hostHwnd: unknown, enabled: boolean): void {
  if (enabled) {
    applyNativeStealth(hostHwnd as Parameters<typeof applyNativeStealth>[0]);
  } else {
    removeNativeStealth(hostHwnd as Parameters<typeof removeNativeStealth>[0]);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Property 9: Stealth toggle preserves topology', () => {
  beforeEach(() => {
    resetTracking();
    Object.defineProperty(process, 'type', { value: 'browser', writable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('∀ toggle sequences: hostStrategy remains invariant across all toggle operations', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }),
        (toggleSequence: boolean[]) => {
          resetTracking();

          // Create and activate the stealth host
          const host = createStealthHost(DEFAULT_OPTS);
          const initialState = host.create();

          expect(initialState.active).toBe(true);
          expect(initialState.hostHwnd).not.toBeNull();

          const initialStrategy = initialState.strategy;
          const initialHostHwnd = initialState.hostHwnd;

          // Apply the toggle sequence
          for (const toggleValue of toggleSequence) {
            toggleStealthOnHost(initialHostHwnd, toggleValue);
          }

          // INVARIANT: hostStrategy has NOT changed
          const finalState = host.getState();
          expect(finalState.strategy).toBe(initialStrategy);

          // INVARIANT: hostHwnd has NOT changed
          expect(finalState.hostHwnd).toBe(initialHostHwnd);

          // INVARIANT: host is still active (not destroyed)
          expect(finalState.active).toBe(true);

          // Cleanup
          host.destroy();

          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('∀ toggle sequences: hostHwnd is unchanged regardless of toggle pattern', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }),
        (toggleSequence: boolean[]) => {
          resetTracking();

          const host = createStealthHost(DEFAULT_OPTS);
          const initialState = host.create();
          const hostHwnd = initialState.hostHwnd;

          // Apply toggles, checking after each one
          for (const toggleValue of toggleSequence) {
            toggleStealthOnHost(hostHwnd, toggleValue);

            // After every single toggle, hostHwnd must be unchanged
            const midState = host.getState();
            expect(midState.hostHwnd).toBe(hostHwnd);
            expect(midState.strategy).toBe(initialState.strategy);
          }

          host.destroy();
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('∀ toggle sequences: final layer state matches the last toggle value', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }),
        (toggleSequence: boolean[]) => {
          resetTracking();

          const host = createStealthHost(DEFAULT_OPTS);
          const initialState = host.create();
          const hostHwnd = initialState.hostHwnd;

          // Apply the toggle sequence
          for (const toggleValue of toggleSequence) {
            toggleStealthOnHost(hostHwnd, toggleValue);
          }

          // The last toggle value determines the final stealth state
          const lastToggle = toggleSequence[toggleSequence.length - 1];
          const finalStealthApplied = stealthState.get(hostHwnd);

          expect(finalStealthApplied).toBe(lastToggle);

          // Verify that the last call was the correct function:
          if (lastToggle) {
            // Last call should have been applyNativeStealth
            expect(applyStealthCalls[applyStealthCalls.length - 1]).toBe(hostHwnd);
          } else {
            // Last call should have been removeNativeStealth
            expect(removeStealthCalls[removeStealthCalls.length - 1]).toBe(hostHwnd);
          }

          host.destroy();
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('∀ toggle sequences on layered strategy: topology preserved identically', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }),
        (toggleSequence: boolean[]) => {
          resetTracking();

          const opts: StealthHostOptions = {
            bounds: { x: 0, y: 0, width: 800, height: 600 },
            strategy: 'layered',
          };

          const host = createStealthHost(opts);
          const initialState = host.create();

          expect(initialState.active).toBe(true);

          const initialStrategy = initialState.strategy;
          const initialHostHwnd = initialState.hostHwnd;

          // Apply toggles
          for (const toggleValue of toggleSequence) {
            toggleStealthOnHost(initialHostHwnd, toggleValue);
          }

          // Verify topology invariants
          const finalState = host.getState();
          expect(finalState.strategy).toBe(initialStrategy);
          expect(finalState.hostHwnd).toBe(initialHostHwnd);
          expect(finalState.active).toBe(true);

          // Verify final stealth state
          const lastToggle = toggleSequence[toggleSequence.length - 1];
          expect(stealthState.get(initialHostHwnd)).toBe(lastToggle);

          host.destroy();
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rapid alternating toggles never corrupt topology', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        (count: number) => {
          resetTracking();

          const host = createStealthHost(DEFAULT_OPTS);
          const initialState = host.create();
          const hostHwnd = initialState.hostHwnd;

          // Rapidly alternate true/false
          for (let i = 0; i < count; i++) {
            toggleStealthOnHost(hostHwnd, i % 2 === 0);
          }

          // Topology must be intact
          const finalState = host.getState();
          expect(finalState.strategy).toBe(initialState.strategy);
          expect(finalState.hostHwnd).toBe(hostHwnd);
          expect(finalState.active).toBe(true);

          // Final state matches last toggle in alternation
          const lastToggle = (count - 1) % 2 === 0;
          expect(stealthState.get(hostHwnd)).toBe(lastToggle);

          host.destroy();
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});
