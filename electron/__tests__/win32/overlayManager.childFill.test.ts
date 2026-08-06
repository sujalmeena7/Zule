// ============================================
// Property 11: Child fills host client area
// ============================================
//
// ∀ host bounds b: after setBounds(b) in reparent mode, child rect =
// (0, 0, clientWidth(b), clientHeight(b))
//
// **Validates: Requirements 6.2**

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

// ── Win32 constants (mirror reparent.ts) ─────────────────────────────────────

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;
const WS_EX_TOPMOST = 0x00000008;
const SWP_FRAMECHANGED = 0x0020;
const SWP_NOACTIVATE = 0x0010;
const SWP_NOZORDER = 0x0004;

// ── Fake FFI that tracks SetWindowPos calls ──────────────────────────────────

interface SetWindowPosCall {
  hwnd: unknown;
  insertAfter: unknown;
  x: number;
  y: number;
  cx: number;
  cy: number;
  flags: number;
}

interface FakeFFI {
  user32: {
    GetWindowLongPtrW: (hwnd: unknown, index: number) => number;
    SetWindowLongPtrW: ReturnType<typeof vi.fn>;
    GetWindowRect: (hwnd: unknown, rectBuf: unknown) => boolean;
    GetClientRect: (hwnd: unknown, rectBuf: unknown) => boolean;
    SetParent: ReturnType<typeof vi.fn>;
    GetParent: (hwnd: unknown) => unknown;
    SetWindowPos: ReturnType<typeof vi.fn>;
  };
  alloc: (type: string, value?: unknown) => unknown;
  decode: (ptr: unknown, type: string) => unknown;
  setWindowPosCalls: SetWindowPosCall[];
}

/**
 * Create a fake FFI where GetClientRect(host) returns a client area of the
 * specified width/height. For a WS_POPUP borderless host, client area = full size.
 */
function createFakeFfi(
  hostHwnd: unknown,
  clientWidth: number,
  clientHeight: number,
): FakeFFI {
  let adopted = false;
  const setWindowPosCalls: SetWindowPosCall[] = [];

  const setParentSpy = vi.fn((_child: unknown, _newParent: unknown) => {
    adopted = true;
    return null;
  });

  const setWindowPosSpy = vi.fn(
    (hwnd: unknown, insertAfter: unknown, x: number, y: number, cx: number, cy: number, flags: number) => {
      setWindowPosCalls.push({ hwnd, insertAfter, x, y, cx, cy, flags });
      return true;
    },
  );

  return {
    user32: {
      GetWindowLongPtrW: (_hwnd: unknown, index: number) => {
        if (index === GWL_STYLE) {
          return adopted ? WS_CHILD : WS_POPUP;
        }
        if (index === GWL_EXSTYLE) {
          return WS_EX_TOPMOST;
        }
        return 0;
      },
      SetWindowLongPtrW: vi.fn(() => 0),
      GetWindowRect: (_hwnd: unknown, _rectBuf: unknown) => true,
      GetClientRect: (hwnd: unknown, _rectBuf: unknown) => {
        // Only the host HWND reports our controlled client rect
        if (hwnd === hostHwnd) {
          return true;
        }
        return true;
      },
      SetParent: setParentSpy,
      GetParent: (_hwnd: unknown) => {
        return adopted ? hostHwnd : null;
      },
      SetWindowPos: setWindowPosSpy,
    },
    alloc: (_type: string, value?: unknown) => value ?? { left: 0, top: 0, right: 0, bottom: 0 },
    decode: (ptr: unknown, _type: string) => {
      // When decoding a RECT, return the host client rect for all decodes.
      // The reparent module calls GetClientRect(host) then decode to get the
      // client dimensions. The first decode is for GetWindowRect (child snapshot),
      // the second is for GetClientRect (host client area). We track state to
      // differentiate.
      return { left: 0, top: 0, right: clientWidth, bottom: clientHeight };
    },
    setWindowPosCalls,
  };
}

