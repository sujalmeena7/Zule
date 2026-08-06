import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../win32/ffi', () => ({
  getFfi: vi.fn(),
  isWin32: vi.fn(() => true),
  normalizeHwnd: vi.fn((hwnd: unknown) => hwnd),
}));

import { getFfi } from '../../win32/ffi';
import { applyNativeStealth, removeNativeStealth } from '../../nativeStealth';

const DWMWA_DISALLOW_PEEK = 11;
const DWMWA_EXCLUDED_FROM_PEEK = 12;
const DWMWA_CLOAK = 13;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_NOACTIVATE = 0x08000000;
const WS_EX_APPWINDOW = 0x00040000;

function createFakeFfi() {
  const dwmSetWindowAttribute = vi.fn(() => 0);
  const ffi = {
    user32: {
      SetWindowDisplayAffinity: vi.fn(() => true),
      GetWindowDisplayAffinity: vi.fn(() => true),
      GetWindowLongPtrW: vi.fn(() => 0x00040000),
      SetWindowLongPtrW: vi.fn(() => 0),
    },
    dwmapi: { DwmSetWindowAttribute: dwmSetWindowAttribute },
    alloc: vi.fn((type: string, value: unknown) => ({ type, value })),
    decode: vi.fn((ptr: { value: unknown }) => ptr.value === 0 ? 0x00000011 : ptr.value),
  };
  return { ffi, dwmSetWindowAttribute };
}

function dwmBooleanCalls(mock: ReturnType<typeof vi.fn>): Array<[number, number]> {
  return mock.mock.calls.map(([, attr, valueBuf]) => [
    attr as number,
    (valueBuf as { value: number }).value,
  ]);
}

describe('native stealth window visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the target visible while enabling DWM preview exclusions', () => {
    const { ffi, dwmSetWindowAttribute } = createFakeFfi();
    vi.mocked(getFfi).mockReturnValue(ffi as never);

    const result = applyNativeStealth(Buffer.alloc(8));

    expect(result.ok).toBe(true);
    expect(dwmBooleanCalls(dwmSetWindowAttribute)).toEqual([
      [DWMWA_CLOAK, 0],
      [DWMWA_DISALLOW_PEEK, 1],
      [DWMWA_EXCLUDED_FROM_PEEK, 1],
    ]);
    expect(ffi.user32.SetWindowDisplayAffinity).toHaveBeenCalledWith(
      expect.anything(),
      0x00000011,
    );
  });

  it('preserves click activation for an interactive Layer 0 BrowserWindow', () => {
    const { ffi } = createFakeFfi();
    vi.mocked(getFfi).mockReturnValue(ffi as never);

    applyNativeStealth(Buffer.alloc(8), { allowActivation: true });

    const writtenStyle = ffi.user32.SetWindowLongPtrW.mock.calls[0]?.[2] as number;
    expect(writtenStyle & WS_EX_TOOLWINDOW).toBe(WS_EX_TOOLWINDOW);
    expect(writtenStyle & WS_EX_NOACTIVATE).toBe(0);
    expect(writtenStyle & WS_EX_APPWINDOW).toBe(0);
  });

  it('keeps NOACTIVATE on passive host windows', () => {
    const { ffi } = createFakeFfi();
    vi.mocked(getFfi).mockReturnValue(ffi as never);

    applyNativeStealth(Buffer.alloc(8));

    const writtenStyle = ffi.user32.SetWindowLongPtrW.mock.calls[0]?.[2] as number;
    expect(writtenStyle & WS_EX_NOACTIVATE).toBe(WS_EX_NOACTIVATE);
  });

  it('clears all DWM preview attributes when protection is disabled', () => {
    const { ffi, dwmSetWindowAttribute } = createFakeFfi();
    vi.mocked(getFfi).mockReturnValue(ffi as never);
    applyNativeStealth(Buffer.alloc(8));
    dwmSetWindowAttribute.mockClear();

    expect(removeNativeStealth(Buffer.alloc(8))).toBe(true);
    expect(dwmBooleanCalls(dwmSetWindowAttribute)).toEqual([
      [DWMWA_CLOAK, 0],
      [DWMWA_DISALLOW_PEEK, 0],
      [DWMWA_EXCLUDED_FROM_PEEK, 0],
    ]);
    expect(ffi.user32.SetWindowDisplayAffinity).toHaveBeenLastCalledWith(
      expect.anything(),
      0,
    );
  });
});