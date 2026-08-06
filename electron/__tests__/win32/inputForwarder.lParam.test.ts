// ============================================
// Property 13: lParam decoding sign-correctness
// ============================================
//
// ∀ signed 16-bit pairs (x, y): decodeMouseLParam(pack(x, y)) = { x, y };
// negative coordinates decode negative, never ≥ 32768.
//
// **Validates: Requirements 8.2**

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import { decodeMouseLParam } from '../../win32/inputForwarder';

// ── Pack helper (Win32 MAKELPARAM) ───────────────────────────────────────────

/**
 * Pack two signed 16-bit values into a single 32-bit lParam.
 * Standard Win32 MAKELPARAM: ((y & 0xFFFF) << 16) | (x & 0xFFFF)
 */
function pack(x: number, y: number): number {
  return ((y & 0xFFFF) << 16) | (x & 0xFFFF);
}

// ── Arbitraries ──────────────────────────────────────────────────────────────

/** Signed 16-bit integer: [-32768, 32767] */
const arbInt16 = fc.integer({ min: -32768, max: 32767 });

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Property 13: lParam decoding sign-correctness', () => {
  it('∀ signed 16-bit pairs (x, y): decodeMouseLParam(pack(x, y)) = { x, y }', () => {
    fc.assert(
      fc.property(arbInt16, arbInt16, (x, y) => {
        const lParam = pack(x, y);
        const decoded = decodeMouseLParam(lParam);

        return decoded.x === x && decoded.y === y;
      }),
      { numRuns: 10000 },
    );
  });

  it('∀ negative x: decoded x is negative, never ≥ 32768', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -32768, max: -1 }),
        arbInt16,
        (x, y) => {
          const lParam = pack(x, y);
          const decoded = decodeMouseLParam(lParam);

          return decoded.x < 0 && decoded.x < 32768;
        },
      ),
      { numRuns: 5000 },
    );
  });

  it('∀ negative y: decoded y is negative, never ≥ 32768', () => {
    fc.assert(
      fc.property(
        arbInt16,
        fc.integer({ min: -32768, max: -1 }),
        (x, y) => {
          const lParam = pack(x, y);
          const decoded = decodeMouseLParam(lParam);

          return decoded.y < 0 && decoded.y < 32768;
        },
      ),
      { numRuns: 5000 },
    );
  });

  it('∀ signed 16-bit pairs: all decoded values are within [-32768, 32767]', () => {
    fc.assert(
      fc.property(arbInt16, arbInt16, (x, y) => {
        const lParam = pack(x, y);
        const decoded = decodeMouseLParam(lParam);

        return (
          decoded.x >= -32768 && decoded.x <= 32767 &&
          decoded.y >= -32768 && decoded.y <= 32767
        );
      }),
      { numRuns: 10000 },
    );
  });
});
