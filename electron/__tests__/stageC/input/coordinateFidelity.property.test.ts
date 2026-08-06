// ============================================
// Zule AI — Input Coordinate Fidelity Property Test
// ============================================
//
// Feature: stealth-window-host
// Property 15: Input coordinate fidelity
//
// Generate target rectangles, signed desktop coordinates, DPIs, and wheel
// deltas; assert target containment, at most one-pixel physical error,
// and exact wheel sign/magnitude.
//
// **Validates: Requirements 10.1–10.5, 11.5–11.6**

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  validateCoordinateError,
  validateWheelDelta,
  decodeWheelDeltaFromWParam,
  decodeClientCoordinates,
  MAX_COORDINATE_ERROR_PX,
} from '../../../stageC/input/inputRouter';
import {
  dipEdgesToPhysical,
  physicalEdgesToDip,
  BASE_DPI,
  type DipRectEdges,
} from '../../../stageC/input/geometry';

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

const REQUIRED_SCALES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;

/** Windows WHEEL_DELTA constant */
const WHEEL_DELTA = 120;

// ────────────────────────────────────────────────────────────────────
// Generators
// ────────────────────────────────────────────────────────────────────

/** Signed coordinate in signed 16-bit range (what Windows passes in lParam) */
const arbSigned16 = fc.integer({ min: -32768, max: 32767 });

/** Signed desktop coordinate in virtual desktop range */
const arbDesktopCoord = fc.integer({ min: -8192, max: 8192 });

/** Positive dimension */
const arbDimension = fc.integer({ min: 1, max: 4096 });

/** One of the required DPI scales */
const arbScale = fc.constantFrom(...REQUIRED_SCALES);

/** Generate a signed wheel delta (multiples of WHEEL_DELTA, or arbitrary signed values) */
const arbWheelDelta = fc.oneof(
  fc.integer({ min: -10, max: 10 }).map(n => n * WHEEL_DELTA),
  fc.integer({ min: -32768, max: 32767 }),
);

/** Generate a target DIP rectangle */
const arbTargetRect: fc.Arbitrary<DipRectEdges> = fc.record({
  left: arbDesktopCoord,
  top: arbDesktopCoord,
  width: arbDimension,
  height: arbDimension,
});

// ────────────────────────────────────────────────────────────────────
// Property Tests
// ────────────────────────────────────────────────────────────────────

