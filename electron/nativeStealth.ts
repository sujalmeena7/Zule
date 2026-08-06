// ============================================
// Zule AI — Native Win32 Stealth Module
// ============================================
//
// Provides defense-in-depth screen-capture evasion by calling Windows APIs
// directly via koffi FFI, bypassing Electron's `setContentProtection`
// abstraction. Three independent layers:
//
//   Layer 1 — SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)
//             The strongest OS-level capture-exclusion flag. Verified via
//             GetWindowDisplayAffinity read-back so we know which flag
//             the OS actually applied.
//
//   Layer 2 — DwmSetWindowAttribute(DISALLOW_PEEK /
//             EXCLUDED_FROM_PEEK) — keeps the live top-level window visible
//             while excluding it from Aero Peek and taskbar previews. The
//             module also explicitly clears DWMWA_CLOAK because setting it
//             hides the window itself, not merely its preview.
//
//   Layer 3 — Extended window style manipulation — ensures
//             WS_EX_TOOLWINDOW is set and WS_EX_APPWINDOW is removed so the
//             window is hidden from Alt+Tab and the taskbar. Non-interactive
//             hosts additionally receive WS_EX_NOACTIVATE; interactive
//             BrowserWindows explicitly clear it so clicks can focus inputs.
//
// All three layers degrade gracefully: a failure in any one layer does
// not block the others. The module is a no-op on non-Windows platforms.
//
// Design references:
//   - Electron's setContentProtection calls SetWindowDisplayAffinity but
//     provides no read-back, no DWM cloaking, and no style hardening.
//   - Cluely uses DirectX/Metal GPU-layer rendering + these same Win32
//     APIs for process-level stealth.
//   - This module closes ~95% of the practical gap without requiring a
//     native C++ addon or a DirectComposition rendering pipeline.

import { getFfi, isWin32, normalizeHwnd } from './win32/ffi';
import type { HwndInput, HwndPtr, Win32Ffi } from './win32/ffi';

// ── Types ────────────────────────────────────────────────────────────────────

/** Result of applying a single stealth layer. */
export interface LayerResult {
  layer: string;
  applied: boolean;
  detail?: string;
}

/** Aggregate result of `applyNativeStealth`. */
export interface NativeStealthResult {
  /** Whether at least one layer was successfully applied. */
  ok: boolean;
  /** Per-layer breakdown. */
  layers: LayerResult[];
}

export interface NativeStealthOptions {
  /** Clear WS_EX_NOACTIVATE so an interactive BrowserWindow can receive focus on click. */
  allowActivation?: boolean;
}

// ── Win32 Constants ──────────────────────────────────────────────────────────

/** SetWindowDisplayAffinity flags. */
const WDA_NONE = 0x00000000;
const WDA_MONITOR = 0x00000001;
const WDA_EXCLUDEFROMCAPTURE = 0x00000011;

/** DwmSetWindowAttribute enum values. */
const DWMWA_DISALLOW_PEEK = 11;
const DWMWA_EXCLUDED_FROM_PEEK = 12;
const DWMWA_CLOAK = 13;

/** Extended window styles (WS_EX_*). */
const GWL_EXSTYLE = -20;
const WS_EX_APPWINDOW = 0x00040000;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_NOACTIVATE = 0x08000000;

// ── FFI access ───────────────────────────────────────────────────────────────
//
// Delegates to the shared Win32 FFI surface in `./win32/ffi.ts`.
// `getFfi()` handles lazy loading, failure latching, and platform guards.

/** Track whether we've successfully loaded FFI at least once in this process. */
let ffiReady = false;

function ensureFfi(): Win32Ffi | null {
  const ffi = getFfi();
  if (ffi) {
    ffiReady = true;
  }
  return ffi;
}

// ── Layer 1: Display Affinity ────────────────────────────────────────────────

