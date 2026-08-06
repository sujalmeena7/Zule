/**
 * Stage C Input Router — Unit Tests
 *
 * Verifies:
 *   - Pointer events preserve Windows order (Req 10.2)
 *   - Wheel events preserve sign and magnitude (Req 10.3)
 *   - Keyboard routing uses controller contract, not synthetic injection (Req 10.5)
 *   - Focus transfer calls controller.MoveFocus (Req 10.4)
 *   - Client coordinate conversion stays within 1 pixel (Req 10.1)
 *
 * Requirements: 10.1–10.5
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PointerEventType,
  PointerButton,
  KeyboardEventType,
  KeyCategory,
  ImeEventType,
  FocusDirection,
  InputRoutingMethod,
  MAX_COORDINATE_ERROR_PX,
  MOVE_FOCUS_REASON,
  validatePointerOrder,
  validateCoordinateError,
  validateWheelDelta,
  decodeWheelDeltaFromWParam,
  decodeClientCoordinates,
  classifyKey,
  getKeyboardRoutingMethod,
  getImeRoutingMethod,
  getFocusRoutingMethod,
  createInputRouter,
  type PointerEvent,
  type WheelEvent,
  type KeyboardEvent,
  type ImeEvent,
  type FocusEvent,
  type ModifierState,
  type InputRouterDeps,
} from '../../../stageC/input/inputRouter';


// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

const NO_MODIFIERS: ModifierState = { ctrl: false, alt: false, shift: false, win: false };

function makePointerEvent(type: PointerEventType, x = 100, y = 200, button = PointerButton.None, buttons = 0): PointerEvent {
  return { type, clientX: x, clientY: y, button, buttons, timestamp: Date.now() };
}

function makeWheelEvent(deltaX: number, deltaY: number): WheelEvent {
  return { deltaX, deltaY, clientX: 50, clientY: 50, timestamp: Date.now() };
}

function makeKeyboardEvent(
  type: KeyboardEventType,
  keyCode: number,
  modifiers: ModifierState = NO_MODIFIERS,
): KeyboardEvent {
  return { type, keyCode, scanCode: keyCode, modifiers, repeat: false, timestamp: Date.now() };
}

function makeImeEvent(type: ImeEventType): ImeEvent {
  return { type, compositionText: '你', cursorPosition: 1, timestamp: Date.now() };
}

function makeFocusEvent(direction: FocusDirection): FocusEvent {
  return { direction, timestamp: Date.now() };
}

function createMockDeps(): InputRouterDeps & {
  calls: { pointer: PointerEvent[]; wheel: WheelEvent[]; keyboard: KeyboardEvent[]; ime: ImeEvent[]; focus: FocusDirection[] };
} {
  const calls = {
    pointer: [] as PointerEvent[],
    wheel: [] as WheelEvent[],
    keyboard: [] as KeyboardEvent[],
    ime: [] as ImeEvent[],
    focus: [] as FocusDirection[],
  };
  return {
    calls,
    sendPointerToController(event) { calls.pointer.push(event); return true; },
    sendWheelToController(event) { calls.wheel.push(event); return true; },
    routeKeyboardMessage(event) { calls.keyboard.push(event); return true; },
    routeImeMessage(event) { calls.ime.push(event); return true; },
    moveFocus(direction) { calls.focus.push(direction); return true; },
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// 1. Pointer Event Order Preservation (Requirement 10.2)
// ─────────────────────────────────────────────────────────────────────────────

describe('Pointer event ordering (Req 10.2)', () => {
  it('accepts valid enter → move → leave sequence', () => {
    const events: PointerEvent[] = [
      makePointerEvent(PointerEventType.Enter),
      makePointerEvent(PointerEventType.Move),
      makePointerEvent(PointerEventType.Leave),
    ];
    expect(validatePointerOrder(events)).toBe(true);
  });

  it('accepts valid enter → buttonDown → buttonUp → leave sequence', () => {
    const events: PointerEvent[] = [
      makePointerEvent(PointerEventType.Enter),
      makePointerEvent(PointerEventType.ButtonDown),
      makePointerEvent(PointerEventType.ButtonUp),
      makePointerEvent(PointerEventType.Leave),
    ];
    expect(validatePointerOrder(events)).toBe(true);
  });

  it('accepts enter → move → move → buttonDown → move → buttonUp → move → leave', () => {
    const events: PointerEvent[] = [
      makePointerEvent(PointerEventType.Enter),
      makePointerEvent(PointerEventType.Move),
      makePointerEvent(PointerEventType.Move),
      makePointerEvent(PointerEventType.ButtonDown),
      makePointerEvent(PointerEventType.Move),
      makePointerEvent(PointerEventType.ButtonUp),
      makePointerEvent(PointerEventType.Move),
      makePointerEvent(PointerEventType.Leave),
    ];
    expect(validatePointerOrder(events)).toBe(true);
  });

  it('rejects leave → move (invalid: must re-enter first)', () => {
    const events: PointerEvent[] = [
      makePointerEvent(PointerEventType.Leave),
      makePointerEvent(PointerEventType.Move),
    ];
    expect(validatePointerOrder(events)).toBe(false);
  });

  it('rejects buttonDown → enter (invalid transition)', () => {
    const events: PointerEvent[] = [
      makePointerEvent(PointerEventType.ButtonDown),
      makePointerEvent(PointerEventType.Enter),
    ];
    expect(validatePointerOrder(events)).toBe(false);
  });


  it('accepts single-event sequences', () => {
    expect(validatePointerOrder([makePointerEvent(PointerEventType.Enter)])).toBe(true);
    expect(validatePointerOrder([])).toBe(true);
  });

  it('accepts hover transitions', () => {
    const events: PointerEvent[] = [
      makePointerEvent(PointerEventType.Enter),
      makePointerEvent(PointerEventType.Hover),
      makePointerEvent(PointerEventType.Hover),
      makePointerEvent(PointerEventType.Leave),
    ];
    expect(validatePointerOrder(events)).toBe(true);
  });

  it('router rejects out-of-order pointer events', () => {
    const deps = createMockDeps();
    const router = createInputRouter(deps);

    // Send enter first (valid)
    const r1 = router.forwardPointer(makePointerEvent(PointerEventType.Enter));
    expect(r1.success).toBe(true);

    // Send leave (valid after enter)
    const r2 = router.forwardPointer(makePointerEvent(PointerEventType.Leave));
    expect(r2.success).toBe(true);

    // Send move without re-enter (invalid)
    const r3 = router.forwardPointer(makePointerEvent(PointerEventType.Move));
    expect(r3.success).toBe(false);
    expect(r3.error).toContain('Invalid pointer transition');
  });

  it('router forwards events in order to composition controller', () => {
    const deps = createMockDeps();
    const router = createInputRouter(deps);

    router.forwardPointer(makePointerEvent(PointerEventType.Enter, 10, 20));
    router.forwardPointer(makePointerEvent(PointerEventType.Move, 30, 40));
    router.forwardPointer(makePointerEvent(PointerEventType.Leave, 30, 40));

    expect(deps.calls.pointer).toHaveLength(3);
    expect(deps.calls.pointer[0].type).toBe(PointerEventType.Enter);
    expect(deps.calls.pointer[1].type).toBe(PointerEventType.Move);
    expect(deps.calls.pointer[2].type).toBe(PointerEventType.Leave);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// 2. Wheel Event Sign and Magnitude Preservation (Requirement 10.3)
// ─────────────────────────────────────────────────────────────────────────────

describe('Wheel event sign and magnitude (Req 10.3)', () => {
  it('preserves positive vertical scroll delta', () => {
    expect(validateWheelDelta(120, 120)).toBe(true);
    expect(validateWheelDelta(240, 240)).toBe(true);
  });

  it('preserves negative vertical scroll delta', () => {
    expect(validateWheelDelta(-120, -120)).toBe(true);
    expect(validateWheelDelta(-360, -360)).toBe(true);
  });

  it('rejects magnitude mismatch', () => {
    expect(validateWheelDelta(120, 119)).toBe(false);
    expect(validateWheelDelta(-120, -121)).toBe(false);
  });

  it('rejects sign inversion', () => {
    expect(validateWheelDelta(120, -120)).toBe(false);
    expect(validateWheelDelta(-120, 120)).toBe(false);
  });

  it('preserves zero delta', () => {
    expect(validateWheelDelta(0, 0)).toBe(true);
  });

  it('decodes positive wheel delta from wParam HIWORD', () => {
    // HIWORD of wParam contains the signed delta
    // Positive: 120 in HIWORD → wParam = 120 << 16 = 0x00780000
    const wParam = 120 << 16;
    expect(decodeWheelDeltaFromWParam(wParam)).toBe(120);
  });

  it('decodes negative wheel delta from wParam HIWORD', () => {
    // Negative: -120 as unsigned 16-bit = 0xFF88, in HIWORD → wParam = 0xFF880000
    const wParam = (-120 & 0xffff) << 16;
    expect(decodeWheelDeltaFromWParam(wParam)).toBe(-120);
  });

  it('decodes large positive delta', () => {
    const wParam = 360 << 16;
    expect(decodeWheelDeltaFromWParam(wParam)).toBe(360);
  });

  it('decodes large negative delta', () => {
    const wParam = (-360 & 0xffff) << 16;
    expect(decodeWheelDeltaFromWParam(wParam)).toBe(-360);
  });

  it('decodes zero delta', () => {
    expect(decodeWheelDeltaFromWParam(0)).toBe(0);
  });

  it('router forwards wheel events with exact deltas to controller', () => {
    const deps = createMockDeps();
    const router = createInputRouter(deps);

    const event = makeWheelEvent(-120, 240);
    const result = router.forwardWheel(event);

    expect(result.success).toBe(true);
    expect(result.method).toBe(InputRoutingMethod.CompositionControllerApi);
    expect(deps.calls.wheel).toHaveLength(1);
    expect(deps.calls.wheel[0].deltaX).toBe(-120);
    expect(deps.calls.wheel[0].deltaY).toBe(240);
  });

  it('router preserves horizontal wheel delta sign', () => {
    const deps = createMockDeps();
    const router = createInputRouter(deps);

    router.forwardWheel(makeWheelEvent(-240, 0));
    router.forwardWheel(makeWheelEvent(360, 0));

    expect(deps.calls.wheel[0].deltaX).toBe(-240);
    expect(deps.calls.wheel[1].deltaX).toBe(360);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// 3. Focus Transfer via MoveFocus (Requirement 10.4)
// ─────────────────────────────────────────────────────────────────────────────

describe('Focus transfer via controller.MoveFocus (Req 10.4)', () => {
  it('uses ControllerMoveFocus routing method', () => {
    const event = makeFocusEvent(FocusDirection.Programmatic);
    expect(getFocusRoutingMethod(event)).toBe(InputRoutingMethod.ControllerMoveFocus);
  });

  it('transfers focus forward (Next) through MoveFocus', () => {
    const deps = createMockDeps();
    const router = createInputRouter(deps);

    const result = router.transferFocus(makeFocusEvent(FocusDirection.Next));

    expect(result.success).toBe(true);
    expect(result.method).toBe(InputRoutingMethod.ControllerMoveFocus);
    expect(deps.calls.focus).toHaveLength(1);
    expect(deps.calls.focus[0]).toBe(FocusDirection.Next);
  });

  it('transfers focus backward (Previous) through MoveFocus', () => {
    const deps = createMockDeps();
    const router = createInputRouter(deps);

    const result = router.transferFocus(makeFocusEvent(FocusDirection.Previous));

    expect(result.success).toBe(true);
    expect(deps.calls.focus[0]).toBe(FocusDirection.Previous);
  });

  it('transfers focus programmatically for interactive activation', () => {
    const deps = createMockDeps();
    const router = createInputRouter(deps);

    const result = router.transferFocus(makeFocusEvent(FocusDirection.Programmatic));

    expect(result.success).toBe(true);
    expect(result.method).toBe(InputRoutingMethod.ControllerMoveFocus);
    expect(deps.calls.focus[0]).toBe(FocusDirection.Programmatic);
  });

  it('does not activate unrelated windows (only calls moveFocus)', () => {
    const deps = createMockDeps();
    const router = createInputRouter(deps);

    router.transferFocus(makeFocusEvent(FocusDirection.Programmatic));

    // Only moveFocus should be called — no pointer or keyboard calls
    expect(deps.calls.pointer).toHaveLength(0);
    expect(deps.calls.keyboard).toHaveLength(0);
    expect(deps.calls.focus).toHaveLength(1);
  });

  it('maps FocusDirection to correct COREWEBVIEW2_MOVE_FOCUS_REASON values', () => {
    expect(MOVE_FOCUS_REASON[FocusDirection.Programmatic]).toBe(0);
    expect(MOVE_FOCUS_REASON[FocusDirection.Next]).toBe(1);
    expect(MOVE_FOCUS_REASON[FocusDirection.Previous]).toBe(2);
  });

  it('reports failure when moveFocus returns false', () => {
    const deps = createMockDeps();
    deps.moveFocus = () => false;
    const router = createInputRouter(deps);

    const result = router.transferFocus(makeFocusEvent(FocusDirection.Next));

    expect(result.success).toBe(false);
    expect(result.method).toBe(InputRoutingMethod.ControllerMoveFocus);
    expect(result.error).toBeDefined();
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// 4. Client Coordinate Accuracy (Requirement 10.1)
// ─────────────────────────────────────────────────────────────────────────────

describe('Client coordinate accuracy (Req 10.1)', () => {
  it('validates coordinates within 1px tolerance', () => {
    expect(validateCoordinateError({ x: 100, y: 200 }, { x: 100, y: 200 })).toBe(true);
    expect(validateCoordinateError({ x: 100, y: 200 }, { x: 101, y: 200 })).toBe(true);
    expect(validateCoordinateError({ x: 100, y: 200 }, { x: 100, y: 201 })).toBe(true);
    expect(validateCoordinateError({ x: 100, y: 200 }, { x: 101, y: 201 })).toBe(true);
  });

  it('rejects coordinates exceeding 1px error', () => {
    expect(validateCoordinateError({ x: 100, y: 200 }, { x: 102, y: 200 })).toBe(false);
    expect(validateCoordinateError({ x: 100, y: 200 }, { x: 100, y: 202 })).toBe(false);
  });

  it('handles negative coordinate differences', () => {
    expect(validateCoordinateError({ x: 100, y: 200 }, { x: 99, y: 199 })).toBe(true);
    expect(validateCoordinateError({ x: 100, y: 200 }, { x: 98, y: 200 })).toBe(false);
  });

  it('decodes signed client coordinates from lParam', () => {
    // Pack (300, 400) into lParam: y in HIWORD, x in LOWORD
    const lParam = (400 << 16) | (300 & 0xffff);
    const { x, y } = decodeClientCoordinates(lParam);
    expect(x).toBe(300);
    expect(y).toBe(400);
  });

  it('decodes negative client coordinates from lParam', () => {
    // Negative x = -5: as unsigned 16-bit = 0xFFFB
    // Negative y = -10: as unsigned 16-bit = 0xFFF6
    const xUnsigned = (-5 & 0xffff);
    const yUnsigned = (-10 & 0xffff);
    const lParam = (yUnsigned << 16) | xUnsigned;
    const { x, y } = decodeClientCoordinates(lParam);
    expect(x).toBe(-5);
    expect(y).toBe(-10);
  });

  it('decodes boundary value coordinates', () => {
    // Max positive 16-bit signed: 32767
    const lParam = (32767 << 16) | (32767 & 0xffff);
    const { x, y } = decodeClientCoordinates(lParam);
    expect(x).toBe(32767);
    expect(y).toBe(32767);
  });

  it('decodes min negative coordinates (−32768)', () => {
    const xUnsigned = (-32768 & 0xffff); // 0x8000
    const yUnsigned = (-32768 & 0xffff);
    const lParam = (yUnsigned << 16) | xUnsigned;
    const { x, y } = decodeClientCoordinates(lParam);
    expect(x).toBe(-32768);
    expect(y).toBe(-32768);
  });

  it('router forwards pointer events with exact client coordinates', () => {
    const deps = createMockDeps();
    const router = createInputRouter(deps);

    router.forwardPointer(makePointerEvent(PointerEventType.Enter, 512, 768));

    expect(deps.calls.pointer[0].clientX).toBe(512);
    expect(deps.calls.pointer[0].clientY).toBe(768);
  });

  it('MAX_COORDINATE_ERROR_PX is exactly 1', () => {
    expect(MAX_COORDINATE_ERROR_PX).toBe(1);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// 5. Keyboard Routing via Controller Contract (Requirement 10.5)
// ─────────────────────────────────────────────────────────────────────────────

describe('Keyboard routing via Windows messages, not synthetic injection (Req 10.5)', () => {
  it('routes keyboard through WindowsMessageRouting method', () => {
    const event = makeKeyboardEvent(KeyboardEventType.KeyDown, 0x41); // 'A'
    expect(getKeyboardRoutingMethod(event)).toBe(InputRoutingMethod.WindowsMessageRouting);
  });

  it('routes IME through WindowsMessageRouting method', () => {
    const event = makeImeEvent(ImeEventType.CompositionStart);
    expect(getImeRoutingMethod(event)).toBe(InputRoutingMethod.WindowsMessageRouting);
  });

  it('never uses CompositionControllerApi for keyboard (no synthetic injection)', () => {
    // Test all keyboard event types
    const types = [KeyboardEventType.KeyDown, KeyboardEventType.KeyUp, KeyboardEventType.SysKeyDown, KeyboardEventType.SysKeyUp];
    for (const type of types) {
      const event = makeKeyboardEvent(type, 0x41);
      const method = getKeyboardRoutingMethod(event);
      expect(method).not.toBe(InputRoutingMethod.CompositionControllerApi);
    }
  });

  it('never uses CompositionControllerApi for IME (no synthetic injection)', () => {
    const types = [ImeEventType.CompositionStart, ImeEventType.CompositionUpdate, ImeEventType.CompositionEnd];
    for (const type of types) {
      const event = makeImeEvent(type);
      const method = getImeRoutingMethod(event);
      expect(method).not.toBe(InputRoutingMethod.CompositionControllerApi);
    }
  });

  it('routes printable keys through routeKeyboardMessage', () => {
    const deps = createMockDeps();
    const router = createInputRouter(deps);

    const event = makeKeyboardEvent(KeyboardEventType.KeyDown, 0x41); // 'A'
    const result = router.routeKeyboard(event);

    expect(result.success).toBe(true);
    expect(result.method).toBe(InputRoutingMethod.WindowsMessageRouting);
    expect(deps.calls.keyboard).toHaveLength(1);
    expect(deps.calls.keyboard[0].keyCode).toBe(0x41);
  });

  it('routes modifier keys through routeKeyboardMessage', () => {
    const deps = createMockDeps();
    const router = createInputRouter(deps);

    // Ctrl key (VK_CONTROL = 0x11)
    const event = makeKeyboardEvent(KeyboardEventType.KeyDown, 0x11);
    const result = router.routeKeyboard(event);

    expect(result.success).toBe(true);
    expect(result.method).toBe(InputRoutingMethod.WindowsMessageRouting);
    expect(classifyKey(0x11, NO_MODIFIERS)).toBe(KeyCategory.Modifier);
  });

  it('routes navigation keys through routeKeyboardMessage', () => {
    const deps = createMockDeps();
    const router = createInputRouter(deps);

    // VK_LEFT = 0x25
    const event = makeKeyboardEvent(KeyboardEventType.KeyDown, 0x25);
    const result = router.routeKeyboard(event);

    expect(result.success).toBe(true);
    expect(result.method).toBe(InputRoutingMethod.WindowsMessageRouting);
    expect(classifyKey(0x25, NO_MODIFIERS)).toBe(KeyCategory.Navigation);
  });

  it('routes editing keys through routeKeyboardMessage', () => {
    const deps = createMockDeps();
    const router = createInputRouter(deps);

    // VK_DELETE = 0x2E
    const event = makeKeyboardEvent(KeyboardEventType.KeyDown, 0x2E);
    const result = router.routeKeyboard(event);

    expect(result.success).toBe(true);
    expect(result.method).toBe(InputRoutingMethod.WindowsMessageRouting);
    expect(classifyKey(0x2E, NO_MODIFIERS)).toBe(KeyCategory.Editing);
  });

  it('routes accelerator keys (Ctrl+C) through routeKeyboardMessage', () => {
    const deps = createMockDeps();
    const router = createInputRouter(deps);

    const ctrlModifiers: ModifierState = { ctrl: true, alt: false, shift: false, win: false };
    const event = makeKeyboardEvent(KeyboardEventType.KeyDown, 0x43, ctrlModifiers); // Ctrl+C
    const result = router.routeKeyboard(event);

    expect(result.success).toBe(true);
    expect(result.method).toBe(InputRoutingMethod.WindowsMessageRouting);
    expect(classifyKey(0x43, ctrlModifiers)).toBe(KeyCategory.Accelerator);
  });

  it('routes IME composition events through routeImeMessage', () => {
    const deps = createMockDeps();
    const router = createInputRouter(deps);

    const startEvent = makeImeEvent(ImeEventType.CompositionStart);
    const updateEvent = makeImeEvent(ImeEventType.CompositionUpdate);
    const endEvent = makeImeEvent(ImeEventType.CompositionEnd);

    router.routeIme(startEvent);
    router.routeIme(updateEvent);
    router.routeIme(endEvent);

    expect(deps.calls.ime).toHaveLength(3);
    expect(deps.calls.ime[0].type).toBe(ImeEventType.CompositionStart);
    expect(deps.calls.ime[1].type).toBe(ImeEventType.CompositionUpdate);
    expect(deps.calls.ime[2].type).toBe(ImeEventType.CompositionEnd);
  });

  it('classifies all key categories correctly', () => {
    // VK_SHIFT = 0x10 → Modifier
    expect(classifyKey(0x10, NO_MODIFIERS)).toBe(KeyCategory.Modifier);
    // VK_HOME = 0x24 → Navigation
    expect(classifyKey(0x24, NO_MODIFIERS)).toBe(KeyCategory.Navigation);
    // VK_INSERT = 0x2D → Editing
    expect(classifyKey(0x2D, NO_MODIFIERS)).toBe(KeyCategory.Editing);
    // VK_BACK = 0x08 → Editing
    expect(classifyKey(0x08, NO_MODIFIERS)).toBe(KeyCategory.Editing);
    // 'A' with Ctrl → Accelerator
    expect(classifyKey(0x41, { ctrl: true, alt: false, shift: false, win: false })).toBe(KeyCategory.Accelerator);
    // 'A' alone → Printable
    expect(classifyKey(0x41, NO_MODIFIERS)).toBe(KeyCategory.Printable);
    // Space alone → Printable
    expect(classifyKey(0x20, NO_MODIFIERS)).toBe(KeyCategory.Printable);
  });

  it('keyboard routing reports failure correctly', () => {
    const deps = createMockDeps();
    deps.routeKeyboardMessage = () => false;
    const router = createInputRouter(deps);

    const result = router.routeKeyboard(makeKeyboardEvent(KeyboardEventType.KeyDown, 0x41));

    expect(result.success).toBe(false);
    expect(result.method).toBe(InputRoutingMethod.WindowsMessageRouting);
    expect(result.error).toBeDefined();
  });

  it('IME routing reports failure correctly', () => {
    const deps = createMockDeps();
    deps.routeImeMessage = () => false;
    const router = createInputRouter(deps);

    const result = router.routeIme(makeImeEvent(ImeEventType.CompositionUpdate));

    expect(result.success).toBe(false);
    expect(result.method).toBe(InputRoutingMethod.WindowsMessageRouting);
    expect(result.error).toBeDefined();
  });
});
