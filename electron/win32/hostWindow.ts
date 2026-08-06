// ============================================
// Zule AI — Stealth Window Host Lifecycle
// ============================================
//
// Creates and manages a custom Win32 window (Stealth Host) with a randomized
// class name to conceal the overlay's Chromium `Chrome_WidgetWin_1` from
// `EnumWindows` + `GetClassName` scanners.
//
// Requirements: 1.1, 1.4, 2.1, 3.1, 3.2, 3.4, 3.5, 6.3, 9.5, 10.1

import { getFfi, isWin32 } from './ffi';
import type { HwndPtr, Win32Ffi } from './ffi';
import { registerWndProc } from './wndProc';
import type { RegisteredWndProc, WndProcHandlers } from './wndProc';
import { applyNativeStealth } from '../nativeStealth';
import * as crypto from 'node:crypto';

// ── Public Types ─────────────────────────────────────────────────────────────

export type HostStrategy = 'reparent' | 'layered' | 'none';

export interface StealthHostOptions {
  /** Initial screen-space bounds (device-independent, from Electron). */
  bounds: Electron.Rectangle;
  /** Strategy to attempt. 'none' short-circuits to Layer 0. */
  strategy: HostStrategy;
  /** Called when the host window is destroyed by the OS unexpectedly. */
  onLost?: (reason: string) => void;
}

export interface StealthHostState {
  readonly strategy: HostStrategy;
  /** Randomized class name actually registered, e.g. 'InputHelper_29847'. */
  readonly className: string | null;
  readonly hostHwnd: HwndPtr | null;
  /** True once the host exists AND stealth layers are applied to it. */
  readonly active: boolean;
  /** Populated when a stage was attempted and rolled back. */
  readonly failure: HostFailure | null;
}

export interface HostFailure {
  stage: 'ffi' | 'register-class' | 'create-window' | 'reparent'
       | 'self-check' | 'stealth' | 'paint' | 'wndproc';
  detail: string;
  /** True when rollback to the previous topology completed cleanly. */
  rolledBack: boolean;
}

export interface StealthHost {
  getState(): StealthHostState;
  /** Create the host window. Idempotent: a second call is a no-op returning the same state. */
  create(): StealthHostState;
  show(): boolean;
  hide(): boolean;
  /** Re-assert HWND_TOPMOST + stealth layers (called after show/display change). */
  reassert(): boolean;
  /** Move/resize the host in screen space. */
  setBounds(bounds: Electron.Rectangle): boolean;
  /** Destroy the host. Idempotent. */
  destroy(): void;
}

// ── Win32 Constants ──────────────────────────────────────────────────────────

const WS_POPUP = 0x80000000;
const WS_CLIPCHILDREN = 0x02000000;

const WS_EX_LAYERED = 0x00080000;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_NOACTIVATE = 0x08000000;

const SW_SHOW = 5;
const SW_HIDE = 0;

const SWP_NOMOVE = 0x0002;
const SWP_NOSIZE = 0x0001;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;

const CS_HREDRAW = 0x0002;
const CS_VREDRAW = 0x0001;

const ERROR_CLASS_ALREADY_EXISTS = 0x582; // 1410

const WM_DESTROY = 0x0002;

// ── Blocklist ────────────────────────────────────────────────────────────────

const CLASS_NAME_BLOCKLIST = ['chrome', 'electron', 'zule', 'overlay', 'widget'];

// ── randomClassName ──────────────────────────────────────────────────────────

/**
 * Generate a random window class name matching `/^[A-Za-z][A-Za-z0-9_]{5,31}$/`.
 * Rejects names containing any blocklisted substring (case-insensitive).
 * Exported for testing.
 */
export function randomClassName(): string {
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const ALNUM_UNDERSCORE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_';

  // Length between 6 and 32 (first char + 5..31 more)
  for (;;) {
    // Need up to 33 bytes: 1 for length, 1 for first char, up to 31 for remaining chars
    const bytes = crypto.randomBytes(33);
    // Use first byte to pick length between 6 and 32 total chars
    const totalLen = 6 + (bytes[0] % 27); // 6..32

    let name = ALPHA[bytes[1] % ALPHA.length];
    for (let i = 1; i < totalLen; i++) {
      name += ALNUM_UNDERSCORE[bytes[i + 1] % ALNUM_UNDERSCORE.length];
    }

    // Blocklist check (case-insensitive)
    const lower = name.toLowerCase();
    const blocked = CLASS_NAME_BLOCKLIST.some((word) => lower.includes(word));
    if (blocked) {
      continue; // retry
    }

    return name;
  }
}

// ── Layer 0 (no-op) state factory ────────────────────────────────────────────

function makeLayer0State(failure?: HostFailure): StealthHostState {
  return {
    strategy: 'none',
    className: null,
    hostHwnd: null,
    active: false,
    failure: failure ?? null,
  };
}

