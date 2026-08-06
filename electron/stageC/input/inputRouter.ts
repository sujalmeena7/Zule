/**
 * Stage C Input Router — Pointer, Wheel, Keyboard, IME, and Focus Routing
 * Zule AI — Stage C7
 *
 * Defines the input routing contract for the native WebView2 composition controller.
 * All pointer events are forwarded in client coordinates. Keyboard and IME input
 * are routed through normal Windows message routing and the pinned WebView2 controller
 * contract — never through synthetic text injection.
 *
 * The native C++ implementation (ZuleUI.exe) calls the WebView2 composition APIs:
 *   - ICoreWebView2CompositionController::SendMouseInput (pointer events)
 *   - ICoreWebView2CompositionController::SendPointerInfo (pen/touch)
 *   - ICoreWebView2Controller::MoveFocus (focus transfer)
 *   - Standard Windows message routing for keyboard/IME (WM_KEYDOWN, WM_IME_*)
 *
 * This TypeScript module provides:
 *   1. Typed event models for pointer, wheel, keyboard, IME, and focus
 *   2. The InputRouter contract implemented by the native sidecar
 *   3. Testable pure functions for coordinate conversion and event ordering
 *   4. Validation logic for event payloads
 *
 * Requirements: 10.1–10.5
 */

// ─────────────────────────────────────────────────────────────────────────────
// Pointer Event Types
// ─────────────────────────────────────────────────────────────────────────────

/** Pointer event types preserving Windows message order */
export enum PointerEventType {
  Enter = 'enter',
  Move = 'move',
  ButtonDown = 'buttonDown',
  ButtonUp = 'buttonUp',
  Hover = 'hover',
  Leave = 'leave',
}

/** Mouse button identifiers */
export enum PointerButton {
  None = 0,
  Left = 1,
  Right = 2,
  Middle = 3,
}

/**
 * Pointer event in client coordinates.
 * Error must not exceed 1 physical pixel on each edge-derived axis.
 * (Requirement 10.1)
 */
export interface PointerEvent {
  /** Event type — enter/move/buttonDown/buttonUp/hover/leave */
  type: PointerEventType;

  /** Client X coordinate in physical pixels */
  clientX: number;

  /** Client Y coordinate in physical pixels */
  clientY: number;

  /** Which button was pressed/released (or None for moves) */
  button: PointerButton;

  /** Bitmask of currently pressed buttons (0=none, 1=left, 2=right, 4=middle) */
  buttons: number;

  /** Monotonic timestamp in milliseconds */
  timestamp: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wheel Event Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wheel event preserving signed magnitude.
 * Both WHEEL_DELTA direction and magnitude must be exact.
 * (Requirement 10.3)
 */
export interface WheelEvent {
  /** Horizontal wheel delta (signed, multiples of WHEEL_DELTA=120) */
  deltaX: number;

  /** Vertical wheel delta (signed, multiples of WHEEL_DELTA=120) */
  deltaY: number;

  /** Client X coordinate at wheel event (physical pixels) */
  clientX: number;

  /** Client Y coordinate at wheel event (physical pixels) */
  clientY: number;

  /** Monotonic timestamp in milliseconds */
  timestamp: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyboard Event Types
// ─────────────────────────────────────────────────────────────────────────────

/** Keyboard event types (routed via Windows messages, not synthetic injection) */
export enum KeyboardEventType {
  KeyDown = 'keyDown',
  KeyUp = 'keyUp',
  /** System key (Alt combinations) */
  SysKeyDown = 'sysKeyDown',
  SysKeyUp = 'sysKeyUp',
}

/** Key categories per Requirement 10.5 */
export enum KeyCategory {
  /** Letters, digits, punctuation */
  Printable = 'printable',
  /** Ctrl, Alt, Shift, Win */
  Modifier = 'modifier',
  /** Arrows, Home, End, PageUp, PageDown */
  Navigation = 'navigation',
  /** Insert, Delete, Backspace */
  Editing = 'editing',
  /** Ctrl+C, Ctrl+V, Alt+F4, etc. */
  Accelerator = 'accelerator',
}

/** Modifier key state */
export interface ModifierState {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  win: boolean;
}

/**
 * Keyboard event routed through normal Windows message routing.
 * Must NOT use synthetic text injection (Requirement 10.5).
 */
export interface KeyboardEvent {
  /** Event type */
  type: KeyboardEventType;

