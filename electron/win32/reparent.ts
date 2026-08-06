// ============================================
// Zule AI — Stage A Reparenting Module
// ============================================
//
// Handles the core Stage A logic: making the Chromium overlay HWND a child of
// the Stealth Host. Provides `adopt`, `release`, and `rollback` operations
// with idempotency guarantees and automatic rollback on self-check failure.
//
// Requirements: 1.2, 1.3, 2.2, 2.3, 3.3, 3.4

import { normalizeHwnd } from './ffi';
import type { HwndInput, HwndPtr, Win32Ffi } from './ffi';
import { applyNativeStealth } from '../nativeStealth';

// ── Win32 Constants ──────────────────────────────────────────────────────────

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;

const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;

const WS_EX_TOPMOST = 0x00000008;

const SWP_FRAMECHANGED = 0x0020;
const SWP_NOACTIVATE = 0x0010;
const SWP_NOZORDER = 0x0004;

// ── Public Types ─────────────────────────────────────────────────────────────

/** Snapshot of a child window's state before adoption. */
export interface AdoptionState {
  adopted: boolean;
  hostHwnd: HwndPtr | null;
  childHwnd: HwndPtr | null;
  savedStyle: number;
  savedExStyle: number;
  savedRect: { x: number; y: number; width: number; height: number };
}

/** Result of an adopt or release operation. */
export interface ReparentResult {
  success: boolean;
  state: AdoptionState;
  failure?: { detail: string; rolledBack: boolean };
}

/** Interface returned by createReparenter. */
export interface Reparenter {
  adopt(hostHwnd: HwndInput, childHwnd: HwndInput): ReparentResult;
  release(): ReparentResult;
  getState(): AdoptionState;
}

// ── Default (un-adopted) state ───────────────────────────────────────────────

function makeDefaultState(): AdoptionState {
  return {
    adopted: false,
    hostHwnd: null,
    childHwnd: null,
    savedStyle: 0,
    savedExStyle: 0,
    savedRect: { x: 0, y: 0, width: 0, height: 0 },
  };
}

// ── createReparenter ─────────────────────────────────────────────────────────

/**
 * Create a reparenter instance that manages adoption of a child HWND into a
 * host HWND. All operations are idempotent and self-checking.
 *
 * @param ffi - The Win32 FFI surface (must be non-null)
 */
export function createReparenter(ffi: Win32Ffi): Reparenter {
  let state: AdoptionState = makeDefaultState();

  // ── adopt ──────────────────────────────────────────────────────────────

  function adopt(hostHwndInput: HwndInput, childHwndInput: HwndInput): ReparentResult {
    // Idempotent: if already adopted, return current state
    if (state.adopted) {
      return { success: true, state };
    }

    // Electron supplies pointer bytes in a Buffer; koffi expects the pointer
    // value itself. Raw host pointers are left unchanged by normalizeHwnd.
    const hostHwnd = normalizeHwnd(hostHwndInput);
    const childHwnd = normalizeHwnd(childHwndInput);

    // ── Step 1: Snapshot current child state ─────────────────────────────
    const savedStyle = ffi.user32.GetWindowLongPtrW(childHwnd, GWL_STYLE);
    const savedExStyle = ffi.user32.GetWindowLongPtrW(childHwnd, GWL_EXSTYLE);

    const rectBuf = ffi.alloc('RECT', { left: 0, top: 0, right: 0, bottom: 0 });
    ffi.user32.GetWindowRect(childHwnd, rectBuf);
    const rect = ffi.decode(rectBuf, 'RECT') as { left: number; top: number; right: number; bottom: number };

    const savedRect = {
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    };

    const saved: AdoptionState = {
      adopted: false,
      hostHwnd,
      childHwnd,
      savedStyle,
      savedExStyle,
      savedRect,
    };

    // ── Step 2: Style fixup on child ─────────────────────────────────────
    // Clear WS_POPUP, set WS_CHILD
    const newStyle = (savedStyle & ~WS_POPUP) | WS_CHILD;
    ffi.user32.SetWindowLongPtrW(childHwnd, GWL_STYLE, newStyle);

    // Remove WS_EX_TOPMOST from child (it moves to host)
    const newExStyle = savedExStyle & ~WS_EX_TOPMOST;
    ffi.user32.SetWindowLongPtrW(childHwnd, GWL_EXSTYLE, newExStyle);

    // ── Step 3: SetParent ────────────────────────────────────────────────
    ffi.user32.SetParent(childHwnd, hostHwnd);

    // ── Step 4: Refit child to host client area ──────────────────────────
    const clientRectBuf = ffi.alloc('RECT', { left: 0, top: 0, right: 0, bottom: 0 });
    ffi.user32.GetClientRect(hostHwnd, clientRectBuf);
    const clientRect = ffi.decode(clientRectBuf, 'RECT') as { left: number; top: number; right: number; bottom: number };
    const clientWidth = clientRect.right - clientRect.left;
    const clientHeight = clientRect.bottom - clientRect.top;

    ffi.user32.SetWindowPos(
      childHwnd,
      null as unknown as HwndPtr, // no z-order change
      0,
      0,
      clientWidth,
      clientHeight,
      SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOZORDER,
    );

    // ── Step 5: Self-check ───────────────────────────────────────────────
    const checkResult = selfCheck(ffi, hostHwnd, childHwnd);

    if (!checkResult.passed) {
      // Self-check failed — rollback
      rollback(ffi, childHwnd, saved);
      state = makeDefaultState();
      return {
        success: false,
        state,
        failure: { detail: checkResult.detail, rolledBack: true },
      };
    }

    // ── Success ──────────────────────────────────────────────────────────
    state = {
      adopted: true,
      hostHwnd,
      childHwnd,
      savedStyle,
      savedExStyle,
      savedRect,
    };

    return { success: true, state };
  }

  // ── release ────────────────────────────────────────────────────────────

  function release(): ReparentResult {
    // Idempotent: if not adopted, no-op
    if (!state.adopted || !state.childHwnd) {
      return { success: true, state };
    }

    const childHwnd = state.childHwnd;

    // ── Step 1: SetParent to NULL (restore to top-level) ─────────────────
    ffi.user32.SetParent(childHwnd, null as unknown as HwndPtr);

    // ── Step 2: Restore saved style ──────────────────────────────────────
    ffi.user32.SetWindowLongPtrW(childHwnd, GWL_STYLE, state.savedStyle);

    // ── Step 3: Restore saved exStyle ────────────────────────────────────
    ffi.user32.SetWindowLongPtrW(childHwnd, GWL_EXSTYLE, state.savedExStyle);

    // ── Step 4: Restore saved rect ───────────────────────────────────────
    ffi.user32.SetWindowPos(
      childHwnd,
      null as unknown as HwndPtr,
      state.savedRect.x,
      state.savedRect.y,
      state.savedRect.width,
      state.savedRect.height,
      SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOZORDER,
    );

    // ── Step 5: Re-apply stealth layers to child ─────────────────────────
    // The released Chromium window is interactive again; do not leave the
    // host's WS_EX_NOACTIVATE policy on the Layer 0 fallback.
    applyNativeStealth(childHwnd as HwndPtr, { allowActivation: true });

    // ── Step 6: Verify release ───────────────────────────────────────────
    const parentAfter = ffi.user32.GetParent(childHwnd);
    if (parentAfter !== null && parentAfter !== 0 && parentAfter !== undefined) {
      // Release failed — parent is not NULL. Record failure but state is
      // already reset since we attempted the release.
      const result: ReparentResult = {
        success: false,
        state: makeDefaultState(),
        failure: { detail: 'GetParent(child) is not NULL after release', rolledBack: true },
      };
      state = makeDefaultState();
      return result;
    }

    // ── Success ──────────────────────────────────────────────────────────
    state = makeDefaultState();
    return { success: true, state };
  }

  // ── getState ───────────────────────────────────────────────────────────

  function getState(): AdoptionState {
    return state;
  }

  return { adopt, release, getState };
}

