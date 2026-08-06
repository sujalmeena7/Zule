// ============================================
// Zule AI — Stage B Input Forwarder
// ============================================
//
// Converts Win32 messages (mouse, keyboard, wheel) received by the Stealth_Host
// WNDPROC into Electron `sendInputEvent` calls targeting the offscreen webContents.
//
// Pure coordinate conversion functions are exported for property-based testing.
//
// Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7

import type { WndProcHandlers, WndProcResult } from './wndProc';

// ── Public Types ─────────────────────────────────────────────────────────────

export interface ForwarderDeps {
  /** Offscreen webContents to receive synthesized events. */
  send(event: Electron.InputEvent): void;
  /** Current host client size in physical pixels. */
  clientSize(): { width: number; height: number };
  /** Device scale factor of the display the host currently occupies. */
  scaleFactor(): number;
  /** Begin / update / end a hand-rolled window drag. */
  drag: DragController;
  /** Hit-test cache: returns true if the CSS point is inside a drag zone. */
  isDragZone?(cssPt: { x: number; y: number }): boolean;
}

export interface DragController {
  begin(screenX: number, screenY: number): void;
  update(screenX: number, screenY: number): void;
  end(): void;
  readonly dragging: boolean;
}

// ── Win32 Message Constants ──────────────────────────────────────────────────

const WM_MOUSEMOVE    = 0x0200;
const WM_LBUTTONDOWN  = 0x0201;
const WM_LBUTTONUP    = 0x0202;
const WM_RBUTTONDOWN  = 0x0204;
const WM_RBUTTONUP    = 0x0205;
const WM_MBUTTONDOWN  = 0x0207;
const WM_MBUTTONUP    = 0x0208;
const WM_MOUSEWHEEL   = 0x020A;
const WM_MOUSEHWHEEL  = 0x020E;
const WM_MOUSELEAVE   = 0x02A3;
const WM_KEYDOWN      = 0x0100;
const WM_KEYUP        = 0x0101;
const WM_CHAR         = 0x0102;
const WM_SYSKEYDOWN   = 0x0104;
const WM_SYSKEYUP     = 0x0105;

// ── Pure Coordinate Conversion (exported for testing) ────────────────────────

/**
 * Convert client (physical) pixel coordinates to CSS (device-independent) coordinates.
 * Requirement 8.1: monotonic and round-trip safe within 1 physical pixel.
 */
export function clientToCss(
  pt: { x: number; y: number },
  scaleFactor: number,
): { x: number; y: number } {
  return {
    x: Math.round(pt.x / scaleFactor),
    y: Math.round(pt.y / scaleFactor),
  };
}

/**
 * Convert CSS (device-independent) coordinates to client (physical) pixel coordinates.
 * Requirement 8.1: monotonic and round-trip safe within 1 physical pixel.
 */
export function cssToClient(
  pt: { x: number; y: number },
  scaleFactor: number,
): { x: number; y: number } {
  return {
    x: Math.round(pt.x * scaleFactor),
    y: Math.round(pt.y * scaleFactor),
  };
}

// ── lParam / wParam Decoders (exported for testing) ──────────────────────────

/**
 * Decode mouse lParam to signed x,y coordinates.
 * Win32 packs two signed 16-bit values: x in LOWORD, y in HIWORD.
 * Requirement 8.2: sign extension — negative coordinates decode negative, never ≥ 32768.
 */
export function decodeMouseLParam(lParam: number): { x: number; y: number } {
  // Extract low and high words with sign extension via left-shift then arithmetic right-shift
  const x = (lParam & 0xffff) << 16 >> 16;
  const y = ((lParam >> 16) & 0xffff) << 16 >> 16;
  return { x, y };
}

/**
 * Decode wheel delta from wParam HIWORD.
 * The delta is a signed 16-bit value (multiples of WHEEL_DELTA = 120).
 * Requirement 8.6: correct sign and magnitude.
 */
export function decodeWheelDelta(wParam: number): number {
  // HIWORD of wParam, sign-extended
  return ((wParam >> 16) & 0xffff) << 16 >> 16;
}

// ── createInputForwarder ─────────────────────────────────────────────────────

/**
 * Creates a WndProcHandlers implementation that converts Win32 messages into
 * Electron sendInputEvent calls.
 *
 * Requirements: 8.1-8.7
 */