  /** Win32 virtual key code */
  keyCode: number;

  /** Hardware scan code */
  scanCode: number;

  /** Current modifier state */
  modifiers: ModifierState;

  /** Whether this is a key repeat (bit 30 of lParam) */
  repeat: boolean;

  /** Monotonic timestamp in milliseconds */
  timestamp: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// IME Event Types
// ─────────────────────────────────────────────────────────────────────────────

/** IME composition event types */
export enum ImeEventType {
  /** WM_IME_STARTCOMPOSITION */
  CompositionStart = 'compositionStart',
  /** WM_IME_COMPOSITION */
  CompositionUpdate = 'compositionUpdate',
  /** WM_IME_ENDCOMPOSITION */
  CompositionEnd = 'compositionEnd',
}

/**
 * IME composition event routed through the WebView2 controller's IME contract.
 * Must not use synthetic text injection (Requirement 10.5).
 */
export interface ImeEvent {
  /** Composition phase */
  type: ImeEventType;

  /** Current composition string (during updates) */
  compositionText: string;

  /** Cursor position within composition */
  cursorPosition: number;

  /** Monotonic timestamp in milliseconds */
  timestamp: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Focus Event Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Focus transfer direction for controller.MoveFocus().
 * Maps to COREWEBVIEW2_MOVE_FOCUS_REASON.
 */
export enum FocusDirection {
  /** Tab forward (COREWEBVIEW2_MOVE_FOCUS_REASON_NEXT) */
  Next = 'next',
  /** Shift+Tab backward (COREWEBVIEW2_MOVE_FOCUS_REASON_PREVIOUS) */
  Previous = 'previous',
  /** Programmatic / interactive activation (COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC) */
  Programmatic = 'programmatic',
}

/**
 * Focus event for transferring focus to/from WebView2.
 * Uses the supported controller.MoveFocus() contract.
 * (Requirement 10.4)
 */
export interface FocusEvent {
  /** Direction of focus transfer */
  direction: FocusDirection;

  /** Monotonic timestamp in milliseconds */
  timestamp: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Input Router Contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Routing method used for keyboard/IME input.
 * The contract requires normal Windows message routing — never synthetic injection.
 */
export enum InputRoutingMethod {
  /** Normal Windows message routing via WndProc → WebView2 controller */
  WindowsMessageRouting = 'windowsMessageRouting',
  /** WebView2 composition controller API (for pointer events) */
  CompositionControllerApi = 'compositionControllerApi',
  /** WebView2 controller.MoveFocus() (for focus transfer) */
  ControllerMoveFocus = 'controllerMoveFocus',
}

/**
 * Result of an input routing operation.
 */
export interface InputRouteResult {
  /** Whether the event was successfully routed */
  success: boolean;

  /** Routing method used */
  method: InputRoutingMethod;

  /** Error message if routing failed */
  error?: string;
}

/**
 * The InputRouter contract defines how the Stage C native sidecar routes input
 * to the WebView2 composition controller.
 *
 * Implementation is in C++ (ZuleUI.exe); this interface documents the contract
 * that is tested at boundaries and through integration tests.
 */
export interface InputRouter {
  /**
   * Forward a pointer event to the WebView2 composition controller in client coordinates.
   * Must preserve Windows event order (enter→move→button→leave).
   * Coordinate error must not exceed 1 physical pixel per edge-derived axis.
   * (Requirement 10.1, 10.2)
   */
  forwardPointer(event: PointerEvent): InputRouteResult;

  /**
   * Forward a wheel event preserving signed magnitude exactly.
   * Both WHEEL_DELTA direction and magnitude must be exact.
   * (Requirement 10.3)
   */
  forwardWheel(event: WheelEvent): InputRouteResult;

