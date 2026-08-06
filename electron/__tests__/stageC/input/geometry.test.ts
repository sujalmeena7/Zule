/**
 * Stage C Geometry — Unit Tests
 *
 * Verifies:
 *   - Edge rounding matches design pseudocode exactly (Req 11.3)
 *   - Round-trip conversion error ≤1 pixel per edge for standard DPI scales (Req 11.6)
 *   - Negative coordinates stay signed (Req 11.5)
 *   - Unreachable bounds recenter on primary; reachable bounds unmodified (Req 11.9–11.11)
 *   - DPI change applies recommended bounds (Req 11.7, 11.8)
 *   - Geometry operations produce physical edges within 1px of Layer 0 (Req 11.12)
 *
 * Requirements: 11.1–11.13
 */

import { describe, it, expect } from 'vitest';
import {
  dipEdgesToPhysical,
  physicalEdgesToDip,
  applyDpiChange,
  validateTopology,
  operationToPhysical,
  edgesMatchWithinTolerance,
  TopologyDegradation,
  BASE_DPI,
  MAX_EDGE_ERROR_PX,
  type PhysicalRect,
  type DipRectEdges,
  type MonitorInfo,
  type DpiChangeContext,
  type GeometryTarget,
} from '../../../stageC/input/geometry';

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeDipRect(left: number, top: number, width: number, height: number): DipRectEdges {
  return { left, top, width, height };
}

function makePhysicalRect(left: number, top: number, width: number, height: number): PhysicalRect {
  return { left, top, width, height };
}

function makeMonitor(
  left: number, top: number, width: number, height: number,
  scaleFactor: number, isPrimary: boolean,
): MonitorInfo {
  return {
    workArea: makePhysicalRect(left, top, width, height),
    scaleFactor,
    isPrimary,
  };
}

/** Standard DPI scales per Req 11.6 */
const STANDARD_SCALES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3];

// ─────────────────────────────────────────────────────────────────────────────
// 1. Edge Rounding Matches Design Pseudocode (Req 11.3)
// ─────────────────────────────────────────────────────────────────────────────

