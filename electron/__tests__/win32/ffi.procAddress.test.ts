// Regression coverage for native DLL export resolution.
// **Validates: Requirements 9.1, 10.4**

import { describe, expect, it, vi } from 'vitest';
import {
  resolveProcAddress,
  type HwndPtr,
  type Kernel32Bindings,
} from '../../win32/ffi';

function fakeKernel32(moduleHandle: HwndPtr, proc: HwndPtr): Kernel32Bindings {
  return {
    GetModuleHandleW: vi.fn(() => moduleHandle),
    GetProcAddress: vi.fn(() => proc),
    GetLastError: vi.fn(() => 0),
  };
}

describe('resolveProcAddress', () => {
  it('resolves the ANSI export name through the loaded user32 module', () => {
    const moduleHandle = 0x7ffb00000000n;
    const proc = 0x7ffb12345678n;
    const kernel32 = fakeKernel32(moduleHandle, proc);

    expect(resolveProcAddress(kernel32, 'user32.dll', 'DefWindowProcW')).toBe(proc);
    expect(kernel32.GetModuleHandleW).toHaveBeenCalledWith('user32.dll');
    expect(kernel32.GetProcAddress).toHaveBeenCalledWith(moduleHandle, 'DefWindowProcW');
  });

  it('returns null without looking up an export when the module is unavailable', () => {
    const kernel32 = fakeKernel32(0n, 0x1234n);

    expect(resolveProcAddress(kernel32, 'user32.dll', 'DefWindowProcW')).toBeNull();
    expect(kernel32.GetProcAddress).not.toHaveBeenCalled();
  });

  it('returns null for a missing export, empty symbol, or loader exception', () => {
    const missing = fakeKernel32(0x1000n, 0n);
    expect(resolveProcAddress(missing, 'user32.dll', 'DefWindowProcW')).toBeNull();
    expect(resolveProcAddress(missing, 'user32.dll', '')).toBeNull();

    const throwing = fakeKernel32(0x1000n, 0x2000n);
    vi.mocked(throwing.GetModuleHandleW).mockImplementation(() => { throw new Error('loader'); });
    expect(resolveProcAddress(throwing, 'user32.dll', 'DefWindowProcW')).toBeNull();
  });
});