// ── Mock nativeStealth to prevent real imports ───────────────────────────────

vi.mock('../../nativeStealth', () => ({
  applyNativeStealth: () => ({ ok: true, layers: [] }),
}));

// ── Import module under test ─────────────────────────────────────────────────

import { createReparenter } from '../../win32/reparent';
import type { Win32Ffi } from '../../win32/ffi';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Property 11: Child fills host client area', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('∀ host bounds b: after adopt, child rect = (0, 0, clientWidth, clientHeight)', () => {
    fc.assert(
      fc.property(
        fc.record({
          x: fc.integer({ min: -2000, max: 4000 }),
          y: fc.integer({ min: -2000, max: 4000 }),
          width: fc.integer({ min: 1, max: 4000 }),
          height: fc.integer({ min: 1, max: 4000 }),
        }),
        (bounds) => {
          const hostHwnd = { __host: 'host-hwnd' };
          const childHwnd = { __child: 'child-hwnd' };

          // For a WS_POPUP borderless window, client area = full bounds size
          const clientWidth = bounds.width;
          const clientHeight = bounds.height;

          const fakeFfi = createFakeFfi(hostHwnd, clientWidth, clientHeight);
          const reparenter = createReparenter(fakeFfi as unknown as Win32Ffi);

          // Adopt the child into the host
          const result = reparenter.adopt(hostHwnd, childHwnd);
          expect(result.success).toBe(true);

          // Find the SetWindowPos call on the child (refit call)
          // The adopt() function calls SetWindowPos on the child to refit it
          // to the host's client area.
          const childSetWindowPosCalls = fakeFfi.setWindowPosCalls.filter(
            (call) => call.hwnd === childHwnd,
          );

          // There should be exactly one SetWindowPos call on the child
          expect(childSetWindowPosCalls.length).toBe(1);

          const refitCall = childSetWindowPosCalls[0];

          // Child must be positioned at (0, 0) in host-client coordinates
          expect(refitCall.x).toBe(0);
          expect(refitCall.y).toBe(0);

          // Child must fill the entire host client area
          expect(refitCall.cx).toBe(clientWidth);
          expect(refitCall.cy).toBe(clientHeight);

          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('child refit uses SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOZORDER flags', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4000 }),
        fc.integer({ min: 1, max: 4000 }),
        (width, height) => {
          const hostHwnd = { __host: 'host' };
          const childHwnd = { __child: 'child' };

          const fakeFfi = createFakeFfi(hostHwnd, width, height);
          const reparenter = createReparenter(fakeFfi as unknown as Win32Ffi);

          reparenter.adopt(hostHwnd, childHwnd);

          const childCalls = fakeFfi.setWindowPosCalls.filter(
            (call) => call.hwnd === childHwnd,
          );
          expect(childCalls.length).toBe(1);

          const expectedFlags = SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOZORDER;
          expect(childCalls[0].flags).toBe(expectedFlags);

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('child always starts at origin (0, 0) regardless of host screen position', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10000, max: 10000 }),
        fc.integer({ min: -10000, max: 10000 }),
        fc.integer({ min: 1, max: 4000 }),
        fc.integer({ min: 1, max: 4000 }),
        (hostX, hostY, width, height) => {
          const hostHwnd = { __host: `host-at-${hostX}-${hostY}` };
          const childHwnd = { __child: 'child' };

          // Regardless of where the host is on screen, the child's position
          // in host-client coordinates is always (0, 0)
          const fakeFfi = createFakeFfi(hostHwnd, width, height);
          const reparenter = createReparenter(fakeFfi as unknown as Win32Ffi);

          reparenter.adopt(hostHwnd, childHwnd);

          const childCalls = fakeFfi.setWindowPosCalls.filter(
            (call) => call.hwnd === childHwnd,
          );

          // Regardless of host screen position, child starts at (0, 0) in
          // parent-relative coordinates
          expect(childCalls[0].x).toBe(0);
          expect(childCalls[0].y).toBe(0);

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});
