// ============================================
// Zule AI — Native and Automated Windows Input/Geometry Integration Tests
// ============================================
//
// Feature: stealth-window-host
// Task 22.7: Native and automated Windows input/geometry tests
//
// Covers: pointer ordering, click targets, keyboard/IME, both wheel axes,
// focus, overlap precedence, cancelled drags, capture release, negative
// coordinates, monitor crossing/removal/rotation/work-area changes,
// all required scales, and Layer 0 geometry parity.
//
// Requirements: 10.1–10.16, 11.1–11.13, 17.9–17.10

import { describe, it, expect, beforeEach } from 'vitest';
import {
  PointerEventType,
  PointerButton,
  KeyboardEventType,
  KeyCategory,
  ImeEventType,
  FocusDirection,
  InputRoutingMethod,
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
  type KeyboardEvent as KbEvent,
  type ImeEvent,
  type FocusEvent,
  type ModifierState,
  type InputRouterDeps,
} from '../../../stageC/input/inputRouter';
import {
  NCHITTEST,
  hitTest,
  RegionMapCache,
  validateRegionMap,
  type DipRect,
  type RegionMap,
  type RegionCacheDeps,
} from '../../../stageC/input/hitTest';
import {
  dipEdgesToPhysical,
  physicalEdgesToDip,
  applyDpiChange,
  validateTopology,
  operationToPhysical,
  edgesMatchWithinTolerance,
  TopologyDegradation,
  BASE_DPI,
  MAX_EDGE_ERROR_PX,
  type PhysicalRect,
  type DipRectEdges,
  type MonitorInfo,
  type DpiChangeContext,
  type GeometryTarget,
} from '../../../stageC/input/geometry';

// ────────────────────────────────────────────────────────────────────
// Test Helpers
// ────────────────────────────────────────────────────────────────────

const NO_MODIFIERS: ModifierState = { ctrl: false, alt: false, shift: false, win: false };
const REQUIRED_SCALES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3];

function makePointer(
  type: PointerEventType, x = 100, y = 200,
  button = PointerButton.None, buttons = 0,
): PointerEvent {
  return { type, clientX: x, clientY: y, button, buttons, timestamp: Date.now() };
}

function makeWheel(deltaX: number, deltaY: number, x = 50, y = 50): WheelEvent {
  return { deltaX, deltaY, clientX: x, clientY: y, timestamp: Date.now() };
}

function makeKb(type: KeyboardEventType, keyCode: number, mods = NO_MODIFIERS): KbEvent {
  return { type, keyCode, scanCode: keyCode, modifiers: mods, repeat: false, timestamp: Date.now() };
}

function makeIme(type: ImeEventType): ImeEvent {
  return { type, compositionText: '中', cursorPosition: 1, timestamp: Date.now() };
}

function makeFocus(dir: FocusDirection): FocusEvent {
  return { direction: dir, timestamp: Date.now() };
}

function createMockRouterDeps(): InputRouterDeps & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { pointer: [], wheel: [], kb: [], ime: [], focus: [] };
  return {
    calls,
    sendPointerToController(e) { calls.pointer.push(e); return true; },
    sendWheelToController(e) { calls.wheel.push(e); return true; },
    routeKeyboardMessage(e) { calls.kb.push(e); return true; },
    routeImeMessage(e) { calls.ime.push(e); return true; },
    moveFocus(d) { calls.focus.push(d); return true; },
  };
}

function createCacheDeps(): RegionCacheDeps & { bounds: DipRect[]; captures: number } {
  const deps = {
    bounds: [] as DipRect[],
    captures: 0,
    reportFinalBounds(b: DipRect) { deps.bounds.push(b); },
    releaseCapture() { deps.captures++; },
  };
  return deps;
}

// ────────────────────────────────────────────────────────────────────
// 1. Pointer Ordering (Req 10.2)
// ────────────────────────────────────────────────────────────────────