describe('Property 15: Input coordinate fidelity', () => {
  describe('Coordinate containment and error bounds', () => {
    it('physical center of a DIP target rectangle converts back within 1px error', () => {
      fc.assert(
        fc.property(arbTargetRect, arbScale, (targetDip, scale) => {
          const dpi = scale * BASE_DPI;

          // Convert DIP target to physical
          const physical = dipEdgesToPhysical(targetDip, dpi);

          // Physical center
          const centerX = physical.left + Math.floor(physical.width / 2);
          const centerY = physical.top + Math.floor(physical.height / 2);

          // Convert physical center back to DIP for validation
          const dipPoint = {
            x: centerX / scale,
            y: centerY / scale,
          };

          // The DIP point should be within or very near the original DIP rect
          // (within 1/scale error from rounding)
          const dipRight = targetDip.left + targetDip.width;
          const dipBottom = targetDip.top + targetDip.height;

          // Allow 1 physical pixel worth of DIP error
          const tolerance = 1 / scale + 0.001; // small epsilon for FP
          expect(dipPoint.x).toBeGreaterThanOrEqual(targetDip.left - tolerance);
          expect(dipPoint.x).toBeLessThanOrEqual(dipRight + tolerance);
          expect(dipPoint.y).toBeGreaterThanOrEqual(targetDip.top - tolerance);
          expect(dipPoint.y).toBeLessThanOrEqual(dipBottom + tolerance);
        }),
        { numRuns: 500 },
      );
    });

    it('coordinate error validation accepts points within 1 physical pixel', () => {
      fc.assert(
        fc.property(
          arbDesktopCoord,
          arbDesktopCoord,
          fc.integer({ min: -1, max: 1 }),
          fc.integer({ min: -1, max: 1 }),
          (x, y, dx, dy) => {
            const intended = { x, y };
            const actual = { x: x + dx, y: y + dy };

            // Any offset within [-1, 1] should pass validation
            expect(validateCoordinateError(intended, actual)).toBe(true);
          },
        ),
        { numRuns: 300 },
      );
    });

    it('coordinate error validation rejects points beyond 1 physical pixel', () => {
      fc.assert(
        fc.property(
          arbDesktopCoord,
          arbDesktopCoord,
          fc.integer({ min: 2, max: 100 }),
          (x, y, offset) => {
            const intended = { x, y };
            // Offset of 2+ on either axis must fail
            const actual = { x: x + offset, y };
            expect(validateCoordinateError(intended, actual)).toBe(false);
          },
        ),
        { numRuns: 200 },
      );
    });

    it('MAX_COORDINATE_ERROR_PX is 1', () => {
      expect(MAX_COORDINATE_ERROR_PX).toBe(1);
    });
  });

  describe('Signed coordinate decoding from lParam', () => {
    it('decodes signed 16-bit coordinate pairs exactly from lParam', () => {
      fc.assert(
        fc.property(arbSigned16, arbSigned16, (x, y) => {
          // Pack into lParam: x in low word, y in high word (both signed 16-bit)
          const lParam = ((y & 0xffff) << 16) | (x & 0xffff);

          const decoded = decodeClientCoordinates(lParam);

          expect(decoded.x).toBe(x);
          expect(decoded.y).toBe(y);
        }),
        { numRuns: 500 },
      );
    });

    it('negative coordinates decode as negative (never >= 32768)', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: -32768, max: -1 }),
          fc.integer({ min: -32768, max: -1 }),
          (x, y) => {
            const lParam = ((y & 0xffff) << 16) | (x & 0xffff);
            const decoded = decodeClientCoordinates(lParam);

            expect(decoded.x).toBeLessThan(0);
            expect(decoded.y).toBeLessThan(0);
            expect(decoded.x).toBeGreaterThanOrEqual(-32768);
            expect(decoded.y).toBeGreaterThanOrEqual(-32768);
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  describe('Wheel delta fidelity', () => {
    it('wheel delta preserves exact sign and magnitude', () => {
      fc.assert(
        fc.property(arbWheelDelta, (delta) => {
          // Validate that intended == actual passes
          expect(validateWheelDelta(delta, delta)).toBe(true);

          // Any different value fails
          if (delta !== 0) {
            expect(validateWheelDelta(delta, delta + 1)).toBe(false);
            expect(validateWheelDelta(delta, -delta)).toBe(false);
          }
        }),
        { numRuns: 300 },
      );
    });

    it('decodeWheelDeltaFromWParam preserves sign and magnitude', () => {
      fc.assert(
        fc.property(fc.integer({ min: -32768, max: 32767 }), (delta) => {
          // Pack delta into HIWORD of wParam
          const wParam = (delta & 0xffff) << 16;
          const decoded = decodeWheelDeltaFromWParam(wParam);

          expect(decoded).toBe(delta);

          // Sign preservation
          if (delta > 0) expect(decoded).toBeGreaterThan(0);
          if (delta < 0) expect(decoded).toBeLessThan(0);
          if (delta === 0) expect(decoded).toBe(0);
        }),
        { numRuns: 300 },
      );
    });

    it('wheel delta zero maps to zero', () => {
      const wParam = 0;
      expect(decodeWheelDeltaFromWParam(wParam)).toBe(0);
      expect(validateWheelDelta(0, 0)).toBe(true);
    });
  });

  describe('Signed coordinate preservation through DPI conversion (Req 11.5–11.6)', () => {
    it('negative desktop coordinates stay signed through DIP→physical→DIP round trip', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: -8192, max: -1 }),
          fc.integer({ min: -8192, max: -1 }),
          arbDimension,
          arbDimension,
          arbScale,
          (left, top, width, height, scale) => {
            const dpi = scale * BASE_DPI;
            const rect: DipRectEdges = { left, top, width, height };

            // DIP → Physical
            const physical = dipEdgesToPhysical(rect, dpi);
            expect(physical.left).toBeLessThan(0);
            expect(physical.top).toBeLessThan(0);

            // Physical → DIP
            const roundTrip = physicalEdgesToDip(physical, dpi);
            expect(roundTrip.left).toBeLessThan(0);
            expect(roundTrip.top).toBeLessThan(0);

            // Round-trip error at most 1 physical pixel equivalent in DIP
            const dipTolerance = 1 / scale + 0.001;
            expect(Math.abs(roundTrip.left - rect.left)).toBeLessThanOrEqual(dipTolerance);
            expect(Math.abs(roundTrip.top - rect.top)).toBeLessThanOrEqual(dipTolerance);
          },
        ),
        { numRuns: 300 },
      );
    });
  });
});