// ── Self-Check ───────────────────────────────────────────────────────────────

interface SelfCheckResult {
  passed: boolean;
  detail: string;
}

/**
 * Verify the post-adoption invariants:
 * 1. GetParent(child) === hostHwnd
 * 2. Child style has WS_CHILD set
 *
 * Note: The full enumTopLevelClasses check (verifying no Chrome_WidgetWin for
 * our PID) is deferred to task 8.1 which implements the scanner module.
 */
function selfCheck(ffi: Win32Ffi, hostHwnd: HwndPtr, childHwnd: HwndPtr): SelfCheckResult {
  // Check 1: GetParent(child) should return the host
  const actualParent = ffi.user32.GetParent(childHwnd);
  if (actualParent !== hostHwnd) {
    return {
      passed: false,
      detail: `GetParent(child) does not match hostHwnd (parent mismatch after SetParent)`,
    };
  }

  // Check 2: Child style should have WS_CHILD set
  const currentStyle = ffi.user32.GetWindowLongPtrW(childHwnd, GWL_STYLE);
  if ((currentStyle & WS_CHILD) === 0) {
    return {
      passed: false,
      detail: `Child window style does not have WS_CHILD set (style=0x${currentStyle.toString(16)})`,
    };
  }

  return { passed: true, detail: 'All self-checks passed' };
}

// ── Rollback ─────────────────────────────────────────────────────────────────

/**
 * Restore a child window to its pre-adoption state. Called when self-check
 * fails during adopt, or when an emergency release is needed.
 *
 * Same sequence as release() but operates from a saved snapshot rather than
 * the internal state.
 */
function rollback(ffi: Win32Ffi, childHwnd: HwndPtr, saved: AdoptionState): void {
  // Restore parent to top-level
  try {
    ffi.user32.SetParent(childHwnd, null as unknown as HwndPtr);
  } catch {
    // Best-effort — continue cleanup
  }

  // Restore original style
  try {
    ffi.user32.SetWindowLongPtrW(childHwnd, GWL_STYLE, saved.savedStyle);
  } catch {
    // Best-effort
  }

  // Restore original exStyle
  try {
    ffi.user32.SetWindowLongPtrW(childHwnd, GWL_EXSTYLE, saved.savedExStyle);
  } catch {
    // Best-effort
  }

  // Restore original position/size
  try {
    ffi.user32.SetWindowPos(
      childHwnd,
      null as unknown as HwndPtr,
      saved.savedRect.x,
      saved.savedRect.y,
      saved.savedRect.width,
      saved.savedRect.height,
      SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOZORDER,
    );
  } catch {
    // Best-effort
  }

  // Re-apply stealth layers to the child since it's back to an interactive
  // top-level Layer 0 BrowserWindow.
  try {
    applyNativeStealth(childHwnd as HwndPtr, { allowActivation: true });
  } catch {
    // Best-effort
  }
}
