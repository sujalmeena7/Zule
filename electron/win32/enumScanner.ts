// ============================================
// Zule AI — Chromium Window Class Scanner
// ============================================
//
// Enumerates all top-level windows belonging to the current process and
// collects those whose class name matches /Chrome_WidgetWin/. Used by:
//
//   - The self-check in adopt (task 5.1) to verify class concealment
//   - The spike report verification (task 14.1) for A1 criterion
//   - Dev-only IPC handler for manual testing
//
// An empty result means class-name concealment is working: no Chromium
// top-level windows are visible to EnumWindows for our process.
//
// Requirements: 1.3, 1.5, 2.2

import { getFfi, type HwndPtr } from './ffi';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChromiumWindowInfo {
  hwnd: HwndPtr;
  className: string;
  processId: number;
}

// ── Pattern ──────────────────────────────────────────────────────────────────

const CHROMIUM_CLASS_PATTERN = /Chrome_WidgetWin/;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Enumerate all top-level windows belonging to the current process and collect
 * those whose class name matches /Chrome_WidgetWin/.
 *
 * Returns an array of matches. An empty array means concealment is working.
 *
 * Returns an empty array on non-Windows or if FFI is unavailable — this is
 * intentional: the scanner is a verification tool, not a load-bearing feature.
 */
export function findChromiumTopLevelClasses(): ChromiumWindowInfo[] {
  const ffi = getFfi();
  if (!ffi) return [];

  const ourPid = process.pid;
  const results: ChromiumWindowInfo[] = [];

  // Register the EnumWindows callback
  const enumProc = ffi.registerEnumCallback((hwnd: HwndPtr, _lParam: bigint | number): boolean => {
    try {
      // Get the process ID for this window
      const pidOut = ffi.alloc('uint32_t') as unknown;
      ffi.user32.GetWindowThreadProcessId(hwnd, pidOut);
      const windowPid = ffi.decode(pidOut, 'uint32_t') as number;

      // Only inspect windows belonging to our process
      if (windowPid !== ourPid) return true; // continue enumeration

      // Get the class name
      const className = getClassName(ffi, hwnd);
      if (!className) return true; // continue enumeration

      // Check if it matches the Chromium pattern
      if (CHROMIUM_CLASS_PATTERN.test(className)) {
        results.push({
          hwnd,
          className,
          processId: windowPid,
        });
      }
    } catch {
      // Never abort enumeration on error — best-effort collection
    }

    return true; // continue enumeration
  });

  try {
    // Call EnumWindows with our callback
    ffi.user32.EnumWindows(enumProc, 0);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[enumScanner] EnumWindows failed: ${msg}`);
  } finally {
    // Always unregister the callback to prevent leaks
    ffi.unregisterCallback(enumProc);
  }

  return results;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Get the window class name for a given HWND. Returns null if retrieval fails.
 */
function getClassName(ffi: ReturnType<typeof getFfi> & object, hwnd: HwndPtr): string | null {
  try {
    // Allocate a buffer for the class name (256 wide chars)
    const buf = Buffer.alloc(256 * 2); // UTF-16LE buffer
    const len = ffi.user32.GetClassNameW(hwnd, buf, 256);
    if (len <= 0) return null;
    return buf.toString('utf16le', 0, len * 2);
  } catch {
    return null;
  }
}