function applyDisplayAffinity(hwnd: HwndInput, ffi: Win32Ffi): LayerResult {
  try {
    // Try the strongest flag first
    let success = ffi.user32.SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);

    if (!success) {
      // Fall back to WDA_MONITOR (black box instead of invisible, but still
      // prevents content from leaking to screen capture)
      success = ffi.user32.SetWindowDisplayAffinity(hwnd, WDA_MONITOR);
      if (success) {
        return {
          layer: 'DisplayAffinity',
          applied: true,
          detail: 'WDA_MONITOR (fallback — OS too old for WDA_EXCLUDEFROMCAPTURE)',
        };
      }
      return { layer: 'DisplayAffinity', applied: false, detail: 'SetWindowDisplayAffinity failed for both flags' };
    }

    // Verify: read back the actual affinity to confirm WDA_EXCLUDEFROMCAPTURE stuck
    const affinityOut = ffi.alloc('uint32_t', 0);
    const readOk = ffi.user32.GetWindowDisplayAffinity(hwnd, affinityOut);
    if (readOk) {
      const actualAffinity = ffi.decode(affinityOut, 'uint32_t') as number;
      if (actualAffinity === WDA_EXCLUDEFROMCAPTURE) {
        return { layer: 'DisplayAffinity', applied: true, detail: 'WDA_EXCLUDEFROMCAPTURE verified' };
      }
      if (actualAffinity === WDA_MONITOR) {
        return {
          layer: 'DisplayAffinity',
          applied: true,
          detail: `WDA_MONITOR actual (OS downgraded from WDA_EXCLUDEFROMCAPTURE, affinity=0x${actualAffinity.toString(16)})`,
        };
      }
      return {
        layer: 'DisplayAffinity',
        applied: true,
        detail: `Set succeeded but read-back=0x${actualAffinity.toString(16)}`,
      };
    }

    return { layer: 'DisplayAffinity', applied: true, detail: 'WDA_EXCLUDEFROMCAPTURE set (read-back unavailable)' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { layer: 'DisplayAffinity', applied: false, detail: msg };
  }
}

function removeDisplayAffinity(hwnd: HwndInput, ffi: Win32Ffi): boolean {
  try {
    return ffi.user32.SetWindowDisplayAffinity(hwnd, WDA_NONE);
  } catch {
    return false;
  }
}

// ── Layer 2: DWM Preview Hardening ───────────────────────────────────────────

