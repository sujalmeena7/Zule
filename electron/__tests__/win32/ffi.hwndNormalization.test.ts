// Regression coverage for Electron HWND Buffer -> koffi pointer conversion.
import { describe, expect, it } from 'vitest';
import { normalizeHwnd } from '../../win32/ffi';

describe('normalizeHwnd', () => {
  it('decodes a 64-bit little-endian handle without Number precision loss', () => {
    const expected = 0xfedcba9876543210n;
    const handle = Buffer.alloc(8);
    handle.writeBigUInt64LE(expected);

    expect(normalizeHwnd(handle)).toBe(expected);
  });

  it('decodes a 32-bit little-endian handle as BigInt', () => {
    const handle = Buffer.alloc(4);
    handle.writeUInt32LE(0xfedcba98);

    expect(normalizeHwnd(handle)).toBe(0xfedcba98n);
  });

  it('is idempotent and leaves raw koffi pointers unchanged', () => {
    const rawPointer = 0x123456789abcdef0n;
    const opaquePointer = { koffi: 'pointer' };
    const handle = Buffer.alloc(8);
    handle.writeBigUInt64LE(rawPointer);

    expect(normalizeHwnd(normalizeHwnd(handle))).toBe(rawPointer);
    expect(normalizeHwnd(rawPointer)).toBe(rawPointer);
    expect(normalizeHwnd(opaquePointer)).toBe(opaquePointer);
  });

  it('rejects malformed buffers instead of passing their storage address', () => {
    expect(() => normalizeHwnd(Buffer.alloc(0))).toThrow(RangeError);
    expect(() => normalizeHwnd(Buffer.alloc(6))).toThrow(/expected 4 or 8 bytes/);
  });
});