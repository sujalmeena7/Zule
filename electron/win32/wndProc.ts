// ============================================
// Zule AI — WNDPROC Registration & Safety
// ============================================
//
// Provides two modes for supplying a WNDPROC to WNDCLASSEXW.lpfnWndProc:
//
//   1. 'native' — resolves DefWindowProcW's address from user32.dll. No koffi
//      callback registered, no V8 reentry on the message pump. Used by Stage A.
//
//   2. 'js' — registers a koffi callback wrapped in makeSafeWndProc with:
//      - try/catch totality (never propagates exceptions through native frames)
//      - Circuit breaker (MAX_WNDPROC_FAULTS = 10)
//      - Reentrancy guard (inWndProc flag)
//      - Ring buffer fault recorder
//      - Message allowlist (mouse, wheel, keyboard, WM_MOUSELEAVE,
//        WM_DPICHANGED, WM_DISPLAYCHANGE, WM_DESTROY)
//
// Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7

import { getFfi, type HwndPtr, type WndProcJs } from './ffi';

// ── Public Types ─────────────────────────────────────────────────────────────

export type WndProcResult = number; // LRESULT

export interface WndProcHandlers {
  /** Return a number to claim the message, or null to fall through to DefWindowProcW. */
  onMessage(msg: number, wParam: number, lParam: number): WndProcResult | null;
}

