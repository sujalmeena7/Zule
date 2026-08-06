// ============================================
// Zule AI — Hit-Test Precedence and Safe Defaults Property Test
// ============================================
//
// Feature: stealth-window-host
// Property 14: Hit-test precedence and safe default
//
// Generate points and valid/stale/malformed/missing region maps; assert
// drag yields HTCAPTION, click-through without drag yields HTTRANSPARENT,
// and all other cases yield HTCLIENT.
//
// **Validates: Requirements 10.6–10.12**

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  NCHITTEST,
  hitTest,
  validateRegionMap,
  RegionMapCache,
  MAX_REGIONS_PER_TYPE,
  type DipRect,
  type RegionMap,
  type RegionCacheDeps,
} from '../../../stageC/input/hitTest';

// ────────────────────────────────────────────────────────────────────
// Generators
// ────────────────────────────────────────────────────────────────────

/** Generate a valid DIP rectangle with positive dimensions */
const arbDipRect: fc.Arbitrary<DipRect> = fc.record({
  x: fc.integer({ min: -2000, max: 2000 }),
  y: fc.integer({ min: -2000, max: 2000 }),
  width: fc.integer({ min: 1, max: 500 }),
  height: fc.integer({ min: 1, max: 500 }),
});

/** Generate a point that is guaranteed inside a given DIP rect (at 96 DPI) */
function arbPointInRect(rect: DipRect): fc.Arbitrary<{ x: number; y: number }> {
  return fc.record({
    x: fc.integer({ min: rect.x, max: rect.x + rect.width - 1 }),
    y: fc.integer({ min: rect.y, max: rect.y + rect.height - 1 }),
  });
}

/** Generate a physical point */
const arbPoint = fc.record({
  x: fc.integer({ min: -4000, max: 4000 }),
  y: fc.integer({ min: -4000, max: 4000 }),
});

/** Generate a small list of valid DIP rects (1..8) */
const arbRectList = fc.array(arbDipRect, { minLength: 1, maxLength: 8 });

/** Generate a valid region map with specified regions */
function arbValidRegionMap(overrides?: {
  dragRegions?: fc.Arbitrary<DipRect[]>;
  clickThroughRegions?: fc.Arbitrary<DipRect[]>;
  interactiveRegions?: fc.Arbitrary<DipRect[]>;
}): fc.Arbitrary<RegionMap> {
  return fc.record({
    revision: fc.integer({ min: 0, max: 10000 }),
    dragRegions: overrides?.dragRegions ?? fc.constant([]),
    interactiveRegions: overrides?.interactiveRegions ?? fc.constant([]),
    clickThroughRegions: overrides?.clickThroughRegions ?? fc.constant([]),
  });
}

/** Generate a malformed region map (bad revision, NaN coords, etc.) */
const arbMalformedRegionMap: fc.Arbitrary<RegionMap> = fc.oneof(
  // Negative revision
  fc.record({
    revision: fc.integer({ min: -1000, max: -1 }),
    dragRegions: fc.constant([]),
    interactiveRegions: fc.constant([]),
    clickThroughRegions: fc.constant([]),
  }),
  // NaN in rect
  fc.record({
    revision: fc.nat(),
    dragRegions: fc.constant([{ x: NaN, y: 0, width: 100, height: 100 }]),
    interactiveRegions: fc.constant([]),
    clickThroughRegions: fc.constant([]),
  }),
  // Zero-width rect
  fc.record({
    revision: fc.nat(),
    dragRegions: fc.constant([]),
    interactiveRegions: fc.constant([]),
    clickThroughRegions: fc.constant([{ x: 0, y: 0, width: 0, height: 50 }]),
  }),
  // Negative dimension
  fc.record({
    revision: fc.nat(),
    dragRegions: fc.constant([{ x: 10, y: 10, width: -5, height: 50 }]),
    interactiveRegions: fc.constant([]),
    clickThroughRegions: fc.constant([]),
  }),
  // Exceeds region count limit
  fc.record({
    revision: fc.nat(),
    dragRegions: fc.constant(
      Array.from({ length: MAX_REGIONS_PER_TYPE + 1 }, (_, i) => ({
        x: i, y: 0, width: 1, height: 1,
      })),
    ),
    interactiveRegions: fc.constant([]),
    clickThroughRegions: fc.constant([]),
  }),
);

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function createMockDeps(): RegionCacheDeps {
  return {
    reportFinalBounds: () => {},
    releaseCapture: () => {},
  };
}

// ────────────────────────────────────────────────────────────────────
// Property Tests
// ────────────────────────────────────────────────────────────────────