describe('Pointer ordering integration', () => {
  it('valid enter→move→buttonDown→buttonUp→leave sequence passes', () => {
    const events: PointerEvent[] = [
      makePointer(PointerEventType.Enter),
      makePointer(PointerEventType.Move),
      makePointer(PointerEventType.ButtonDown, 100, 200, PointerButton.Left, 1),
      makePointer(PointerEventType.ButtonUp, 100, 200, PointerButton.Left, 0),
      makePointer(PointerEventType.Leave),
    ];
    expect(validatePointerOrder(events)).toBe(true);
  });

  it('invalid sequence leave→move is rejected', () => {
    const events: PointerEvent[] = [
      makePointer(PointerEventType.Leave),
      makePointer(PointerEventType.Move),
    ];
    expect(validatePointerOrder(events)).toBe(false);
  });

  it('router rejects invalid transition and returns error', () => {
    const deps = createMockRouterDeps();
    const router = createInputRouter(deps);

    // Valid enter
    const r1 = router.forwardPointer(makePointer(PointerEventType.Enter));
    expect(r1.success).toBe(true);

    // Invalid: leave cannot go directly to move
    router.forwardPointer(makePointer(PointerEventType.Leave));
    const r2 = router.forwardPointer(makePointer(PointerEventType.Move));
    expect(r2.success).toBe(false);
    expect(r2.error).toContain('Invalid pointer transition');
  });
});

// ────────────────────────────────────────────────────────────────────
// 2. Click Targets — Coordinate Error (Req 10.1)
// ────────────────────────────────────────────────────────────────────

describe('Click target coordinate fidelity', () => {
  it('forwarded pointer coordinates reach controller within 1px', () => {
    const deps = createMockRouterDeps();
    const router = createInputRouter(deps);

    router.forwardPointer(makePointer(PointerEventType.Enter, 500, 300));
    router.forwardPointer(makePointer(PointerEventType.Move, 501, 301));

    // All forwarded events have exact coordinates (router does not modify)
    const forwarded = deps.calls.pointer as PointerEvent[];
    expect(forwarded.length).toBe(2);
    expect(validateCoordinateError({ x: 500, y: 300 }, { x: forwarded[0].clientX, y: forwarded[0].clientY })).toBe(true);
    expect(validateCoordinateError({ x: 501, y: 301 }, { x: forwarded[1].clientX, y: forwarded[1].clientY })).toBe(true);
  });

  it('negative coordinates (virtual desktop) are forwarded correctly', () => {
    const deps = createMockRouterDeps();
    const router = createInputRouter(deps);

    router.forwardPointer(makePointer(PointerEventType.Enter, -100, -50));
    const forwarded = deps.calls.pointer as PointerEvent[];
    expect(forwarded[0].clientX).toBe(-100);
    expect(forwarded[0].clientY).toBe(-50);
  });
});

// ────────────────────────────────────────────────────────────────────
// 3. Keyboard and IME Routing (Req 10.5)
// ────────────────────────────────────────────────────────────────────