// ── createStealthHost ────────────────────────────────────────────────────────

/**
 * Create a Stealth Host following the design's algorithmic pseudocode:
 *   platform guard → getFfi → assert browser process → randomize class →
 *   register WNDPROC → RegisterClassExW → CreateWindowExW →
 *   apply stealth layers to host → SetWindowPos HWND_TOPMOST
 *
 * Graceful failure at every step: returns Layer 0 with `failure.rolledBack = true`.
 */
export function createStealthHost(opts: StealthHostOptions): StealthHost {
  // ── Platform guard (Req 10.1) ──────────────────────────────────────────
  if (!isWin32() || opts.strategy === 'none') {
    return makeNoOpHost();
  }

  // ── Internal mutable state ─────────────────────────────────────────────
  let state: StealthHostState = makeLayer0State();
  let ffi: Win32Ffi | null = null;
  let registeredProc: RegisteredWndProc | null = null;
  let hInstance: HwndPtr | null = null;
  let destroyed = false;
  let destroyInitiatedByUs = false;

  // onLost callback for unexpected WM_DESTROY
  const onLost = opts.onLost;

  // WndProc handlers for JS mode (Stage B / layered strategy)
  const jsHandlers: WndProcHandlers | undefined = opts.strategy === 'layered'
    ? {
        onMessage(msg: number, _wParam: number, _lParam: number) {
          if (msg === WM_DESTROY && !destroyInitiatedByUs) {
            // Unexpected destroy — fire onLost callback asynchronously
            if (onLost) {
              setImmediate(() => onLost('unexpected_destroy'));
            }
          }
          return null; // fall through to DefWindowProcW for all messages
        },
      }
    : undefined;

  // ── StealthHost implementation ─────────────────────────────────────────
  const host: StealthHost = {
    getState(): StealthHostState {
      return state;
    },

    create(): StealthHostState {
      // Idempotent: if already created, return current state
      if (state.active || state.hostHwnd !== null) {
        return state;
      }

      // ── Step 1: Get FFI ────────────────────────────────────────────────
      ffi = getFfi();
      if (!ffi) {
        state = makeLayer0State({
          stage: 'ffi',
          detail: 'koffi FFI unavailable',
          rolledBack: true,
        });
        return state;
      }

      // ── Step 2: Assert browser process (Req 9.7) ───────────────────────
      if (process.type !== 'browser') {
        state = makeLayer0State({
          stage: 'wndproc',
          detail: 'process.type is not "browser"',
          rolledBack: true,
        });
        return state;
      }

      // ── Step 3: Get hInstance ──────────────────────────────────────────
      hInstance = ffi.kernel32.GetModuleHandleW(null);

      // ── Step 4: Register WNDPROC ───────────────────────────────────────
      registeredProc = opts.strategy === 'layered'
        ? registerWndProc('js', jsHandlers)
        : registerWndProc('native');

      if (!registeredProc) {
        state = makeLayer0State({
          stage: 'wndproc',
          detail: 'Failed to register WNDPROC',
          rolledBack: true,
        });
        return state;
      }

      // ── Step 5: Generate class name & register ─────────────────────────
      let className = randomClassName();
      let atom = tryRegisterClass(ffi, className, registeredProc.pointer, hInstance);

      // Retry once on ERROR_CLASS_ALREADY_EXISTS with a new name
      if (atom === 0) {
        const lastError = ffi.kernel32.GetLastError();
        if (lastError === ERROR_CLASS_ALREADY_EXISTS) {
          className = randomClassName();
          atom = tryRegisterClass(ffi, className, registeredProc.pointer, hInstance);
        }
      }

      if (atom === 0) {
        const lastError = ffi.kernel32.GetLastError();
        registeredProc.dispose();
        registeredProc = null;
        state = makeLayer0State({
          stage: 'register-class',
          detail: `RegisterClassExW failed (error=${lastError})`,
          rolledBack: true,
        });
        return state;
      }

      // ── Step 6: CreateWindowExW ────────────────────────────────────────
      const exStyle = WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
      const style = WS_POPUP | WS_CLIPCHILDREN;

      const hwnd = ffi.user32.CreateWindowExW(
        exStyle,
        className,
        '', // empty window title
        style,
        opts.bounds.x,
        opts.bounds.y,
        opts.bounds.width,
        opts.bounds.height,
        null as unknown as HwndPtr, // no parent
        null as unknown as HwndPtr, // no menu
        hInstance,
        null as unknown as HwndPtr, // no param
      );

      if (!hwnd) {
        const lastError = ffi.kernel32.GetLastError();
        // Clean up: unregister class, dispose wndproc
        ffi.user32.UnregisterClassW(className, hInstance);
        registeredProc.dispose();
        registeredProc = null;
        state = makeLayer0State({
          stage: 'create-window',
          detail: `CreateWindowExW failed (error=${lastError})`,
          rolledBack: true,
        });
        return state;
      }

      // ── Step 7: Apply stealth layers to the HOST ───────────────────────
      const stealthResult = applyNativeStealth(hwnd as HwndPtr);
      if (!stealthResult.ok) {
        // Do NOT abort: class concealment still works even without stealth layers.
        // Record degradation but continue.
        console.warn(
          '[Win32/HostWindow] Stealth layers partially failed:',
          stealthResult.layers.filter((l) => !l.applied).map((l) => l.layer).join(', '),
        );
      }

      // ── Step 8: SetWindowPos HWND_TOPMOST ──────────────────────────────
      // HWND_TOPMOST = -1 as pointer. We pass -1 cast appropriately.
      // The FFI binds SetWindowPos with `void *insertAfter`, and koffi
      // handles negative numbers as pointers on x64.
      ffi.user32.SetWindowPos(
        hwnd,
        -1 as unknown as HwndPtr, // HWND_TOPMOST
        0,
        0,
        0,
        0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
      );

      // ── Success ────────────────────────────────────────────────────────
      state = {
        strategy: opts.strategy,
        className,
        hostHwnd: hwnd,
        active: true,
        failure: null,
      };
      destroyed = false;

      return state;
    },

    show(): boolean {
      if (!state.active || !state.hostHwnd || !ffi) return false;
      return ffi.user32.ShowWindow(state.hostHwnd, SW_SHOW);
    },

    hide(): boolean {
      if (!state.active || !state.hostHwnd || !ffi) return false;
      return ffi.user32.ShowWindow(state.hostHwnd, SW_HIDE);
    },

    reassert(): boolean {
      if (!state.active || !state.hostHwnd || !ffi) return false;

      // Re-assert HWND_TOPMOST
      ffi.user32.SetWindowPos(
        state.hostHwnd,
        -1 as unknown as HwndPtr, // HWND_TOPMOST
        0,
        0,
        0,
        0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
      );

      // Re-apply stealth layers
      applyNativeStealth(state.hostHwnd as HwndPtr);

      return true;
    },

    setBounds(bounds: Electron.Rectangle): boolean {
      if (!state.active || !state.hostHwnd || !ffi) return false;

      return ffi.user32.SetWindowPos(
        state.hostHwnd,
        null as unknown as HwndPtr, // no z-order change
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height,
        SWP_NOACTIVATE,
      );
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;

      if (!state.hostHwnd || !ffi) {
        // Nothing to destroy
        state = makeLayer0State();
        return;
      }

      const hwnd = state.hostHwnd;
      const className = state.className;

      // ── Destroy ordering (Req 6.3, 9.5) ─────────────────────────────
      // 1. DestroyWindow
      destroyInitiatedByUs = true;
      try {
        ffi.user32.DestroyWindow(hwnd);
      } catch {
        // Best-effort — continue cleanup
      }

      // 2. UnregisterClassW
      if (className && hInstance) {
        try {
          ffi.user32.UnregisterClassW(className, hInstance);
        } catch {
          // Best-effort
        }
      }

      // 3. koffi.unregister (via RegisteredWndProc.dispose)
      if (registeredProc) {
        registeredProc.dispose();
        registeredProc = null;
      }

      // Reset state
      state = makeLayer0State();
    },
  };

  return host;
}