export function createInputForwarder(deps: ForwarderDeps): WndProcHandlers {
  // Track last known mouse position for WM_MOUSELEAVE (which has no coordinates).
  let lastCssX = 0;
  let lastCssY = 0;

  return {
    onMessage(msg: number, wParam: number, lParam: number): WndProcResult | null {
      const scale = deps.scaleFactor();

      switch (msg) {
        // ── Mouse Move ─────────────────────────────────────────────────
        case WM_MOUSEMOVE: {
          const clientPt = decodeMouseLParam(lParam);

          // If dragging, update drag position (screen coordinates).
          if (deps.drag.dragging) {
            // During drag, we receive client coordinates. Convert to a screen
            // delta approximation. The DragController handles SetWindowPos.
            // For drag updates we pass the client point as-is; the DragController
            // tracks deltas from the initial screen position.
            deps.drag.update(clientPt.x, clientPt.y);
            return 0;
          }

          const cssPt = clientToCss(clientPt, scale);
          lastCssX = cssPt.x;
          lastCssY = cssPt.y;

          deps.send({
            type: 'mouseMove',
            x: cssPt.x,
            y: cssPt.y,
          } as Electron.MouseInputEvent);
          return 0;
        }

        // ── Left Button Down ───────────────────────────────────────────
        case WM_LBUTTONDOWN: {
          const clientPt = decodeMouseLParam(lParam);
          const cssPt = clientToCss(clientPt, scale);

          // Requirement 8.4, 8.7: check drag zone via hit-test cache.
          // Empty cache (isDragZone undefined or always returns false) means
          // no drag zones — overlay is click-only, never un-clickable.
          if (deps.isDragZone && deps.isDragZone(cssPt)) {
            // Initiate hand-rolled drag. SetCapture is managed by the DragController.
            deps.drag.begin(clientPt.x, clientPt.y);
            return 0; // Claimed — do not forward to renderer.
          }

          // Forward as click to the renderer.
          lastCssX = cssPt.x;
          lastCssY = cssPt.y;
          deps.send({
            type: 'mouseDown',
            button: 'left',
            x: cssPt.x,
            y: cssPt.y,
            clickCount: 1,
          } as Electron.MouseInputEvent);
          return 0;
        }

        // ── Left Button Up ─────────────────────────────────────────────
        case WM_LBUTTONUP: {
          const clientPt = decodeMouseLParam(lParam);

          // Requirement 8.5: end drag if active.
          if (deps.drag.dragging) {
            deps.drag.end();
            return 0; // Claimed.
          }

          const cssPt = clientToCss(clientPt, scale);
          lastCssX = cssPt.x;
          lastCssY = cssPt.y;
          deps.send({
            type: 'mouseUp',
            button: 'left',
            x: cssPt.x,
            y: cssPt.y,
            clickCount: 1,
          } as Electron.MouseInputEvent);
          return 0;
        }

        // ── Right Button Down ──────────────────────────────────────────
        case WM_RBUTTONDOWN: {
          const clientPt = decodeMouseLParam(lParam);
          const cssPt = clientToCss(clientPt, scale);
          lastCssX = cssPt.x;
          lastCssY = cssPt.y;
          deps.send({
            type: 'mouseDown',
            button: 'right',
            x: cssPt.x,
            y: cssPt.y,
            clickCount: 1,
          } as Electron.MouseInputEvent);
          return 0;
        }

        // ── Right Button Up ────────────────────────────────────────────
        case WM_RBUTTONUP: {
          const clientPt = decodeMouseLParam(lParam);
          const cssPt = clientToCss(clientPt, scale);
          lastCssX = cssPt.x;
          lastCssY = cssPt.y;
          deps.send({
            type: 'mouseUp',
            button: 'right',
            x: cssPt.x,
            y: cssPt.y,
            clickCount: 1,
          } as Electron.MouseInputEvent);
          return 0;
        }

        // ── Middle Button Down ─────────────────────────────────────────
        case WM_MBUTTONDOWN: {
          const clientPt = decodeMouseLParam(lParam);
          const cssPt = clientToCss(clientPt, scale);
          lastCssX = cssPt.x;
          lastCssY = cssPt.y;
          deps.send({
            type: 'mouseDown',
            button: 'middle',
            x: cssPt.x,
            y: cssPt.y,
            clickCount: 1,
          } as Electron.MouseInputEvent);
          return 0;
        }

        // ── Middle Button Up ───────────────────────────────────────────
        case WM_MBUTTONUP: {
          const clientPt = decodeMouseLParam(lParam);
          const cssPt = clientToCss(clientPt, scale);
          lastCssX = cssPt.x;
          lastCssY = cssPt.y;
          deps.send({
            type: 'mouseUp',
            button: 'middle',
            x: cssPt.x,
            y: cssPt.y,
            clickCount: 1,
          } as Electron.MouseInputEvent);
          return 0;
        }

        // ── Mouse Wheel (vertical) ────────────────────────────────────
        case WM_MOUSEWHEEL: {
          // Requirement 8.6: decode signed wheel delta from HIWORD(wParam).
          // Note: WM_MOUSEWHEEL lParam contains SCREEN coordinates, not client.
          // We use the last known CSS position for the event target.
          const delta = decodeWheelDelta(wParam);
          deps.send({
            type: 'mouseWheel',
            x: lastCssX,
            y: lastCssY,
            deltaX: 0,
            deltaY: delta,
          } as Electron.MouseWheelInputEvent);
          return 0;
        }

        // ── Mouse Wheel (horizontal) ──────────────────────────────────
        case WM_MOUSEHWHEEL: {
          const delta = decodeWheelDelta(wParam);
          deps.send({
            type: 'mouseWheel',
            x: lastCssX,
            y: lastCssY,
            deltaX: delta,
            deltaY: 0,
          } as Electron.MouseWheelInputEvent);
          return 0;
        }

        // ── Mouse Leave ────────────────────────────────────────────────
        case WM_MOUSELEAVE: {
          deps.send({
            type: 'mouseLeave',
            x: lastCssX,
            y: lastCssY,
          } as Electron.MouseInputEvent);
          return 0;
        }

        // ── Key Down ───────────────────────────────────────────────────
        case WM_KEYDOWN:
        case WM_SYSKEYDOWN: {
          deps.send({
            type: 'keyDown',
            keyCode: vkToElectronKeyCode(wParam),
          } as Electron.KeyboardInputEvent);
          return 0;
        }

        // ── Key Up ─────────────────────────────────────────────────────
        case WM_KEYUP:
        case WM_SYSKEYUP: {
          deps.send({
            type: 'keyUp',
            keyCode: vkToElectronKeyCode(wParam),
          } as Electron.KeyboardInputEvent);
          return 0;
        }

        // ── Char ───────────────────────────────────────────────────────
        case WM_CHAR: {
          deps.send({
            type: 'char',
            keyCode: String.fromCharCode(wParam),
          } as Electron.KeyboardInputEvent);
          return 0;
        }

        default:
          // Unhandled message — fall through to DefWindowProcW.
          return null;
      }
    },
  };
}