describe('Keyboard and IME routing', () => {
  it('all key categories route through WindowsMessageRouting', () => {
    const keyCategories: [number, ModifierState, KeyCategory][] = [
      [0x41, NO_MODIFIERS, KeyCategory.Printable],       // 'A'
      [0x10, NO_MODIFIERS, KeyCategory.Modifier],        // Shift
      [0x25, NO_MODIFIERS, KeyCategory.Navigation],      // Left arrow
      [0x2E, NO_MODIFIERS, KeyCategory.Editing],         // Delete
      [0x43, { ctrl: true, alt: false, shift: false, win: false }, KeyCategory.Accelerator], // Ctrl+C
    ];

    for (const [vk, mods, expected] of keyCategories) {
      expect(classifyKey(vk, mods)).toBe(expected);
      const event = makeKb(KeyboardEventType.KeyDown, vk, mods);
      expect(getKeyboardRoutingMethod(event)).toBe(InputRoutingMethod.WindowsMessageRouting);
    }
  });

  it('IME events route through WindowsMessageRouting (not synthetic injection)', () => {
    const imeEvents = [
      makeIme(ImeEventType.CompositionStart),
      makeIme(ImeEventType.CompositionUpdate),
      makeIme(ImeEventType.CompositionEnd),
    ];
    for (const evt of imeEvents) {
      expect(getImeRoutingMethod(evt)).toBe(InputRoutingMethod.WindowsMessageRouting);
    }
  });

  it('keyboard and IME events are forwarded through the router', () => {
    const deps = createMockRouterDeps();
    const router = createInputRouter(deps);

    const kbResult = router.routeKeyboard(makeKb(KeyboardEventType.KeyDown, 0x41));
    expect(kbResult.success).toBe(true);
    expect(kbResult.method).toBe(InputRoutingMethod.WindowsMessageRouting);

    const imeResult = router.routeIme(makeIme(ImeEventType.CompositionUpdate));
    expect(imeResult.success).toBe(true);
    expect(imeResult.method).toBe(InputRoutingMethod.WindowsMessageRouting);

    expect(deps.calls.kb.length).toBe(1);
    expect(deps.calls.ime.length).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// 4. Both Wheel Axes (Req 10.3)
// ────────────────────────────────────────────────────────────────────

describe('Wheel axes — vertical and horizontal', () => {
  it('vertical wheel delta (positive scroll up) is forwarded exactly', () => {
    const deps = createMockRouterDeps();
    const router = createInputRouter(deps);

    const result = router.forwardWheel(makeWheel(0, 120));
    expect(result.success).toBe(true);
    const forwarded = deps.calls.wheel as WheelEvent[];
    expect(forwarded[0].deltaY).toBe(120);
    expect(forwarded[0].deltaX).toBe(0);
    expect(validateWheelDelta(120, forwarded[0].deltaY)).toBe(true);
  });

  it('horizontal wheel delta (negative scroll left) is forwarded exactly', () => {
    const deps = createMockRouterDeps();
    const router = createInputRouter(deps);

    router.forwardWheel(makeWheel(-240, 0));
    const forwarded = deps.calls.wheel as WheelEvent[];
    expect(forwarded[0].deltaX).toBe(-240);
    expect(validateWheelDelta(-240, forwarded[0].deltaX)).toBe(true);
  });

  it('combined horizontal + vertical wheel event preserves both axes', () => {
    const deps = createMockRouterDeps();
    const router = createInputRouter(deps);

    router.forwardWheel(makeWheel(-120, 360));
    const forwarded = deps.calls.wheel as WheelEvent[];
    expect(forwarded[0].deltaX).toBe(-120);
    expect(forwarded[0].deltaY).toBe(360);
  });

  it('decodeWheelDeltaFromWParam handles both positive and negative', () => {
    // Positive: 120 in HIWORD
    expect(decodeWheelDeltaFromWParam(120 << 16)).toBe(120);
    // Negative: -120 in HIWORD
    expect(decodeWheelDeltaFromWParam((-120 & 0xffff) << 16)).toBe(-120);
  });
});

// ────────────────────────────────────────────────────────────────────
// 5. Focus Transfer (Req 10.4)
// ────────────────────────────────────────────────────────────────────

describe('Focus transfer', () => {
  it('all focus directions route via ControllerMoveFocus', () => {
    for (const dir of [FocusDirection.Next, FocusDirection.Previous, FocusDirection.Programmatic]) {
      const event = makeFocus(dir);
      expect(getFocusRoutingMethod(event)).toBe(InputRoutingMethod.ControllerMoveFocus);
    }
  });

  it('focus transfer calls controller.MoveFocus via router', () => {
    const deps = createMockRouterDeps();
    const router = createInputRouter(deps);

    const result = router.transferFocus(makeFocus(FocusDirection.Next));
    expect(result.success).toBe(true);
    expect(result.method).toBe(InputRoutingMethod.ControllerMoveFocus);
    expect(deps.calls.focus).toEqual([FocusDirection.Next]);
  });
});

// ────────────────────────────────────────────────────────────────────
// 6. Overlap Precedence (Req 10.9–10.11)
// ────────────────────────────────────────────────────────────────────

describe('Hit-test overlap precedence', () => {
  const dpi = 96;

  it('drag wins over click-through and interactive at the same point', () => {
    const rect: DipRect = { x: 0, y: 0, width: 200, height: 200 };
    const map: RegionMap = {
      revision: 1,
      dragRegions: [rect],
      interactiveRegions: [rect],
      clickThroughRegions: [rect],
    };
    const result = hitTest({ x: 100, y: 100 }, dpi, map);
    expect(result.code).toBe(NCHITTEST.HTCAPTION);
  });

  it('click-through wins over interactive when no drag present', () => {
    const rect: DipRect = { x: 0, y: 0, width: 200, height: 200 };
    const map: RegionMap = {
      revision: 1,
      dragRegions: [],
      interactiveRegions: [rect],
      clickThroughRegions: [rect],
    };
    const result = hitTest({ x: 100, y: 100 }, dpi, map);
    expect(result.code).toBe(NCHITTEST.HTTRANSPARENT);
  });
});

// ────────────────────────────────────────────────────────────────────
// 7. Cancelled Drags and Capture Release (Req 10.13–10.14)
// ────────────────────────────────────────────────────────────────────

describe('Cancelled drags and capture release', () => {
  it('drag start followed by drag end releases capture exactly once', () => {
    const deps = createCacheDeps();
    const cache = new RegionMapCache(deps);

    cache.onDragStart();
    expect(cache.isDragging()).toBe(true);

    cache.onDragEnd({ x: 100, y: 100, width: 400, height: 300 }, 96);
    expect(deps.captures).toBe(1);
    expect(cache.isDragging()).toBe(false);
  });

  it('cancelled drag (dragEnd without movement) still releases capture', () => {
    const deps = createCacheDeps();
    const cache = new RegionMapCache(deps);

    cache.onDragStart();
    // Immediate end (user pressed Escape or clicked without moving)
    cache.onDragEnd({ x: 50, y: 50, width: 400, height: 300 }, 96);
    expect(deps.captures).toBe(1);
    expect(deps.bounds.length).toBe(1);
  });

  it('multiple dragEnd calls without dragStart are no-ops', () => {
    const deps = createCacheDeps();
    const cache = new RegionMapCache(deps);

    cache.onDragEnd({ x: 100, y: 100, width: 400, height: 300 }, 96);
    cache.onDragEnd({ x: 200, y: 200, width: 400, height: 300 }, 96);
    expect(deps.captures).toBe(0);
    expect(deps.bounds.length).toBe(0);
  });

  it('reports final DIP bounds to App Core after drag completes', () => {
    const deps = createCacheDeps();
    const cache = new RegionMapCache(deps);

    cache.onDragStart();
    // At 200% DPI (192), physical (200, 400, 800, 600) → DIP (100, 200, 400, 300)
    cache.onDragEnd({ x: 200, y: 400, width: 800, height: 600 }, 192);
    expect(deps.bounds[0]).toEqual({ x: 100, y: 200, width: 400, height: 300 });
  });
});

// ────────────────────────────────────────────────────────────────────
// 8. Negative Coordinates (Req 11.5)
// ────────────────────────────────────────────────────────────────────

describe('Negative virtual-desktop coordinates', () => {
  it('negative DIP coordinates convert to negative physical', () => {
    const rect: DipRectEdges = { left: -1920, top: -1080, width: 800, height: 600 };
    for (const scale of REQUIRED_SCALES) {
      const dpi = scale * BASE_DPI;
      const physical = dipEdgesToPhysical(rect, dpi);
      expect(physical.left).toBeLessThan(0);
      expect(physical.top).toBeLessThan(0);
    }
  });

  it('negative physical coordinates convert to negative DIP', () => {
    const rect: PhysicalRect = { left: -2400, top: -1350, width: 1000, height: 750 };
    for (const scale of REQUIRED_SCALES) {
      const dpi = scale * BASE_DPI;
      const dip = physicalEdgesToDip(rect, dpi);
      expect(dip.left).toBeLessThan(0);
      expect(dip.top).toBeLessThan(0);
    }
  });

  it('lParam decoding handles negative coordinates', () => {
    // Pack (-500, -300) into lParam
    const x = -500;
    const y = -300;
    const lParam = ((y & 0xffff) << 16) | (x & 0xffff);
    const decoded = decodeClientCoordinates(lParam);
    expect(decoded.x).toBe(-500);
    expect(decoded.y).toBe(-300);
  });
});

// ────────────────────────────────────────────────────────────────────
// 9. Monitor Crossing, Removal, Rotation, Work-Area Changes (Req 11.9–11.11)
// ────────────────────────────────────────────────────────────────────

describe('Monitor topology changes', () => {
  const primary: MonitorInfo = {
    workArea: { left: 0, top: 0, width: 1920, height: 1080 },
    scaleFactor: 1.0,
    isPrimary: true,
  };
  const secondary: MonitorInfo = {
    workArea: { left: 1920, top: 0, width: 2560, height: 1440 },
    scaleFactor: 1.5,
    isPrimary: false,
  };

  it('window on removed monitor gets recentered to primary', () => {
    // Window was on secondary monitor which got removed
    const bounds: PhysicalRect = { left: 2200, top: 300, width: 800, height: 600 };
    const result = validateTopology(bounds, [primary]);
    expect(result.reachable).toBe(false);
    expect(result.degradation).toBeNull();
    // Recentered on primary
    expect(result.bounds.left).toBe(Math.round((1920 - 800) / 2));
    expect(result.bounds.top).toBe(Math.round((1080 - 600) / 2));
  });

  it('window crossing onto secondary remains reachable', () => {
    // Window partially on both monitors
    const bounds: PhysicalRect = { left: 1800, top: 200, width: 400, height: 300 };
    const result = validateTopology(bounds, [primary, secondary]);
    expect(result.reachable).toBe(true);
    expect(result.bounds).toEqual(bounds);
  });

  it('monitor rotation (work area change) with reachable window is unchanged', () => {
    // Simulate rotated primary (portrait): 1080 wide, 1920 tall
    const rotated: MonitorInfo = {
      workArea: { left: 0, top: 0, width: 1080, height: 1920 },
      scaleFactor: 1.0,
      isPrimary: true,
    };
    const bounds: PhysicalRect = { left: 100, top: 100, width: 400, height: 300 };
    const result = validateTopology(bounds, [rotated]);
    expect(result.reachable).toBe(true);
  });

  it('no monitors returns typed degradation', () => {
    const bounds: PhysicalRect = { left: 100, top: 100, width: 400, height: 300 };
    const result = validateTopology(bounds, []);
    expect(result.degradation).toBe(TopologyDegradation.NO_MONITORS);
    expect(result.bounds).toEqual(bounds); // retains current
  });

  it('work-area shrink makes previously reachable window unreachable → recenter', () => {
    // Window at (1800, 900) with taskbar eating into work area
    const shrunk: MonitorInfo = {
      workArea: { left: 0, top: 0, width: 1920, height: 800 }, // taskbar took 280px
      scaleFactor: 1.0,
      isPrimary: true,
    };
    const bounds: PhysicalRect = { left: 100, top: 850, width: 400, height: 300 };
    const result = validateTopology(bounds, [shrunk]);
    // top=850, bottom=1150, work area bottom=800 → no overlap → unreachable
    expect(result.reachable).toBe(false);
    expect(result.bounds.width).toBe(400);
    expect(result.bounds.height).toBe(300);
  });
});

// ────────────────────────────────────────────────────────────────────
// 10. All Required Scales (Req 11.6)
// ────────────────────────────────────────────────────────────────────

describe('All required DPI scales', () => {
  const testRect: DipRectEdges = { left: 50, top: 100, width: 400, height: 300 };

  for (const scale of REQUIRED_SCALES) {
    const dpi = scale * BASE_DPI;

    it(`scale ${scale} (${dpi} DPI) — edge rounding matches design`, () => {
      const physical = dipEdgesToPhysical(testRect, dpi);
      expect(physical.left).toBe(Math.round(testRect.left * scale));
      expect(physical.top).toBe(Math.round(testRect.top * scale));
      const expectedRight = Math.round((testRect.left + testRect.width) * scale);
      const expectedBottom = Math.round((testRect.top + testRect.height) * scale);
      expect(physical.width).toBe(expectedRight - physical.left);
      expect(physical.height).toBe(expectedBottom - physical.top);
    });

    it(`scale ${scale} — round trip within 1px per edge`, () => {
      const physical = dipEdgesToPhysical(testRect, dpi);
      const roundTrip = physicalEdgesToDip(physical, dpi);
      const rtPhysical = dipEdgesToPhysical(roundTrip, dpi);

      expect(Math.abs(physical.left - rtPhysical.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(physical.top - rtPhysical.top)).toBeLessThanOrEqual(1);
      expect(Math.abs(
        (physical.left + physical.width) - (rtPhysical.left + rtPhysical.width),
      )).toBeLessThanOrEqual(1);
      expect(Math.abs(
        (physical.top + physical.height) - (rtPhysical.top + rtPhysical.height),
      )).toBeLessThanOrEqual(1);
    });
  }
});

// ────────────────────────────────────────────────────────────────────
// 11. Layer 0 Geometry Parity (Req 11.12)
// ────────────────────────────────────────────────────────────────────

describe('Layer 0 geometry parity', () => {
  const operations: GeometryTarget['operation'][] = [
    'move', 'resize', 'nudge', 'recenter', 'snap',
    'maximize', 'restore', 'show', 'hide', 'toggle',
  ];
  const targetDip: DipRectEdges = { left: 7, top: 13, width: 51, height: 37 };

  for (const op of operations) {
    for (const scale of REQUIRED_SCALES) {
      const dpi = scale * BASE_DPI;

      it(`${op} at ${scale}x matches Layer 0 within 1px per edge`, () => {
        const target: GeometryTarget = { operation: op, targetDip };
        const result = operationToPhysical(target, dpi);

        // Layer 0 would compute the same edge-rounded result
        const layer0 = dipEdgesToPhysical(targetDip, dpi);
        expect(edgesMatchWithinTolerance(result, layer0)).toBe(true);
      });
    }
  }

  it('edgesMatchWithinTolerance rejects 2px+ error', () => {
    const a: PhysicalRect = { left: 100, top: 200, width: 400, height: 300 };
    const b: PhysicalRect = { left: 102, top: 200, width: 400, height: 300 };
    expect(edgesMatchWithinTolerance(a, b)).toBe(false);
  });

  it('MAX_EDGE_ERROR_PX is 1', () => {
    expect(MAX_EDGE_ERROR_PX).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// 12. DPI Change (WM_DPICHANGED) — Req 11.7–11.8
// ────────────────────────────────────────────────────────────────────

describe('DPI change recommended bounds', () => {
  it('applies OS-recommended rect for each scale transition', () => {
    const transitions: [number, number][] = [
      [96, 120], [96, 144], [96, 192], [120, 168],
      [144, 96], [192, 96], [192, 288],
    ];

    for (const [prevDpi, newDpi] of transitions) {
      const recommended: PhysicalRect = { left: 50, top: 75, width: 800, height: 600 };
      const context: DpiChangeContext = { newDpi, recommendedRect: recommended, previousDpi: prevDpi };
      const result = applyDpiChange(context);

      expect(result.bounds).toEqual(recommended);
      expect(result.rasterScale).toBe(newDpi / BASE_DPI);
      expect(result.dpi).toBe(newDpi);
    }
  });

  it('negative recommended rect coordinates are preserved', () => {
    const context: DpiChangeContext = {
      newDpi: 192,
      recommendedRect: { left: -300, top: -150, width: 600, height: 400 },
      previousDpi: 96,
    };
    const result = applyDpiChange(context);
    expect(result.bounds.left).toBe(-300);
    expect(result.bounds.top).toBe(-150);
  });
});