function applyDwmCloaking(hwnd: HwndInput, ffi: Win32Ffi): LayerResult {
  const applied: string[] = [];
  const failed: string[] = [];

  // Helper: set a BOOL-valued DWM attribute. DWMWA_CLOAK is deliberately
  // cleared: TRUE makes the actual top-level window invisible, so it cannot be
  // used on an interactive dashboard or overlay host.
  const setDwmBool = (attr: number, name: string, enabled: boolean) => {
    try {
      const valueBuf = ffi.alloc('uint32_t', enabled ? 1 : 0);
      const hr = ffi.dwmapi.DwmSetWindowAttribute(hwnd, attr, valueBuf, 4);
      if (hr === 0) { // S_OK
        applied.push(name);
      } else {
        failed.push(`${name}(hr=0x${(hr >>> 0).toString(16)})`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push(`${name}(${msg})`);
    }
  };

  // Recover windows cloaked by an earlier application attempt, then retain
  // only the preview-related protections that do not hide the live window.
  setDwmBool(DWMWA_CLOAK, 'UNCLOAK', false);
  setDwmBool(DWMWA_DISALLOW_PEEK, 'DISALLOW_PEEK', true);
  setDwmBool(DWMWA_EXCLUDED_FROM_PEEK, 'EXCLUDED_FROM_PEEK', true);

  return {
    // Keep the existing layer identifier for result/log compatibility.
    layer: 'DwmCloaking',
    applied: applied.length > 0,
    detail: [
      applied.length > 0 ? `applied: ${applied.join(', ')}` : null,
      failed.length > 0 ? `failed: ${failed.join(', ')}` : null,
    ].filter(Boolean).join('; '),
  };
}

function removeDwmCloaking(hwnd: HwndInput, ffi: Win32Ffi): boolean {
  try {
    const valueBuf = ffi.alloc('uint32_t', 0); // FALSE = 0
    ffi.dwmapi.DwmSetWindowAttribute(hwnd, DWMWA_CLOAK, valueBuf, 4);
    ffi.dwmapi.DwmSetWindowAttribute(hwnd, DWMWA_DISALLOW_PEEK, valueBuf, 4);
    ffi.dwmapi.DwmSetWindowAttribute(hwnd, DWMWA_EXCLUDED_FROM_PEEK, valueBuf, 4);
    return true;
  } catch {
    return false;
  }
}

// ── Layer 3: Extended Window Style ───────────────────────────────────────────

function applyWindowStyleHardening(
  hwnd: HwndInput,
  ffi: Win32Ffi,
  allowActivation: boolean,
): LayerResult {
  try {
    const currentStyle = ffi.user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    if (currentStyle === 0) {
      return { layer: 'WindowStyle', applied: false, detail: 'GetWindowLongPtrW returned 0' };
    }

    // TOOLWINDOW keeps the window out of Alt+Tab/taskbar. NOACTIVATE is safe
    // for passive hosts, but must be absent from interactive BrowserWindows or
    // Windows will not activate them on click and Chromium inputs cannot focus.
    let newStyle = currentStyle;
    newStyle |= WS_EX_TOOLWINDOW;
    if (allowActivation) {
      newStyle &= ~WS_EX_NOACTIVATE;
    } else {
      newStyle |= WS_EX_NOACTIVATE;
    }
    newStyle &= ~WS_EX_APPWINDOW;

    if (newStyle === currentStyle) {
      return { layer: 'WindowStyle', applied: true, detail: 'Already hardened (no change needed)' };
    }

    ffi.user32.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, newStyle);

    const changes: string[] = [];
    if (!(currentStyle & WS_EX_TOOLWINDOW)) changes.push('+TOOLWINDOW');
    if (allowActivation && (currentStyle & WS_EX_NOACTIVATE)) changes.push('-NOACTIVATE');
    if (!allowActivation && !(currentStyle & WS_EX_NOACTIVATE)) changes.push('+NOACTIVATE');
    if (currentStyle & WS_EX_APPWINDOW) changes.push('-APPWINDOW');

    return {
      layer: 'WindowStyle',
      applied: true,
      detail: changes.join(', ') || 'styles applied',
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { layer: 'WindowStyle', applied: false, detail: msg };
  }
}

function removeWindowStyleHardening(hwnd: HwndInput, ffi: Win32Ffi): boolean {
  try {
    let style = ffi.user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    if (style === 0) return false;
    // Restore to a normal application window
    style &= ~WS_EX_TOOLWINDOW;
    style &= ~WS_EX_NOACTIVATE;
    style |= WS_EX_APPWINDOW;
    ffi.user32.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style);
    return true;
  } catch {
    return false;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Check whether the native stealth module is available on this platform.
 * Does NOT load the FFI — call this before `applyNativeStealth` to decide
 * whether to log a "native stealth unavailable" notice.
 */
export function isNativeStealthAvailable(): boolean {
  return isWin32();
}

/**
 * Apply all three stealth layers to the window identified by `hwndBuffer`.
 *
 * @param hwndBuffer - The raw HWND buffer from `BrowserWindow.getNativeWindowHandle()`
 *                     or a raw koffi HWND pointer from `CreateWindowExW`.
 * @returns Per-layer results. `ok` is true if at least one layer succeeded.
 */
export function applyNativeStealth(hwndBuffer: Buffer, options?: NativeStealthOptions): NativeStealthResult;
export function applyNativeStealth(hwndPtr: HwndPtr, options?: NativeStealthOptions): NativeStealthResult;
export function applyNativeStealth(
  hwnd: HwndInput,
  options: NativeStealthOptions = {},
): NativeStealthResult {
  const ffi = ensureFfi();
  if (!ffi) {
    return {
      ok: false,
      layers: [{ layer: 'FFI', applied: false, detail: 'Not available on this platform' }],
    };
  }

  const normalizedHwnd = normalizeHwnd(hwnd);
  const layers: LayerResult[] = [];

  // Layer 1: Display affinity (capture exclusion)
  layers.push(applyDisplayAffinity(normalizedHwnd, ffi));

  // Layer 2: DWM cloaking (peek/preview hiding)
  layers.push(applyDwmCloaking(normalizedHwnd, ffi));

  // Layer 3: Extended window style (Alt+Tab/taskbar hiding while preserving
  // activation for interactive BrowserWindows).
  layers.push(applyWindowStyleHardening(normalizedHwnd, ffi, options.allowActivation === true));

  const ok = layers.some((l) => l.applied);

  // Log summary
  for (const l of layers) {
    const status = l.applied ? '✓' : '✗';
    console.log(`[NativeStealth] ${status} ${l.layer}: ${l.detail ?? 'no detail'}`);
  }

  return { ok, layers };
}

/**
 * Remove all native stealth layers from the window. Called when the user
 * toggles stealth OFF via the eye/eye-off button.
 *
 * @param hwndBuffer - The raw HWND buffer from `BrowserWindow.getNativeWindowHandle()`
 *                     or a raw koffi HWND pointer from `CreateWindowExW`.
 * @returns true if at least one layer was successfully removed.
 */
export function removeNativeStealth(hwndBuffer: Buffer): boolean;
export function removeNativeStealth(hwndPtr: HwndPtr): boolean;
export function removeNativeStealth(hwnd: HwndInput): boolean {
  const ffi = getFfi();
  if (!ffi || !ffiReady) return false;

  const normalizedHwnd = normalizeHwnd(hwnd);
  const results = [
    removeDisplayAffinity(normalizedHwnd, ffi),
    removeDwmCloaking(normalizedHwnd, ffi),
    removeWindowStyleHardening(normalizedHwnd, ffi),
  ];

  const ok = results.some(Boolean);
  console.log(`[NativeStealth] Removed: ${ok ? 'success' : 'no layers could be removed'}`);
  return ok;
}
