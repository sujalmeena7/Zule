// ============================================
// Zule AI — Low-Level Keyboard Hook (WH_KEYBOARD_LL)
// ============================================
//
// Installs a Windows low-level keyboard hook that intercepts keystrokes
// system-wide and forwards them to the overlay's webContents via Electron's
// sendInputEvent API — without ever activating the overlay window.
//
// This allows the user to type into the overlay's input field while the
// foreground application (e.g. a fullscreen game or proctored exam) retains
// OS-level focus. The background app never receives WM_KILLFOCUS.
//
// Lifecycle:
//   install()   — called when the renderer signals an input is focused
//   uninstall() — called when the renderer signals the input is blurred
//
// The hook callback runs on the thread that installed it (Electron's main
// thread via the Win32 message pump). SetWindowsHookExW with WH_KEYBOARD_LL
// does NOT require a DLL injection — it's processed in the context of the
// calling thread's message loop.
//
// Security: The hook only captures keystrokes when explicitly installed by
// the overlay's focus IPC. It is uninstalled on blur and on app quit.

import { createRequire } from 'node:module';
import type { BrowserWindow as BrowserWindowType } from 'electron';

const require = createRequire(import.meta.url);

// ── Win32 Constants ──────────────────────────────────────────────────────────

const WH_KEYBOARD_LL = 13;
const HC_ACTION = 0;

// KBDLLHOOKSTRUCT flags
const LLKHF_UP = 0x0080;        // Transition state (1 = key up)

// Virtual key codes we never intercept (let them pass to the foreground app)
const VK_LWIN = 0x5B;
const VK_RWIN = 0x5C;
const VK_APPS = 0x5D;   // Context menu key
const VK_SNAPSHOT = 0x2C; // PrintScreen

// ── Types ────────────────────────────────────────────────────────────────────

interface KbdLLHookStruct {
  vkCode: number;
  scanCode: number;
  flags: number;
  time: number;
  dwExtraInfo: number;
}

export interface KeyboardHook {
  install(target: BrowserWindowType): boolean;
  uninstall(): void;
  isInstalled(): boolean;
}

// ── Module State ─────────────────────────────────────────────────────────────

let koffi: any = null;
let user32Lib: any = null;
let hookHandle: any = null;
let callbackRef: any = null;
let targetWindow: BrowserWindowType | null = null;
let installed = false;

// Modifier key tracking (LL hook doesn't provide accumulated modifier state)
let ctrlDown = false;
let shiftDown = false;
let altDown = false;

// ── Lazy FFI Loading ─────────────────────────────────────────────────────────

function ensureKoffi(): boolean {
  if (koffi) return true;
  if (process.platform !== 'win32') return false;

  try {
    koffi = createRequire(import.meta.url)('koffi');
    user32Lib = koffi.load('user32.dll');
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[KeyboardHook] Failed to load koffi/user32: ${msg}`);
    return false;
  }
}

// ── VK → Electron Key Code ───────────────────────────────────────────────────

const VK_TO_KEY: ReadonlyMap<number, string> = new Map([
  [0x08, 'Backspace'],
  [0x09, 'Tab'],
  [0x0D, 'Return'],
  [0x1B, 'Escape'],
  [0x20, ' '],
  [0x21, 'PageUp'],
  [0x22, 'PageDown'],
  [0x23, 'End'],
  [0x24, 'Home'],
  [0x25, 'Left'],
  [0x26, 'Up'],
  [0x27, 'Right'],
  [0x28, 'Down'],
  [0x2D, 'Insert'],
  [0x2E, 'Delete'],
  [0xBE, '.'],
  [0xBC, ','],
  [0xBD, '-'],
  [0xBB, '='],
  [0xBA, ';'],
  [0xDE, "'"],
  [0xC0, '`'],
  [0xDB, '['],
  [0xDD, ']'],
  [0xDC, '\\'],
  [0xBF, '/'],
]);

