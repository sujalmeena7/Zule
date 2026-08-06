// Stage A regression: Electron handle Buffers must never reach koffi calls.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../nativeStealth', () => ({
  applyNativeStealth: () => ({ ok: true, layers: [] }),
}));

import { createReparenter } from '../../win32/reparent';
import type { Win32Ffi } from '../../win32/ffi';

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;

describe('Stage A HWND normalization', () => {
  it('decodes the Electron child Buffer once and preserves the raw host pointer', () => {
    const hostHwnd = 0x123456789abcdef0n;
    const childHwnd = 0xfedcba9876543210n;
    const childBuffer = Buffer.alloc(8);
    childBuffer.writeBigUInt64LE(childHwnd);
    let childStyle = WS_POPUP;

    const calls: Array<{ name: string; handles: unknown[] }> = [];
    const record = (name: string, ...handles: unknown[]) => calls.push({ name, handles });
    const ffi = {
      user32: {
        GetWindowLongPtrW: (hwnd: unknown, index: number) => {
          record('GetWindowLongPtrW', hwnd);
          return index === GWL_STYLE ? childStyle : index === GWL_EXSTYLE ? 8 : 0;
        },
        SetWindowLongPtrW: (hwnd: unknown, index: number, value: number) => {
          record('SetWindowLongPtrW', hwnd);
          if (index === GWL_STYLE) childStyle = value;
          return 0;
        },
        GetWindowRect: (hwnd: unknown) => (record('GetWindowRect', hwnd), true),
        GetClientRect: (hwnd: unknown) => (record('GetClientRect', hwnd), true),
        SetParent: (child: unknown, host: unknown) => (record('SetParent', child, host), null),
        GetParent: (hwnd: unknown) => (record('GetParent', hwnd), hostHwnd),
        SetWindowPos: (hwnd: unknown) => (record('SetWindowPos', hwnd), true),
      },
      alloc: (_type: string, value: unknown) => value,
      decode: () => ({ left: 0, top: 0, right: 640, bottom: 480 }),
    } as unknown as Win32Ffi;

    const result = createReparenter(ffi).adopt(hostHwnd, childBuffer);

    expect(result.success).toBe(true);
    expect(result.state.hostHwnd).toBe(hostHwnd);
    expect(result.state.childHwnd).toBe(childHwnd);
    expect(childStyle & WS_CHILD).toBe(WS_CHILD);
    expect(calls.find((call) => call.name === 'SetParent')?.handles).toEqual([childHwnd, hostHwnd]);
    expect(calls.flatMap((call) => call.handles).some(Buffer.isBuffer)).toBe(false);
  });
});