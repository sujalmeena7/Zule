// ============================================
// Zule AI — DPI Conversion Round Trip Property Test
// ============================================
//
// Feature: stealth-window-host
// Property 13: DPI conversion round trip
//
// Generate signed rectangles and scales 1, 1.25, 1.5, 1.75, 2, 2.5, and 3;
// assert monotonic independent-edge conversion and at most one-physical-pixel
// round-trip error.
//
// **Validates: Requirements 11.3–11.6**

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  dipEdgesToPhysical,
  physicalEdgesToDip,
  BASE_DPI,
  type DipRectEdges,
} from '../../../stageC/input/geometry';

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

/** Required DPI scales per design */
const REQUIRED_SCALES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;

// ────────────────────────────────────────────────────────────────────
// Generators
// ────────────────────────────────────────────────────────────────────

/** Generate a signed integer coordinate in virtual-desktop range */
const arbSignedCoord = fc.integer({ min: -8192, max: 8192 });

/** Generate a positive dimension (1..4096) */
const arbDimension = fc.integer({ min: 1, max: 4096 });

/** Generate one of the required DPI scales */
const arbScale = fc.constantFrom(...REQUIRED_SCALES);

/** Generate a signed DIP rectangle */
const arbDipRect: fc.Arbitrary<DipRectEdges> = fc.record({
  left: arbSignedCoord,
  top: arbSignedCoord,
  width: arbDimension,
  height: arbDimension,
});

// ────────────────────────────────────────────────────────────────────
// Property Tests
// ────────────────────────────────────────────────────────────────────

describe('Property 13: DPI conversion round trip', () => {
  it('round-trip error is at most one physical pixel per edge', () => {
    fc.assert(
      fc.property(arbDipRect, arbScale, (rect, scale) => {
        const dpi = scale * BASE_DPI;

        // DIP → Physical
        const physical = dipEdgesToPhysical(rect, dpi);

        // Physical → DIP (inverse)
        const roundTrip = physicalEdgesToDip(physical, dpi);

        // DIP (round-tripped) → Physical again to compare in physical space
        const roundTripPhysical = dipEdgesToPhysical(roundTrip, dpi);

        // Each edge must match within 1 physical pixel
        const leftError = Math.abs(physical.left - roundTripPhysical.left);
        const topError = Math.abs(physical.top - roundTripPhysical.top);
        const rightError = Math.abs(
          (physical.left + physical.width) -
          (roundTripPhysical.left + roundTripPhysical.width),
        );
        const bottomError = Math.abs(
          (physical.top + physical.height) -
          (roundTripPhysical.top + roundTripPhysical.height),
        );

        expect(leftError).toBeLessThanOrEqual(1);
        expect(topError).toBeLessThanOrEqual(1);
        expect(rightError).toBeLessThanOrEqual(1);
        expect(bottomError).toBeLessThanOrEqual(1);
      }),
      { numRuns: 500 },
    );
  });

  it('edge conversion is monotonic: increasing DIP left → non-decreasing physical left', () => {
    fc.assert(
      fc.property(arbScale, arbDimension, arbSignedCoord, (scale, width, top) => {
        const dpi = scale * BASE_DPI;

        // Generate two left values where left2 > left1
        const left1 = 0;
        const left2 = left1 + 1;

        const phys1 = dipEdgesToPhysical({ left: left1, top, width, height: width }, dpi);
        const phys2 = dipEdgesToPhysical({ left: left2, top, width, height: width }, dpi);

        // Monotonicity: left2 > left1 → physical left2 >= physical left1
        expect(phys2.left).toBeGreaterThanOrEqual(phys1.left);
      }),
      { numRuns: 200 },
    );
  });

  it('edge conversion is monotonic: increasing DIP top → non-decreasing physical top', () => {
    fc.assert(
      fc.property(arbScale, arbDimension, arbSignedCoord, (scale, height, left) => {
        const dpi = scale * BASE_DPI;

        const top1 = 0;
        const top2 = top1 + 1;

        const phys1 = dipEdgesToPhysical({ left, top: top1, width: height, height }, dpi);
        const phys2 = dipEdgesToPhysical({ left, top: top2, width: height, height }, dpi);

        expect(phys2.top).toBeGreaterThanOrEqual(phys1.top);
      }),
      { numRuns: 200 },
    );
  });

  it('right edge is monotonic with increasing width', () => {
    fc.assert(
      fc.property(
        arbScale,
        arbSignedCoord,
        arbSignedCoord,
        fc.integer({ min: 1, max: 2048 }),
        (scale, left, top, baseWidth) => {
          const dpi = scale * BASE_DPI;

          const width1 = baseWidth;
          const width2 = baseWidth + 1;

          const phys1 = dipEdgesToPhysical({ left, top, width: width1, height: 100 }, dpi);
          const phys2 = dipEdgesToPhysical({ left, top, width: width2, height: 100 }, dpi);

          const right1 = phys1.left + phys1.width;
          const right2 = phys2.left + phys2.width;

          // Increasing width → non-decreasing right edge
          expect(right2).toBeGreaterThanOrEqual(right1);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('bottom edge is monotonic with increasing height', () => {
    fc.assert(
      fc.property(
        arbScale,
        arbSignedCoord,
        arbSignedCoord,
        fc.integer({ min: 1, max: 2048 }),
        (scale, left, top, baseHeight) => {
          const dpi = scale * BASE_DPI;

          const height1 = baseHeight;
          const height2 = baseHeight + 1;

          const phys1 = dipEdgesToPhysical({ left, top, width: 100, height: height1 }, dpi);
          const phys2 = dipEdgesToPhysical({ left, top, width: 100, height: height2 }, dpi);

          const bottom1 = phys1.top + phys1.height;
          const bottom2 = phys2.top + phys2.height;

          // Increasing height → non-decreasing bottom edge
          expect(bottom2).toBeGreaterThanOrEqual(bottom1);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('independent edge rounding: width depends only on left and right DIP edges', () => {
    fc.assert(
      fc.property(arbDipRect, arbScale, (rect, scale) => {
        const dpi = scale * BASE_DPI;
        const physical = dipEdgesToPhysical(rect, dpi);

        // Manually compute expected per design pseudocode
        const expectedLeft = Math.round(rect.left * scale);
        const expectedRight = Math.round((rect.left + rect.width) * scale);
        const expectedTop = Math.round(rect.top * scale);
        const expectedBottom = Math.round((rect.top + rect.height) * scale);

        expect(physical.left).toBe(expectedLeft);
        expect(physical.top).toBe(expectedTop);
        expect(physical.width).toBe(expectedRight - expectedLeft);
        expect(physical.height).toBe(expectedBottom - expectedTop);
      }),
      { numRuns: 500 },
    );
  });

  it('negative coordinates remain signed after conversion', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -8192, max: -1 }),
        fc.integer({ min: -8192, max: -1 }),
        arbDimension,
        arbDimension,
        arbScale,
        (left, top, width, height, scale) => {
          const dpi = scale * BASE_DPI;
          const physical = dipEdgesToPhysical({ left, top, width, height }, dpi);

          // Negative DIP left → negative physical left (since scale ≥ 1 and left < 0)
          expect(physical.left).toBeLessThan(0);
          expect(physical.top).toBeLessThan(0);

          // Inverse also preserves sign
          const dip = physicalEdgesToDip(physical, dpi);
          expect(dip.left).toBeLessThan(0);
          expect(dip.top).toBeLessThan(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});