export interface RegisteredWndProc {
  /** Pointer to pass as WNDCLASSEXW.lpfnWndProc. */
  readonly pointer: HwndPtr;
  /** True when this is the native DefWindowProcW address (no JS on the pump). */
  readonly isNativeFallback: boolean;
  dispose(): void;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** After this many faults, swap to pure DefWindowProcW pass-through. */
export const MAX_WNDPROC_FAULTS = 10;

/** Size of the ring buffer that records faults. */
const FAULT_RING_SIZE = 32;

// ── Message Allowlist ────────────────────────────────────────────────────────
// Only these messages invoke the JS handler. All others return null immediately
// (falling through to DefWindowProcW) with zero JS allocations.

const WM_DESTROY       = 0x0002;
const WM_DISPLAYCHANGE = 0x007E;
const WM_KEYDOWN       = 0x0100;
const WM_KEYUP         = 0x0101;
const WM_CHAR          = 0x0102;
const WM_SYSKEYDOWN    = 0x0104;
const WM_SYSKEYUP      = 0x0105;
const WM_MOUSEMOVE     = 0x0200;
const WM_LBUTTONDOWN   = 0x0201;
const WM_LBUTTONUP     = 0x0202;
const WM_RBUTTONDOWN   = 0x0204;
const WM_RBUTTONUP     = 0x0205;
const WM_MBUTTONDOWN   = 0x0207;
const WM_MBUTTONUP     = 0x0208;
const WM_MOUSEWHEEL    = 0x020A;
const WM_MOUSEHWHEEL   = 0x020E;
const WM_MOUSELEAVE    = 0x02A3;
const WM_DPICHANGED    = 0x02E0;

// Pre-built Set for O(1) lookup with no allocation on the hot path.
const ALLOWED_MESSAGES: ReadonlySet<number> = new Set([
  WM_MOUSEMOVE,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
  WM_RBUTTONDOWN,
  WM_RBUTTONUP,
  WM_MBUTTONDOWN,
  WM_MBUTTONUP,
  WM_MOUSEWHEEL,
  WM_MOUSEHWHEEL,
  WM_MOUSELEAVE,
  WM_KEYDOWN,
  WM_KEYUP,
  WM_CHAR,
  WM_SYSKEYDOWN,
  WM_SYSKEYUP,
  WM_DPICHANGED,
  WM_DISPLAYCHANGE,
  WM_DESTROY,
]);

// ── Fault Recording ──────────────────────────────────────────────────────────

export interface WndProcFault {
  msg: number;
  error: string;
  timestamp: number;
}

/** Fixed-size ring buffer for fault recording. No I/O, no allocation growth. */
const faultRing: WndProcFault[] = new Array(FAULT_RING_SIZE);
let faultRingIndex = 0;
let faultCount = 0;
let circuitBreakerTripped = false;

function recordWndProcFault(msg: number, err: unknown): void {
  faultCount++;
  const entry: WndProcFault = {
    msg,
    error: err instanceof Error ? err.message : String(err),
    timestamp: Date.now(),
  };
  faultRing[faultRingIndex] = entry;
  faultRingIndex = (faultRingIndex + 1) % FAULT_RING_SIZE;

  if (faultCount >= MAX_WNDPROC_FAULTS && !circuitBreakerTripped) {
    circuitBreakerTripped = true;
    // Surface failure out-of-band — never from inside the callback.
    setImmediate(() => {
      console.warn(
        `[Win32/WndProc] Circuit breaker tripped after ${faultCount} faults. ` +
        `Switched to pure DefWindowProcW pass-through.`,
      );
    });
  }
}

// ── Reentrancy Guard ─────────────────────────────────────────────────────────

let inWndProc = false;

// ── Internal: DefWindowProcW caller type ─────────────────────────────────────

type DefWindowProcFn = (hwnd: HwndPtr, msg: number, wParam: number, lParam: number) => number;

// ── makeSafeWndProc ──────────────────────────────────────────────────────────

/**
 * Creates a WNDPROC function that:
 * - Never propagates exceptions through native Win32 frames (Req 9.2)
 * - Returns null for messages not in the allowlist (Req 9.3)
 * - Enforces reentrancy guard (Req 9.4)
 * - Trips circuit breaker after MAX_WNDPROC_FAULTS (Req 9.6)
 */
export function makeSafeWndProc(
  handlers: WndProcHandlers,
  def: DefWindowProcFn,
): WndProcJs {
  return function wndProc(hwnd: HwndPtr, msg: number, wParam: bigint | number, lParam: bigint | number): bigint | number {
    // Coerce bigint to number for the handler interface.
    const msgNum = Number(msg);
    const wParamNum = Number(wParam);
    const lParamNum = Number(lParam);

    // ── Allowlist check (Req 9.3) ──────────────────────────────────────
    // Messages not in the allowlist return null immediately with zero JS
    // allocations, falling through to DefWindowProcW.
    if (!ALLOWED_MESSAGES.has(msgNum)) {
      try {
        return def(hwnd, msgNum, wParamNum, lParamNum);
      } catch {
        return 0;
      }
    }

    // ── Circuit breaker (Req 9.6) ──────────────────────────────────────
    if (circuitBreakerTripped) {
      try {
        return def(hwnd, msgNum, wParamNum, lParamNum);
      } catch {
        return 0;
      }
    }

    // ── Reentrancy guard (Req 9.4) ─────────────────────────────────────
    if (inWndProc) {
      // Defer reentrant calls — do not execute handler body more than once
      // simultaneously. Fall through to DefWindowProcW for this message.
      setImmediate(() => {
        // Re-dispatch deferred message outside the reentrancy window.
        // This is best-effort; the message is not lost but handling is delayed.
        try {
          handlers.onMessage(msgNum, wParamNum, lParamNum);
        } catch {
          // Swallow — deferred handlers must not propagate.
        }
      });
      try {
        return def(hwnd, msgNum, wParamNum, lParamNum);
      } catch {
        return 0;
      }
    }

    // ── Main handler path ──────────────────────────────────────────────
    inWndProc = true;
    try {
      const claimed = handlers.onMessage(msgNum, wParamNum, lParamNum);
      if (claimed !== null && Number.isSafeInteger(claimed)) {
        return claimed;
      }
    } catch (err: unknown) {
      // Never rethrow. Record and fall through to the OS default. (Req 9.2)
      recordWndProcFault(msgNum, err);
    } finally {
      inWndProc = false;
    }

    // Fall through to DefWindowProcW.
    try {
      return def(hwnd, msgNum, wParamNum, lParamNum);
    } catch {
      return 0; // Last resort: claim the message with 0.
    }
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Register a WNDPROC for use as WNDCLASSEXW.lpfnWndProc.
 *
 * - mode 'native': resolves DefWindowProcW address from user32.dll. No koffi
 *   JS callback registered, no V8 reentry on the message pump. (Req 9.1)
 * - mode 'js': registers a koffi callback wrapped in makeSafeWndProc. (Req 9.2-9.6)
 *
 * Returns null if FFI is unavailable or process.type is not 'browser'.
 */
export function registerWndProc(
  mode: 'native' | 'js',
  handlers?: WndProcHandlers,
): RegisteredWndProc | null {
  // ── Process guard (Req 9.7) ────────────────────────────────────────────
  if (process.type !== 'browser') {
    console.warn('[Win32/WndProc] Refused: process.type is not "browser"');
    return null;
  }

  const ffi = getFfi();
  if (!ffi) return null;

  // ── Native mode (Req 9.1) ──────────────────────────────────────────────
  if (mode === 'native') {
    // Use the DefWindowProcW binding directly — its address is the native
    // function pointer. We get this via procAddress which resolves the symbol.
    const nativeAddr = ffi.procAddress('user32.dll', 'DefWindowProcW');
    if (!nativeAddr) {
      // Fallback: use the bound function reference. The ffi.user32.DefWindowProcW
      // is already a koffi-bound function that resolves to the DLL export.
      // We cannot get a raw pointer this way, so return null.
      console.warn('[Win32/WndProc] Cannot resolve DefWindowProcW address');
      return null;
    }

    return {
      pointer: nativeAddr,
      isNativeFallback: true,
      dispose(): void {
        // No koffi callback to unregister in native mode.
        // Ordering contract (Req 9.5): caller must still call DestroyWindow
        // then UnregisterClassW before calling dispose().
      },
    };
  }

  // ── JS mode (Req 9.2, 9.3, 9.4, 9.6) ─────────────────────────────────
  if (!handlers) {
    console.warn('[Win32/WndProc] JS mode requires handlers');
    return null;
  }

  // Reset module-level state for this registration (supports re-creation).
  faultCount = 0;
  faultRingIndex = 0;
  circuitBreakerTripped = false;
  inWndProc = false;

  // Wrap DefWindowProcW into a plain function for the safe wrapper.
  const defWindowProc: DefWindowProcFn = (hwnd, msg, wParam, lParam) => {
    return ffi.user32.DefWindowProcW(hwnd, msg, wParam, lParam) as number;
  };

  const safeWndProc = makeSafeWndProc(handlers, defWindowProc);

  // Register the koffi callback.
  const callbackPtr = ffi.registerCallback(safeWndProc, 'WNDPROC');

  let disposed = false;

  return {
    pointer: callbackPtr,
    isNativeFallback: false,
    dispose(): void {
      // Ordering contract (Req 9.5):
      // Caller MUST have already called DestroyWindow + UnregisterClassW
      // before calling dispose(). This method only handles the koffi.unregister step.
      if (disposed) return;
      disposed = true;
      try {
        ffi.unregisterCallback(callbackPtr);
      } catch {
        // Best-effort cleanup — do not propagate.
      }
    },
  };
}

// ── Test Helpers (exported for property-based testing) ────────────────────────

/**
 * Exported for testing purposes only. Returns the current fault state.
 */
export function _getWndProcDiagnostics(): {
  faultCount: number;
  circuitBreakerTripped: boolean;
  faultRing: ReadonlyArray<WndProcFault | undefined>;
} {
  return {
    faultCount,
    circuitBreakerTripped,
    faultRing: [...faultRing],
  };
}

/**
 * Exported for testing purposes only. Resets all module-level state.
 */
export function _resetWndProcState(): void {
  faultCount = 0;
  faultRingIndex = 0;
  circuitBreakerTripped = false;
  inWndProc = false;
  faultRing.fill(undefined as unknown as WndProcFault);
}

/** Exported for testing: the message allowlist set. */
export const _ALLOWED_MESSAGES = ALLOWED_MESSAGES;