  /**
   * Route keyboard input through normal Windows message routing.
   * Routes printable keys, modifiers, navigation keys, editing keys, and accelerators.
   * Must NOT use synthetic text injection.
   * (Requirement 10.5)
   */
  routeKeyboard(event: KeyboardEvent): InputRouteResult;

  /**
   * Route IME composition input through the WebView2 controller's IME contract.
   * Must NOT use synthetic text injection.
   * (Requirement 10.5)
   */
  routeIme(event: ImeEvent): InputRouteResult;

  /**
   * Transfer focus to/from WebView2 using controller.MoveFocus().
   * Interactive activation must move focus without activating an unrelated Zule window.
   * (Requirement 10.4)
   */
  transferFocus(event: FocusEvent): InputRouteResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure validation and ordering functions (testable without native APIs)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Valid pointer event ordering transitions.
 * Preserves Windows event order: enter → move/button/hover → leave.
 * (Requirement 10.2)
 */
const VALID_POINTER_TRANSITIONS: ReadonlyMap<PointerEventType, readonly PointerEventType[]> =
  new Map([
    [PointerEventType.Enter, [PointerEventType.Move, PointerEventType.ButtonDown, PointerEventType.Hover, PointerEventType.Leave]],
    [PointerEventType.Move, [PointerEventType.Move, PointerEventType.ButtonDown, PointerEventType.ButtonUp, PointerEventType.Hover, PointerEventType.Leave]],
    [PointerEventType.ButtonDown, [PointerEventType.Move, PointerEventType.ButtonUp, PointerEventType.Leave]],
    [PointerEventType.ButtonUp, [PointerEventType.Move, PointerEventType.ButtonDown, PointerEventType.Hover, PointerEventType.Leave]],
    [PointerEventType.Hover, [PointerEventType.Move, PointerEventType.Hover, PointerEventType.ButtonDown, PointerEventType.Leave]],
    [PointerEventType.Leave, [PointerEventType.Enter]],
  ]);

/**
 * Validates that a sequence of pointer events preserves Windows ordering.
 * Returns true if the sequence is valid, false if any transition is invalid.
 * (Requirement 10.2)
 */
export function validatePointerOrder(events: readonly PointerEvent[]): boolean {
  if (events.length <= 1) return true;

  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1].type;
    const curr = events[i].type;
    const validNext = VALID_POINTER_TRANSITIONS.get(prev);
    if (!validNext || !validNext.includes(curr)) {
      return false;
    }
  }
  return true;
}

/**
 * Maximum coordinate error for client-coordinate pointer forwarding.
 * Must not exceed 1 physical pixel per edge-derived axis.
 * (Requirement 10.1)
 */
export const MAX_COORDINATE_ERROR_PX = 1;

/**
 * Validates that a forwarded pointer coordinate is within the 1-pixel tolerance.
 * (Requirement 10.1)
 */
export function validateCoordinateError(
  intended: { x: number; y: number },
  actual: { x: number; y: number },
): boolean {
  return (
    Math.abs(intended.x - actual.x) <= MAX_COORDINATE_ERROR_PX &&
    Math.abs(intended.y - actual.y) <= MAX_COORDINATE_ERROR_PX
  );
}

/**
 * Validates that a wheel delta preserves sign and magnitude exactly.
 * (Requirement 10.3)
 */
export function validateWheelDelta(intended: number, actual: number): boolean {
  return intended === actual;
}

/**
 * Decode a signed 16-bit wheel delta from a Win32 wParam HIWORD.
 * Preserves sign and exact magnitude.
 * (Requirement 10.3)
 */
export function decodeWheelDeltaFromWParam(wParam: number): number {
  return ((wParam >> 16) & 0xffff) << 16 >> 16;
}

/**
 * Decode signed 16-bit mouse coordinates from a Win32 lParam.
 * (Requirement 10.1)
 */
export function decodeClientCoordinates(lParam: number): { x: number; y: number } {
  const x = (lParam & 0xffff) << 16 >> 16;
  const y = ((lParam >> 16) & 0xffff) << 16 >> 16;
  return { x, y };
}

/**
 * Classify a virtual key code into its key category.
 * Used to verify all required categories are routed (Requirement 10.5).
 */
export function classifyKey(vk: number, modifiers: ModifierState): KeyCategory {
  // Modifier keys
  if (vk === 0x10 || vk === 0x11 || vk === 0x12 || vk === 0x5B || vk === 0x5C ||
      vk === 0xA0 || vk === 0xA1 || vk === 0xA2 || vk === 0xA3 || vk === 0xA4 || vk === 0xA5) {
    return KeyCategory.Modifier;
  }

  // Navigation keys: arrows, Home, End, PageUp, PageDown
  if (vk >= 0x21 && vk <= 0x28) {
    return KeyCategory.Navigation;
  }

  // Editing keys: Insert (0x2D), Delete (0x2E), Backspace (0x08)
  if (vk === 0x2D || vk === 0x2E || vk === 0x08) {
    return KeyCategory.Editing;
  }

  // Accelerator: any key with Ctrl or Alt held (except lone modifier press)
  if (modifiers.ctrl || modifiers.alt) {
    return KeyCategory.Accelerator;
  }

  // Printable: letters, digits, space, OEM keys, function keys, etc.
  return KeyCategory.Printable;
}

/**
 * Determines the correct routing method for a keyboard event.
 * All keyboard input uses Windows message routing — never synthetic text injection.
 * (Requirement 10.5)
 */
export function getKeyboardRoutingMethod(_event: KeyboardEvent): InputRoutingMethod {
  // ALL keyboard input is routed through normal Windows message routing.
  // This is a contract assertion: the design explicitly forbids synthetic text injection.
  return InputRoutingMethod.WindowsMessageRouting;
}

/**
 * Determines the correct routing method for an IME event.
 * IME composition uses Windows message routing to the WebView2 controller's IME contract.
 * Must NOT use synthetic text injection.
 * (Requirement 10.5)
 */
export function getImeRoutingMethod(_event: ImeEvent): InputRoutingMethod {
  // IME composition is routed through normal Windows messaging to the
  // WebView2 controller, which handles WM_IME_* messages natively.
  return InputRoutingMethod.WindowsMessageRouting;
}

/**
 * Determines the correct routing method for a focus event.
 * Focus transfer uses the controller.MoveFocus() contract.
 * (Requirement 10.4)
 */
export function getFocusRoutingMethod(_event: FocusEvent): InputRoutingMethod {
  return InputRoutingMethod.ControllerMoveFocus;
}

// ─────────────────────────────────────────────────────────────────────────────
// Win32 Message Constants for input routing
// ─────────────────────────────────────────────────────────────────────────────

/** Win32 message constants used in the input routing path */
export const WM = {
  MOUSEMOVE: 0x0200,
  LBUTTONDOWN: 0x0201,
  LBUTTONUP: 0x0202,
  RBUTTONDOWN: 0x0204,
  RBUTTONUP: 0x0205,
  MBUTTONDOWN: 0x0207,
  MBUTTONUP: 0x0208,
  MOUSEWHEEL: 0x020A,
  MOUSEHWHEEL: 0x020E,
  MOUSELEAVE: 0x02A3,
  MOUSEENTER: 0x02A1, // WM_MOUSEHOVER is used as enter proxy
  KEYDOWN: 0x0100,
  KEYUP: 0x0101,
  CHAR: 0x0102,
  SYSKEYDOWN: 0x0104,
  SYSKEYUP: 0x0105,
  IME_STARTCOMPOSITION: 0x010D,
  IME_COMPOSITION: 0x010F,
  IME_ENDCOMPOSITION: 0x010E,
  SETFOCUS: 0x0007,
  KILLFOCUS: 0x0008,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// WebView2 Composition Controller Focus Reasons
// (Maps to COREWEBVIEW2_MOVE_FOCUS_REASON enum)
// ─────────────────────────────────────────────────────────────────────────────

/** Maps FocusDirection to the native COREWEBVIEW2_MOVE_FOCUS_REASON value */
export const MOVE_FOCUS_REASON: Record<FocusDirection, number> = {
  [FocusDirection.Programmatic]: 0,
  [FocusDirection.Next]: 1,
  [FocusDirection.Previous]: 2,
};

// ─────────────────────────────────────────────────────────────────────────────
// Input Router Implementation (TypeScript mock for testing)
// Native implementation is in C++ (native/stage-c/src/)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies injected into the TypeScript-side input router.
 * In production, these map to native Win32/WebView2 APIs.
 * For testing, mock implementations are injected.
 */
export interface InputRouterDeps {
  /**
   * Send a pointer event to the composition controller.
   * Native: ICoreWebView2CompositionController::SendMouseInput()
   */
  sendPointerToController(event: PointerEvent): boolean;

  /**
   * Forward a wheel event to the composition controller.
   * Native: WebView2 processes WM_MOUSEWHEEL/WM_MOUSEHWHEEL through the controller.
   */
  sendWheelToController(event: WheelEvent): boolean;

  /**
   * Route a keyboard message through normal Windows message routing.
   * Native: DefWindowProc/TranslateMessage dispatches to WebView2's message sink.
   * MUST NOT use synthetic text injection.
   */
  routeKeyboardMessage(event: KeyboardEvent): boolean;

  /**
   * Route an IME composition message through the controller's IME contract.
   * Native: WM_IME_* messages are forwarded to the WebView2 controller.
   * MUST NOT use synthetic text injection.
   */
  routeImeMessage(event: ImeEvent): boolean;

  /**
   * Transfer focus via controller.MoveFocus(reason).
   * Native: ICoreWebView2Controller::MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON)
   */
  moveFocus(direction: FocusDirection): boolean;
}

/**
 * Creates an InputRouter implementation backed by the provided dependencies.
 * The router enforces event ordering, coordinate validation, and routing method contracts.
 */
export function createInputRouter(deps: InputRouterDeps): InputRouter {
  /** Track last pointer event type for ordering validation */
  let lastPointerType: PointerEventType | null = null;

  return {
    forwardPointer(event: PointerEvent): InputRouteResult {
      // Validate ordering if we have a previous event
      if (lastPointerType !== null) {
        const validNext = VALID_POINTER_TRANSITIONS.get(lastPointerType);
        if (validNext && !validNext.includes(event.type)) {
          return {
            success: false,
            method: InputRoutingMethod.CompositionControllerApi,
            error: `Invalid pointer transition: ${lastPointerType} → ${event.type}`,
          };
        }
      }

      const success = deps.sendPointerToController(event);
      if (success) {
        lastPointerType = event.type;
      }

      return {
        success,
        method: InputRoutingMethod.CompositionControllerApi,
        error: success ? undefined : 'Composition controller rejected pointer event',
      };
    },

    forwardWheel(event: WheelEvent): InputRouteResult {
      const success = deps.sendWheelToController(event);
      return {
        success,
        method: InputRoutingMethod.CompositionControllerApi,
        error: success ? undefined : 'Composition controller rejected wheel event',
      };
    },

    routeKeyboard(event: KeyboardEvent): InputRouteResult {
      // Contract: all keyboard input goes through Windows message routing
      const success = deps.routeKeyboardMessage(event);
      return {
        success,
        method: InputRoutingMethod.WindowsMessageRouting,
        error: success ? undefined : 'Keyboard routing failed',
      };
    },

    routeIme(event: ImeEvent): InputRouteResult {
      // Contract: IME goes through Windows message routing to the controller IME contract
      const success = deps.routeImeMessage(event);
      return {
        success,
        method: InputRoutingMethod.WindowsMessageRouting,
        error: success ? undefined : 'IME routing failed',
      };
    },

    transferFocus(event: FocusEvent): InputRouteResult {
      // Contract: focus transfer uses controller.MoveFocus()
      const success = deps.moveFocus(event.direction);
      return {
        success,
        method: InputRoutingMethod.ControllerMoveFocus,
        error: success ? undefined : 'Focus transfer failed',
      };
    },
  };
}