describe('Property 14: Hit-test precedence and safe default', () => {
  it('point in drag region always yields HTCAPTION regardless of other regions', () => {
    fc.assert(
      fc.property(arbDipRect, (dragRect) => {
        // Create a map where the drag region overlaps with click-through and interactive
        const map: RegionMap = {
          revision: 1,
          dragRegions: [dragRect],
          interactiveRegions: [dragRect], // same rect in interactive
          clickThroughRegions: [dragRect], // same rect in click-through
        };

        // Generate a point guaranteed inside the rect
        const px = dragRect.x + Math.floor(dragRect.width / 2);
        const py = dragRect.y + Math.floor(dragRect.height / 2);

        // At 96 DPI (scale=1), physical = DIP
        const result = hitTest({ x: px, y: py }, 96, map);
        expect(result.code).toBe(NCHITTEST.HTCAPTION);
      }),
      { numRuns: 300 },
    );
  });

  it('point in click-through region (no drag overlap) yields HTTRANSPARENT', () => {
    fc.assert(
      fc.property(arbDipRect, (ctRect) => {
        // Create a map with only click-through region (no drag regions)
        const map: RegionMap = {
          revision: 1,
          dragRegions: [],
          interactiveRegions: [ctRect], // interactive at the same spot shouldn't matter
          clickThroughRegions: [ctRect],
        };

        const px = ctRect.x + Math.floor(ctRect.width / 2);
        const py = ctRect.y + Math.floor(ctRect.height / 2);

        const result = hitTest({ x: px, y: py }, 96, map);
        expect(result.code).toBe(NCHITTEST.HTTRANSPARENT);
      }),
      { numRuns: 300 },
    );
  });

  it('point matching no region yields HTCLIENT', () => {
    fc.assert(
      fc.property(arbDipRect, arbPoint, (rect, point) => {
        // Only put a drag region far away from our test point
        const farRect: DipRect = {
          x: point.x + 1000,
          y: point.y + 1000,
          width: 100,
          height: 100,
        };
        const map: RegionMap = {
          revision: 1,
          dragRegions: [farRect],
          interactiveRegions: [],
          clickThroughRegions: [],
        };

        const result = hitTest(point, 96, map);
        expect(result.code).toBe(NCHITTEST.HTCLIENT);
      }),
      { numRuns: 300 },
    );
  });

  it('null (missing) region map always yields HTCLIENT', () => {
    fc.assert(
      fc.property(arbPoint, (point) => {
        const result = hitTest(point, 96, null);
        expect(result.code).toBe(NCHITTEST.HTCLIENT);
        expect(result.regionIndex).toBe(-1);
      }),
      { numRuns: 200 },
    );
  });

  it('malformed region maps are rejected and cache returns HTCLIENT', () => {
    fc.assert(
      fc.property(arbMalformedRegionMap, arbPoint, (malformedMap, point) => {
        const deps = createMockDeps();
        const cache = new RegionMapCache(deps);

        // Attempt to update with the malformed map
        const result = cache.updateRegions(malformedMap);
        expect(result.valid).toBe(false);

        // Since no valid map was ever loaded, hit test returns HTCLIENT
        const hitResult = cache.hitTest(point, 96);
        expect(hitResult.code).toBe(NCHITTEST.HTCLIENT);
      }),
      { numRuns: 200 },
    );
  });

  it('stale revision is rejected; previous valid map remains active', () => {
    fc.assert(
      fc.property(
        arbDipRect,
        fc.integer({ min: 5, max: 100 }),
        (dragRect, baseRevision) => {
          const deps = createMockDeps();
          const cache = new RegionMapCache(deps);

          // Load a valid map at a higher revision
          const validMap: RegionMap = {
            revision: baseRevision,
            dragRegions: [dragRect],
            interactiveRegions: [],
            clickThroughRegions: [],
          };
          const loadResult = cache.updateRegions(validMap);
          expect(loadResult.valid).toBe(true);

          // Attempt to load a stale map (lower revision)
          const staleMap: RegionMap = {
            revision: baseRevision - 1,
            dragRegions: [],
            interactiveRegions: [],
            clickThroughRegions: [],
          };
          const staleResult = cache.updateRegions(staleMap);
          expect(staleResult.valid).toBe(false);

          // Original drag region still active
          const px = dragRect.x + Math.floor(dragRect.width / 2);
          const py = dragRect.y + Math.floor(dragRect.height / 2);
          const hitResult = cache.hitTest({ x: px, y: py }, 96);
          expect(hitResult.code).toBe(NCHITTEST.HTCAPTION);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('drag precedence holds at all required DPI scales', () => {
    const SCALES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3];

    // Use rects with minimum width/height of 3 to ensure the center lands inside
    const arbLargerRect: fc.Arbitrary<DipRect> = fc.record({
      x: fc.integer({ min: -2000, max: 2000 }),
      y: fc.integer({ min: -2000, max: 2000 }),
      width: fc.integer({ min: 3, max: 500 }),
      height: fc.integer({ min: 3, max: 500 }),
    });

    fc.assert(
      fc.property(
        arbLargerRect,
        fc.constantFrom(...SCALES),
        (dragRect, scale) => {
          const dpi = scale * 96;
          const map: RegionMap = {
            revision: 1,
            dragRegions: [dragRect],
            interactiveRegions: [],
            clickThroughRegions: [dragRect], // overlapping click-through
          };

          // Use the left+1 edge in DIP to guarantee it's strictly inside the rect
          // physicalToDip will map this back to a point that's within the rect
          const insideDipX = dragRect.x + 1;
          const insideDipY = dragRect.y + 1;
          const physX = Math.round(insideDipX * scale);
          const physY = Math.round(insideDipY * scale);

          const result = hitTest({ x: physX, y: physY }, dpi, map);
          // Drag takes precedence over click-through
          expect(result.code).toBe(NCHITTEST.HTCAPTION);
        },
      ),
      { numRuns: 300 },
    );
  });
});
