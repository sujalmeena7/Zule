// Regression coverage for native WNDPROC registration mode.
// **Validates: Requirements 9.1, 9.5, 9.7**

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Win32Ffi } from '../../win32/ffi';

const { getFfiMock } = vi.hoisted(() => ({ getFfiMock: vi.fn() }));

vi.mock('../../win32/ffi', () => ({
  getFfi: getFfiMock,
}));

import { registerWndProc } from '../../win32/wndProc';

const originalProcessType = Object.getOwnPropertyDescriptor(process, 'type');

function fakeFfi(nativePointer: unknown) {
  return {
    procAddress: vi.fn(() => nativePointer),
    registerCallback: vi.fn(() => 0x3000n),
    unregisterCallback: vi.fn(),
    user32: { DefWindowProcW: vi.fn(() => 0) },
  } as unknown as Win32Ffi;
}

describe('registerWndProc native mode', () => {
  beforeEach(() => {
    getFfiMock.mockReset();
    Object.defineProperty(process, 'type', { value: 'browser', configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalProcessType) {
      Object.defineProperty(process, 'type', originalProcessType);
    } else {
      delete (process as NodeJS.Process & { type?: string }).type;
    }
  });

  it('returns the native DefWindowProcW pointer without registering a JS callback', () => {
    const pointer = 0x7ffb12345678n;
    const ffi = fakeFfi(pointer);
    getFfiMock.mockReturnValue(ffi);

    const registered = registerWndProc('native');

    expect(registered?.pointer).toBe(pointer);
    expect(registered?.isNativeFallback).toBe(true);
    expect(ffi.procAddress).toHaveBeenCalledWith('user32.dll', 'DefWindowProcW');
    expect(ffi.registerCallback).not.toHaveBeenCalled();

    registered?.dispose();
    expect(ffi.unregisterCallback).not.toHaveBeenCalled();
  });

  it('fails closed when DefWindowProcW cannot be resolved', () => {
    const ffi = fakeFfi(null);
    getFfiMock.mockReturnValue(ffi);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(registerWndProc('native')).toBeNull();
    expect(ffi.registerCallback).not.toHaveBeenCalled();
    expect(ffi.unregisterCallback).not.toHaveBeenCalled();
  });

  it('keeps JS mode callback ownership separate and disposes it once', () => {
    const ffi = fakeFfi(0x2000n);
    getFfiMock.mockReturnValue(ffi);

    const registered = registerWndProc('js', { onMessage: () => null });

    expect(registered?.isNativeFallback).toBe(false);
    expect(ffi.procAddress).not.toHaveBeenCalled();
    expect(ffi.registerCallback).toHaveBeenCalledOnce();

    registered?.dispose();
    registered?.dispose();
    expect(ffi.unregisterCallback).toHaveBeenCalledOnce();
  });

  it('refuses all modes outside the Electron browser process', () => {
    const ffi = fakeFfi(0x2000n);
    getFfiMock.mockReturnValue(ffi);
    Object.defineProperty(process, 'type', { value: 'renderer', configurable: true });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(registerWndProc('native')).toBeNull();
    expect(getFfiMock).not.toHaveBeenCalled();
  });
});