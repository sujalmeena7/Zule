// ============================================
// Property 14: Wheel delta decoding
// ============================================
//
// ∀ signed 16-bit d: decodeWheelDelta(pack(d)) has same sign as d and magnitude |d|;
// d=0 maps to 0.
//
// **Validates: Requirements 8.2, 8.6**

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import { decodeWheelDelta } from '../../win32/inputForwarder';

// ── Pack helper (wheel delta in HIWORD of wParam) ────────────────────────────

/**
 * Pack a signed 16-bit wheel delta into the HIWORD of wParam.
 * Win32 convention: wheel delta is in bits [16..31] of wParam.
 */
function packWheelDelta(delta: number): number {
  return (delta & 0xFFFF) << 16;
}

// ── Arbitraries ──────────────────────────────────────────────────────────────

/** Signed 16-bit integer: [-32768, 32767] */
const arbInt16 = fc.integer({ min: -32768, max: 32767 });

/** Positive signed 16-bit integer: [1, 32767] */
const arbPositiveInt16 = fc.integer({ min: 1, max: 32767 });

/** Negative signed 16-bit integer: [-32768, -1] */
const arbNegativeInt16 = fc.integer({ min: -32768, max: -1 });

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Property 14: Wheel delta decoding', () => {
  it('∀ signed 16-bit d: decodeWheelDelta(pack(d)) has same sign as d and |decoded| = |d|', () => {
    fc.assert(
      fc.property(arbInt16, (d) => {
        const wParam = packWheelDelta(d);
        const decoded = decodeWheelDelta(wParam);

        if (d === 0) {
          return decoded === 0;
        }
        // Same sign
        const sameSign = (d > 0 && decoded > 0) || (d < 0 && decoded < 0);
        // Same magnitude
        const sameMagnitude = Math.abs(decoded) === Math.abs(d);
        return sameSign && sameMagnitude;
      }),
      { numRuns: 10000 },
    );
  });

  it('∀ d=0: decodeWheelDelta(pack(0)) is exactly 0', () => {
    const wParam = packWheelDelta(0);
    const decoded = decodeWheelDelta(wParam);
    expect(decoded).toBe(0);
  });

  it('∀ positive d: decoded is positive with correct magnitude', () => {
    fc.assert(
      fc.property(arbPositiveInt16, (d) => {
        const wParam = packWheelDelta(d);
        const decoded = decodeWheelDelta(wParam);

        return decoded > 0 && decoded === d;
      }),
      { numRuns: 5000 },
    );
  });

  it('∀ negative d: decoded is negative with correct magnitude', () => {
    fc.assert(
      fc.property(arbNegativeInt16, (d) => {
        const wParam = packWheelDelta(d);
        const decoded = decodeWheelDelta(wParam);

        return decoded < 0 && decoded === d;
      }),
      { numRuns: 5000 },
    );
  });

  it('∀ signed 16-bit d: decoded value is within [-32768, 32767]', () => {
    fc.assert(
      fc.property(arbInt16, (d) => {
        const wParam = packWheelDelta(d);
        const decoded = decodeWheelDelta(wParam);

        return decoded >= -32768 && decoded <= 32767;
      }),
      { numRuns: 10000 },
    );
  });

  it('∀ signed 16-bit d: pack preserves low bits (LOWORD) independently', () => {
    fc.assert(
      fc.property(
        arbInt16,
        fc.integer({ min: 0, max: 0xFFFF }),
        (d, loWord) => {
          // wParam can have arbitrary low bits (e.g. MK_LBUTTON flags)
          const wParam = packWheelDelta(d) | loWord;
          const decoded = decodeWheelDelta(wParam);

          // The low bits should NOT affect the decoded wheel delta
          return decoded === d;
        },
      ),
      { numRuns: 5000 },
    );
  });
});