function vkToKeyCode(vk: number): string {
  const mapped = VK_TO_KEY.get(vk);
  if (mapped) return mapped;

  // A-Z
  if (vk >= 0x41 && vk <= 0x5A) return String.fromCharCode(vk).toLowerCase();
  // 0-9
  if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);
  // Numpad 0-9
  if (vk >= 0x60 && vk <= 0x69) return `num${vk - 0x60}`;
  // F1-F24
  if (vk >= 0x70 && vk <= 0x87) return `F${vk - 0x70 + 1}`;

  return '';
}

// Keys that should NOT be intercepted (system keys that must reach the OS)
function isSystemKey(vk: number): boolean {
  return vk === VK_LWIN || vk === VK_RWIN || vk === VK_APPS || vk === VK_SNAPSHOT;
}

// ── Modifier Tracking ────────────────────────────────────────────────────────

function updateModifiers(vk: number, isUp: boolean): void {
  if (vk === 0x10 || vk === 0xA0 || vk === 0xA1) shiftDown = !isUp; // VK_SHIFT / VK_LSHIFT / VK_RSHIFT
  if (vk === 0x11 || vk === 0xA2 || vk === 0xA3) ctrlDown = !isUp;  // VK_CONTROL / VK_LCONTROL / VK_RCONTROL
  if (vk === 0x12 || vk === 0xA4 || vk === 0xA5) altDown = !isUp;   // VK_MENU / VK_LMENU / VK_RMENU
}

function getModifiers(): string[] {
  const mods: string[] = [];
  if (ctrlDown) mods.push('control');
  if (shiftDown) mods.push('shift');
  if (altDown) mods.push('alt');
  return mods;
}

// ── Hook Callback ────────────────────────────────────────────────────────────

// CallNextHookEx cached binding — initialized in install()
let callNextHookExFn: ((hook: any, nCode: number, wParam: bigint, lParam: any) => bigint) | null = null;