// ── Virtual Key Code to Electron Key Code Mapping ────────────────────────────

/**
 * Convert a Win32 virtual key code to an Electron-compatible key code string.
 * Electron's sendInputEvent expects key codes as strings matching Chrome's key names.
 *
 * This is a minimal mapping covering common keys. Virtual key codes that don't have
 * a specific mapping are passed through as their string representation.
 */
function vkToElectronKeyCode(vk: number): string {
  // Check the VK map first
  const mapped = VK_MAP.get(vk);
  if (mapped) return mapped;

  // A-Z: VK 0x41-0x5A
  if (vk >= 0x41 && vk <= 0x5A) {
    return String.fromCharCode(vk);
  }

  // 0-9: VK 0x30-0x39
  if (vk >= 0x30 && vk <= 0x39) {
    return String.fromCharCode(vk);
  }

  // Numpad 0-9: VK 0x60-0x69
  if (vk >= 0x60 && vk <= 0x69) {
    return `num${vk - 0x60}`;
  }

  // F1-F24: VK 0x70-0x87
  if (vk >= 0x70 && vk <= 0x87) {
    return `F${vk - 0x70 + 1}`;
  }

  // Fallback: return the VK value as a string
  return String.fromCharCode(vk);
}

/** Map of common Win32 virtual key codes to Electron key code names. */
const VK_MAP: ReadonlyMap<number, string> = new Map([
  [0x08, 'Backspace'],
  [0x09, 'Tab'],
  [0x0D, 'Return'],
  [0x10, 'Shift'],
  [0x11, 'Control'],
  [0x12, 'Alt'],
  [0x13, 'Pause'],
  [0x14, 'CapsLock'],
  [0x1B, 'Escape'],
  [0x20, 'Space'],
  [0x21, 'PageUp'],
  [0x22, 'PageDown'],
  [0x23, 'End'],
  [0x24, 'Home'],
  [0x25, 'Left'],
  [0x26, 'Up'],
  [0x27, 'Right'],
  [0x28, 'Down'],
  [0x2C, 'PrintScreen'],
  [0x2D, 'Insert'],
  [0x2E, 'Delete'],
  [0x5B, 'Meta'],    // Left Windows key
  [0x5C, 'Meta'],    // Right Windows key
  [0x6A, 'nupmul'],  // Numpad *
  [0x6B, 'nupadd'],  // Numpad +
  [0x6D, 'numsub'],  // Numpad -
  [0x6E, 'numdec'],  // Numpad .
  [0x6F, 'nupdiv'],  // Numpad /
  [0x90, 'NumLock'],
  [0x91, 'ScrollLock'],
  [0xBA, ';'],
  [0xBB, '='],
  [0xBC, ','],
  [0xBD, '-'],
  [0xBE, '.'],
  [0xBF, '/'],
  [0xC0, '`'],
  [0xDB, '['],
  [0xDC, '\\'],
  [0xDD, ']'],
  [0xDE, "'"],
]);