// ── No-op host (for non-Windows or strategy === 'none') ──────────────────────

function makeNoOpHost(): StealthHost {
  const noOpState: StealthHostState = {
    strategy: 'none',
    className: null,
    hostHwnd: null,
    active: false,
    failure: null,
  };

  return {
    getState: () => noOpState,
    create: () => noOpState,
    show: () => false,
    hide: () => false,
    reassert: () => false,
    setBounds: () => false,
    destroy: () => { /* no-op */ },
  };
}

// ── Internal: RegisterClassExW helper ────────────────────────────────────────

function tryRegisterClass(
  ffi: Win32Ffi,
  className: string,
  wndProcPointer: HwndPtr,
  hInstance: HwndPtr,
): number {
  try {
    const cls = ffi.alloc('WNDCLASSEXW', {
      cbSize: 80, // sizeof WNDCLASSEXW on x64 — koffi handles this
      style: CS_HREDRAW | CS_VREDRAW,
      lpfnWndProc: wndProcPointer,
      cbClsExtra: 0,
      cbWndExtra: 0,
      hInstance,
      hIcon: null,
      hCursor: ffi.user32.LoadCursorW(null as unknown as HwndPtr, 32512 as unknown as HwndPtr), // IDC_ARROW
      hbrBackground: null,
      lpszMenuName: null,
      lpszClassName: className,
      hIconSm: null,
    });

    return ffi.user32.RegisterClassExW(cls) as number;
  } catch {
    return 0;
  }
}