function hookCallback(nCode: number, wParam: bigint | number, lParam: any): bigint {
  const wP = typeof wParam === 'bigint' ? wParam : BigInt(wParam);

  // CallNextHookEx must always be called for messages we don't consume
  const callNext = (): bigint => {
    if (callNextHookExFn) {
      return BigInt(callNextHookExFn(hookHandle, nCode, wP, lParam));
    }
    return BigInt(0);
  };

  if (nCode !== HC_ACTION || !targetWindow || targetWindow.isDestroyed()) {
    return callNext();
  }

  // Decode KBDLLHOOKSTRUCT from the lParam pointer
  let data: KbdLLHookStruct;
  try {
    data = koffi.decode(lParam, 'KBDLLHOOKSTRUCT') as KbdLLHookStruct;
  } catch {
    return callNext();
  }

  const vk = data.vkCode;
  const isUp = (data.flags & LLKHF_UP) !== 0;

  // Never intercept system keys
  if (isSystemKey(vk)) {
    return callNext();
  }

  // Don't intercept Alt+Tab, Alt+F4, Ctrl+Alt+Del sequences
  if (altDown && (vk === 0x09 || vk === 0x73)) { // Alt+Tab or Alt+F4
    return callNext();
  }
  if (ctrlDown && altDown && vk === 0x2E) { // Ctrl+Alt+Delete
    return callNext();
  }

  // Update modifier tracking
  updateModifiers(vk, isUp);

  // Forward to Electron's webContents
  const keyCode = vkToKeyCode(vk);
  if (!keyCode) {
    return callNext();
  }

  try {
    const modifiers = getModifiers();
    const eventType = isUp ? 'keyUp' : 'keyDown';

    targetWindow.webContents.sendInputEvent({
      type: eventType,
      keyCode,
      modifiers,
    } as Electron.KeyboardInputEvent);

    // For key-down of printable characters, also send a 'char' event
    // so Chromium's input handling processes it as text input.
    if (!isUp && !ctrlDown && !altDown) {
      let charValue = '';

      // Single printable characters
      if (keyCode.length === 1) {
        charValue = shiftDown ? keyCode.toUpperCase() : keyCode;
      } else if (keyCode === ' ') {
        charValue = ' ';
      }

      if (charValue) {
        targetWindow.webContents.sendInputEvent({
          type: 'char',
          keyCode: charValue,
          modifiers,
        } as Electron.KeyboardInputEvent);
      }
    }
  } catch (err: unknown) {
    // Don't crash the hook on send errors
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[KeyboardHook] sendInputEvent failed: ${msg}`);
    return callNext();
  }

  // Return 1 to consume the keystroke (prevent it from reaching the foreground app)
  return BigInt(1);
}

// ── Public API ───────────────────────────────────────────────────────────────

export function createKeyboardHook(): KeyboardHook {
  return {
    install(target: BrowserWindowType): boolean {
      if (installed) {
        // Update target if already installed
        targetWindow = target;
        return true;
      }

      if (!ensureKoffi()) return false;

      targetWindow = target;

      try {
        // Define the KBDLLHOOKSTRUCT if not already defined
        try {
          koffi.struct('KBDLLHOOKSTRUCT', {
            vkCode: 'uint32',
            scanCode: 'uint32',
            flags: 'uint32',
            time: 'uint32',
            dwExtraInfo: 'uint64',
          });
        } catch {
          // Already defined — ignore
        }

        // Define the LowLevelKeyboardProc callback prototype
        let LLKP: any;
        try {
          LLKP = koffi.proto('int64 LowLevelKeyboardProc(int nCode, int64 wParam, KBDLLHOOKSTRUCT *lParam)');
        } catch {
          // Already defined — reuse
          LLKP = 'LowLevelKeyboardProc';
        }

        // Cache CallNextHookEx before registering the callback
        callNextHookExFn = user32Lib.func(
          'int64 CallNextHookEx(void *hook, int nCode, int64 wParam, void *lParam)',
        );

        // Register our JS callback as a native function pointer
        callbackRef = koffi.register(hookCallback, koffi.pointer(LLKP));

        // SetWindowsHookExW(WH_KEYBOARD_LL, proc, hMod, threadId)
        // For LL hooks: hMod = NULL, threadId = 0 (all threads)
        const setHookFn = user32Lib.func(
          'void *SetWindowsHookExW(int idHook, void *lpfn, void *hMod, uint32_t dwThreadId)',
        );

        hookHandle = setHookFn(WH_KEYBOARD_LL, callbackRef, null, 0);

        if (!hookHandle) {
          console.warn('[KeyboardHook] SetWindowsHookExW returned NULL');
          if (callbackRef) {
            koffi.unregister(callbackRef);
            callbackRef = null;
          }
          callNextHookExFn = null;
          return false;
        }

        installed = true;
        ctrlDown = false;
        shiftDown = false;
        altDown = false;
        console.log('[KeyboardHook] Low-level keyboard hook installed');
        return true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[KeyboardHook] Install failed: ${msg}`);
        return false;
      }
    },

    uninstall(): void {
      if (!installed) return;

      try {
        if (hookHandle && user32Lib) {
          const unhookFn = user32Lib.func(
            'bool UnhookWindowsHookEx(void *hhk)',
          );
          unhookFn(hookHandle);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[KeyboardHook] UnhookWindowsHookEx failed: ${msg}`);
      }

      hookHandle = null;
      targetWindow = null;
      callNextHookExFn = null;

      if (callbackRef && koffi) {
        try {
          koffi.unregister(callbackRef);
        } catch {
          // Best effort
        }
        callbackRef = null;
      }

      installed = false;
      ctrlDown = false;
      shiftDown = false;
      altDown = false;
      console.log('[KeyboardHook] Low-level keyboard hook uninstalled');
    },

    isInstalled(): boolean {
      return installed;
    },
  };
}