describe('Edge-rounded DIP→physical conversion (Req 11.3)', () => {
  it('at 96 DPI (scale 1) is identity', () => {
    const rect = makeDipRect(10, 20, 100, 50);
    const result = dipEdgesToPhysical(rect, 96);
    expect(result.left).toBe(10);
    expect(result.top).toBe(20);
    expect(result.width).toBe(100);
    expect(result.height).toBe(50);
  });

  it('at 192 DPI (scale 2) doubles all edges', () => {
    const rect = makeDipRect(10, 20, 100, 50);
    const result = dipEdgesToPhysical(rect, 192);
    expect(result.left).toBe(20);
    expect(result.top).toBe(40);
    expect(result.width).toBe(200);
    expect(result.height).toBe(100);
  });

  it('at 120 DPI (scale 1.25) rounds edges independently', () => {
    // Design pseudocode example:
    // rect = (1, 1, 3, 3) → right=4, bottom=4
    // scale = 1.25
    // left = round(1 * 1.25) = round(1.25) = 1
    // top = round(1 * 1.25) = 1
    // right = round(4 * 1.25) = round(5.0) = 5
    // bottom = round(4 * 1.25) = 5
    // width = 5 - 1 = 4, height = 5 - 1 = 4
    const rect = makeDipRect(1, 1, 3, 3);
    const result = dipEdgesToPhysical(rect, 120);
    expect(result.left).toBe(1);
    expect(result.top).toBe(1);
    expect(result.width).toBe(4);
    expect(result.height).toBe(4);
  });

  it('at 144 DPI (scale 1.5) handles fractional edges', () => {
    // rect = (3, 5, 7, 9) → right=10, bottom=14
    // scale = 1.5
    // left = round(3 * 1.5) = round(4.5) = 4 (rounds to even → 4)
    // top = round(5 * 1.5) = round(7.5) = 8 (rounds to even → 8)
    // right = round(10 * 1.5) = round(15) = 15
    // bottom = round(14 * 1.5) = round(21) = 21
    const rect = makeDipRect(3, 5, 7, 9);
    const result = dipEdgesToPhysical(rect, 144);
    expect(result.left).toBe(Math.round(3 * 1.5));
    expect(result.top).toBe(Math.round(5 * 1.5));
    expect(result.width).toBe(Math.round(10 * 1.5) - Math.round(3 * 1.5));
    expect(result.height).toBe(Math.round(14 * 1.5) - Math.round(5 * 1.5));
  });

  it('at 288 DPI (scale 3) triples edges exactly', () => {
    const rect = makeDipRect(5, 10, 20, 15);
    const result = dipEdgesToPhysical(rect, 288);
    expect(result.left).toBe(15);
    expect(result.top).toBe(30);
    expect(result.width).toBe(60);
    expect(result.height).toBe(45);
  });

  it('width derives from right - left (not rounded width independently)', () => {
    // This tests the critical design decision: round edges, not width
    // rect = (1, 0, 1, 1) at 1.5x (144 DPI)
    // left = round(1 * 1.5) = round(1.5) = 2
    // right = round(2 * 1.5) = round(3) = 3
    // width = 3 - 2 = 1
    // vs. rounding width directly: round(1 * 1.5) = round(1.5) = 2 (WRONG)
    const rect = makeDipRect(1, 0, 1, 1);
    const result = dipEdgesToPhysical(rect, 144);
    expect(result.width).toBe(Math.round(2 * 1.5) - Math.round(1 * 1.5));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Physical → DIP Inverse Conversion (Req 11.4)
// ─────────────────────────────────────────────────────────────────────────────

describe('Physical→DIP edge conversion (Req 11.4)', () => {
  it('at 96 DPI is identity', () => {
    const rect = makePhysicalRect(10, 20, 100, 50);
    const result = physicalEdgesToDip(rect, 96);
    expect(result.left).toBe(10);
    expect(result.top).toBe(20);
    expect(result.width).toBe(100);
    expect(result.height).toBe(50);
  });

  it('at 192 DPI halves edges', () => {
    const rect = makePhysicalRect(20, 40, 200, 100);
    const result = physicalEdgesToDip(rect, 192);
    expect(result.left).toBe(10);
    expect(result.top).toBe(20);
    expect(result.width).toBe(100);
    expect(result.height).toBe(50);
  });

  it('at 144 DPI (scale 1.5) divides by 1.5', () => {
    const rect = makePhysicalRect(15, 30, 60, 45);
    const result = physicalEdgesToDip(rect, 144);
    expect(result.left).toBe(10);
    expect(result.top).toBe(20);
    expect(result.width).toBe(40);
    expect(result.height).toBe(30);
  });

  it('preserves negative coordinates (Req 11.5)', () => {
    const rect = makePhysicalRect(-200, -100, 400, 300);
    const result = physicalEdgesToDip(rect, 192);
    expect(result.left).toBe(-100);
    expect(result.top).toBe(-50);
    expect(result.width).toBe(200);
    expect(result.height).toBe(150);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Round-Trip Conversion Error ≤1 Pixel Per Edge (Req 11.6)
// ─────────────────────────────────────────────────────────────────────────────

describe('Round-trip DIP→physical→DIP error ≤1px per edge (Req 11.6)', () => {
  // Test with representative DIP rectangles across all standard DPI scales
  const testRects: DipRectEdges[] = [
    makeDipRect(0, 0, 100, 50),
    makeDipRect(10, 20, 300, 200),
    makeDipRect(-500, -300, 800, 600),
    makeDipRect(1, 1, 3, 3),
    makeDipRect(7, 13, 51, 37),
    makeDipRect(-1920, -1080, 1920, 1080),
    makeDipRect(0, 0, 1, 1),
  ];

  for (const scale of STANDARD_SCALES) {
    const dpi = scale * BASE_DPI;

    describe(`at scale ${scale} (${dpi} DPI)`, () => {
      for (const dipRect of testRects) {
        it(`rect (${dipRect.left},${dipRect.top},${dipRect.width},${dipRect.height}) round-trips within 1px`, () => {
          // DIP → Physical
          const physical = dipEdgesToPhysical(dipRect, dpi);

          // Physical → DIP (inverse)
          const roundTrip = physicalEdgesToDip(physical, dpi);

          // Convert both to physical to compare edges in physical pixels
          const originalPhysical = dipEdgesToPhysical(dipRect, dpi);
          const roundTripPhysical = dipEdgesToPhysical(roundTrip, dpi);

          // Each physical edge must be within 1px
          expect(Math.abs(originalPhysical.left - roundTripPhysical.left)).toBeLessThanOrEqual(1);
          expect(Math.abs(originalPhysical.top - roundTripPhysical.top)).toBeLessThanOrEqual(1);
          expect(Math.abs(
            (originalPhysical.left + originalPhysical.width) -
            (roundTripPhysical.left + roundTripPhysical.width)
          )).toBeLessThanOrEqual(1);
          expect(Math.abs(
            (originalPhysical.top + originalPhysical.height) -
            (roundTripPhysical.top + roundTripPhysical.height)
          )).toBeLessThanOrEqual(1);
        });
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Negative Coordinates Stay Signed (Req 11.5)
// ─────────────────────────────────────────────────────────────────────────────

describe('Negative virtual-desktop coordinates stay signed (Req 11.5)', () => {
  it('dipEdgesToPhysical preserves negative left/top', () => {
    const rect = makeDipRect(-100, -50, 200, 100);
    const result = dipEdgesToPhysical(rect, 192);
    expect(result.left).toBe(-200);
    expect(result.top).toBe(-100);
  });

  it('physicalEdgesToDip preserves negative left/top', () => {
    const rect = makePhysicalRect(-300, -150, 600, 300);
    const result = physicalEdgesToDip(rect, 144);
    expect(result.left).toBe(-200);
    expect(result.top).toBe(-100);
  });

  it('dipEdgesToPhysical with large negative coordinates at 1.25x', () => {
    const rect = makeDipRect(-1920, -1080, 1920, 1080);
    const dpi = 1.25 * BASE_DPI;
    const result = dipEdgesToPhysical(rect, dpi);
    expect(result.left).toBe(Math.round(-1920 * 1.25));
    expect(result.top).toBe(Math.round(-1080 * 1.25));
    expect(result.left).toBeLessThan(0);
    expect(result.top).toBeLessThan(0);
  });

  it('physicalEdgesToDip with negative at fractional DPI stays negative', () => {
    const rect = makePhysicalRect(-2400, -1350, 2400, 1350);
    const dpi = 1.25 * BASE_DPI;
    const result = physicalEdgesToDip(rect, dpi);
    expect(result.left).toBeLessThan(0);
    expect(result.top).toBeLessThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Monitor Topology Validation (Req 11.9–11.11)
// ─────────────────────────────────────────────────────────────────────────────

describe('Monitor topology validation (Req 11.9–11.11)', () => {
  const primaryMonitor = makeMonitor(0, 0, 1920, 1080, 1.0, true);
  const secondaryMonitor = makeMonitor(1920, 0, 2560, 1440, 1.5, false);

  describe('reachable bounds are unmodified (Req 11.9)', () => {
    it('bounds fully within primary are reachable', () => {
      const bounds = makePhysicalRect(100, 100, 400, 300);
      const result = validateTopology(bounds, [primaryMonitor]);
      expect(result.reachable).toBe(true);
      expect(result.bounds).toEqual(bounds);
      expect(result.degradation).toBeNull();
    });

    it('bounds partially overlapping are reachable', () => {
      const bounds = makePhysicalRect(-50, -50, 400, 300);
      const result = validateTopology(bounds, [primaryMonitor]);
      expect(result.reachable).toBe(true);
      expect(result.bounds).toEqual(bounds);
    });

    it('bounds on secondary monitor are reachable', () => {
      const bounds = makePhysicalRect(2000, 200, 400, 300);
      const result = validateTopology(bounds, [primaryMonitor, secondaryMonitor]);
      expect(result.reachable).toBe(true);
      expect(result.bounds).toEqual(bounds);
    });

    it('single pixel overlap counts as reachable', () => {
      // Bounds just barely overlapping primary (1px overlap on right/bottom)
      const bounds = makePhysicalRect(1919, 1079, 400, 300);
      const result = validateTopology(bounds, [primaryMonitor]);
      expect(result.reachable).toBe(true);
    });
  });

  describe('unreachable bounds recenter on primary (Req 11.10)', () => {
    it('bounds completely off-screen recenter', () => {
      const bounds = makePhysicalRect(5000, 5000, 400, 300);
      const result = validateTopology(bounds, [primaryMonitor]);
      expect(result.reachable).toBe(false);
      expect(result.degradation).toBeNull();
      // Should be centered: left = 0 + (1920-400)/2 = 760, top = 0 + (1080-300)/2 = 390
      expect(result.bounds.left).toBe(760);
      expect(result.bounds.top).toBe(390);
      expect(result.bounds.width).toBe(400);
      expect(result.bounds.height).toBe(300);
    });

    it('bounds below all monitors recenter', () => {
      const bounds = makePhysicalRect(100, 2000, 400, 300);
      const result = validateTopology(bounds, [primaryMonitor]);
      expect(result.reachable).toBe(false);
      expect(result.bounds.left).toBe(760);
      expect(result.bounds.top).toBe(390);
    });

    it('recentering preserves original dimensions', () => {
      const bounds = makePhysicalRect(-5000, -5000, 800, 600);
      const result = validateTopology(bounds, [primaryMonitor]);
      expect(result.bounds.width).toBe(800);
      expect(result.bounds.height).toBe(600);
    });

    it('uses first monitor when no primary is flagged', () => {
      const nonPrimary1 = makeMonitor(0, 0, 1920, 1080, 1.0, false);
      const nonPrimary2 = makeMonitor(1920, 0, 1920, 1080, 1.0, false);
      const bounds = makePhysicalRect(9999, 9999, 400, 300);
      const result = validateTopology(bounds, [nonPrimary1, nonPrimary2]);
      // Should recenter on first monitor (nonPrimary1)
      expect(result.bounds.left).toBe(760);
      expect(result.bounds.top).toBe(390);
    });
  });

  describe('typed degradation when recovery impossible (Req 11.11)', () => {
    it('no monitors returns NO_MONITORS degradation', () => {
      const bounds = makePhysicalRect(100, 100, 400, 300);
      const result = validateTopology(bounds, []);
      expect(result.reachable).toBe(false);
      expect(result.bounds).toEqual(bounds);
      expect(result.degradation).toBe(TopologyDegradation.NO_MONITORS);
    });

    it('zero-width primary work area returns INVALID_PRIMARY_WORK_AREA', () => {
      const zeroWidthMonitor = makeMonitor(0, 0, 0, 1080, 1.0, true);
      const bounds = makePhysicalRect(5000, 5000, 400, 300);
      const result = validateTopology(bounds, [zeroWidthMonitor]);
      expect(result.reachable).toBe(false);
      expect(result.bounds).toEqual(bounds);
      expect(result.degradation).toBe(TopologyDegradation.INVALID_PRIMARY_WORK_AREA);
    });

    it('zero-height primary work area returns INVALID_PRIMARY_WORK_AREA', () => {
      const zeroHeightMonitor = makeMonitor(0, 0, 1920, 0, 1.0, true);
      const bounds = makePhysicalRect(5000, 5000, 400, 300);
      const result = validateTopology(bounds, [zeroHeightMonitor]);
      expect(result.reachable).toBe(false);
      expect(result.bounds).toEqual(bounds);
      expect(result.degradation).toBe(TopologyDegradation.INVALID_PRIMARY_WORK_AREA);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. DPI Change Applies Recommended Bounds (Req 11.7, 11.8)
// ─────────────────────────────────────────────────────────────────────────────

describe('DPI change applies recommended bounds (Req 11.7, 11.8)', () => {
  it('uses OS-recommended rectangle directly', () => {
    const context: DpiChangeContext = {
      newDpi: 192,
      recommendedRect: makePhysicalRect(100, 200, 800, 600),
      previousDpi: 96,
    };
    const result = applyDpiChange(context);
    expect(result.bounds).toEqual(makePhysicalRect(100, 200, 800, 600));
  });

  it('returns correct raster scale for new DPI', () => {
    const context: DpiChangeContext = {
      newDpi: 144,
      recommendedRect: makePhysicalRect(0, 0, 600, 450),
      previousDpi: 96,
    };
    const result = applyDpiChange(context);
    expect(result.rasterScale).toBe(1.5);
    expect(result.dpi).toBe(144);
  });

  it('handles DPI decrease (e.g. moved to lower-DPI monitor)', () => {
    const context: DpiChangeContext = {
      newDpi: 96,
      recommendedRect: makePhysicalRect(50, 50, 400, 300),
      previousDpi: 192,
    };
    const result = applyDpiChange(context);
    expect(result.rasterScale).toBe(1.0);
    expect(result.bounds).toEqual(makePhysicalRect(50, 50, 400, 300));
  });

  it('handles scale factor 2.5 (240 DPI)', () => {
    const context: DpiChangeContext = {
      newDpi: 240,
      recommendedRect: makePhysicalRect(200, 100, 1000, 750),
      previousDpi: 96,
    };
    const result = applyDpiChange(context);
    expect(result.rasterScale).toBe(2.5);
    expect(result.dpi).toBe(240);
  });

  it('preserves negative coordinates in recommended rect', () => {
    const context: DpiChangeContext = {
      newDpi: 192,
      recommendedRect: makePhysicalRect(-100, -50, 400, 300),
      previousDpi: 96,
    };
    const result = applyDpiChange(context);
    expect(result.bounds.left).toBe(-100);
    expect(result.bounds.top).toBe(-50);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Geometry Operations Match Layer 0 Within 1px (Req 11.12)
// ─────────────────────────────────────────────────────────────────────────────

describe('Geometry operations match Layer 0 within 1px (Req 11.12)', () => {
  const operations: GeometryTarget['operation'][] = [
    'move', 'resize', 'nudge', 'recenter', 'snap',
    'maximize', 'restore', 'show', 'hide', 'toggle',
  ];

  for (const op of operations) {
    it(`${op} uses edge-rounded conversion`, () => {
      const target: GeometryTarget = {
        operation: op,
        targetDip: makeDipRect(50, 100, 400, 300),
      };
      const result = operationToPhysical(target, 144); // 1.5x scale
      const expected = dipEdgesToPhysical(target.targetDip, 144);
      expect(result).toEqual(expected);
    });
  }

  it('operationToPhysical matches Layer 0 edge-rounded result at 1.75x', () => {
    const target: GeometryTarget = {
      operation: 'resize',
      targetDip: makeDipRect(7, 13, 51, 37),
    };
    const dpi = 1.75 * BASE_DPI; // 168 DPI
    const result = operationToPhysical(target, dpi);

    // Manually verify edge rounding per design:
    const scale = 1.75;
    const expectedLeft = Math.round(7 * scale);
    const expectedTop = Math.round(13 * scale);
    const expectedRight = Math.round((7 + 51) * scale);
    const expectedBottom = Math.round((13 + 37) * scale);

    expect(result.left).toBe(expectedLeft);
    expect(result.top).toBe(expectedTop);
    expect(result.width).toBe(expectedRight - expectedLeft);
    expect(result.height).toBe(expectedBottom - expectedTop);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Edge Match Tolerance Validation (Req 11.12)
// ─────────────────────────────────────────────────────────────────────────────

describe('edgesMatchWithinTolerance (Req 11.12)', () => {
  it('identical rects match', () => {
    const a = makePhysicalRect(100, 200, 400, 300);
    expect(edgesMatchWithinTolerance(a, a)).toBe(true);
  });

  it('1px difference on each edge still matches', () => {
    const a = makePhysicalRect(100, 200, 400, 300);
    const b = makePhysicalRect(101, 201, 400, 300);
    expect(edgesMatchWithinTolerance(a, b)).toBe(true);
  });

  it('2px difference on left edge does not match', () => {
    const a = makePhysicalRect(100, 200, 400, 300);
    const b = makePhysicalRect(102, 200, 400, 300);
    expect(edgesMatchWithinTolerance(a, b)).toBe(false);
  });

  it('1px difference on right edge (via width) still matches', () => {
    const a = makePhysicalRect(100, 200, 400, 300);
    const b = makePhysicalRect(100, 200, 401, 300);
    expect(edgesMatchWithinTolerance(a, b)).toBe(true);
  });

  it('2px difference on bottom edge does not match', () => {
    const a = makePhysicalRect(100, 200, 400, 300);
    const b = makePhysicalRect(100, 200, 400, 302);
    expect(edgesMatchWithinTolerance(a, b)).toBe(false);
  });

  it('MAX_EDGE_ERROR_PX is 1', () => {
    expect(MAX_EDGE_ERROR_PX).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Constants
// ─────────────────────────────────────────────────────────────────────────────

describe('Constants', () => {
  it('BASE_DPI is 96', () => {
    expect(BASE_DPI).toBe(96);
  });
});
