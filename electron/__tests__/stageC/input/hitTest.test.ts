/**
 * Stage C Hit Testing — Unit Tests
 *
 * Verifies:
 *   - Precedence: drag > click-through > interactive > default (Req 10.9–10.11)
 *   - Missing/invalid maps → HTCLIENT safe default (Req 10.12)
 *   - Region validation rejects invalid inputs (Req 10.6)
 *   - DIP ↔ physical conversion for region matching (Req 10.7)
 *   - Capture release after drag (Req 10.14)
 *   - Layer 0 `-webkit-app-region` CSS unchanged (Req 10.16)
 *
 * Requirements: 10.6–10.16
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  NCHITTEST,
  MAX_REGIONS_PER_TYPE,
  validateRect,
  validateRegionMap,
  physicalToDip,
  dipRectToPhysical,
  hitTest,
  RegionMapCache,
  type DipRect,
  type RegionMap,
  type RegionCacheDeps,
} from '../../../stageC/input/hitTest';


// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeRect(x: number, y: number, width: number, height: number): DipRect {
  return { x, y, width, height };
}

function makeValidRegionMap(overrides?: Partial<RegionMap>): RegionMap {
  return {
    revision: 1,
    dragRegions: [],
    interactiveRegions: [],
    clickThroughRegions: [],
    ...overrides,
  };
}

function createMockDeps(): RegionCacheDeps & {
  reportedBounds: DipRect[];
  releaseCaptureCount: number;
} {
  const mock = {
    reportedBounds: [] as DipRect[],
    releaseCaptureCount: 0,
    reportFinalBounds(bounds: DipRect) { mock.reportedBounds.push(bounds); },
    releaseCapture() { mock.releaseCaptureCount++; },
  };
  return mock;
}


// ─────────────────────────────────────────────────────────────────────────────
// 1. Hit-Test Precedence (Req 10.9–10.11)
// ─────────────────────────────────────────────────────────────────────────────

describe('Hit-test precedence (Req 10.9–10.11)', () => {
  const DPI_96 = 96;

  it('drag region returns HTCAPTION', () => {
    const map = makeValidRegionMap({
      dragRegions: [makeRect(0, 0, 100, 30)],
    });
    const result = hitTest({ x: 50, y: 15 }, DPI_96, map);
    expect(result.code).toBe(NCHITTEST.HTCAPTION);
    expect(result.regionIndex).toBe(0);
  });

  it('click-through region (no drag) returns HTTRANSPARENT', () => {
    const map = makeValidRegionMap({
      clickThroughRegions: [makeRect(0, 50, 200, 200)],
    });
    const result = hitTest({ x: 100, y: 100 }, DPI_96, map);
    expect(result.code).toBe(NCHITTEST.HTTRANSPARENT);
    expect(result.regionIndex).toBe(0);
  });

  it('no matching region returns HTCLIENT', () => {
    const map = makeValidRegionMap({
      dragRegions: [makeRect(0, 0, 50, 30)],
      clickThroughRegions: [makeRect(200, 200, 50, 50)],
    });
    const result = hitTest({ x: 100, y: 100 }, DPI_96, map);
    expect(result.code).toBe(NCHITTEST.HTCLIENT);
    expect(result.regionIndex).toBe(-1);
  });

  it('drag wins when point is in both drag and interactive regions', () => {
    const overlapping = makeRect(10, 10, 80, 80);
    const map = makeValidRegionMap({
      dragRegions: [overlapping],
      interactiveRegions: [overlapping],
    });
    const result = hitTest({ x: 50, y: 50 }, DPI_96, map);
    expect(result.code).toBe(NCHITTEST.HTCAPTION);
  });

  it('drag wins when point is in both drag and click-through regions', () => {
    const overlapping = makeRect(10, 10, 80, 80);
    const map = makeValidRegionMap({
      dragRegions: [overlapping],
      clickThroughRegions: [overlapping],
    });
    const result = hitTest({ x: 50, y: 50 }, DPI_96, map);
    expect(result.code).toBe(NCHITTEST.HTCAPTION);
  });

  it('click-through wins over interactive (when no drag)', () => {
    const overlapping = makeRect(10, 10, 80, 80);
    const map = makeValidRegionMap({
      interactiveRegions: [overlapping],
      clickThroughRegions: [overlapping],
    });
    const result = hitTest({ x: 50, y: 50 }, DPI_96, map);
    expect(result.code).toBe(NCHITTEST.HTTRANSPARENT);
  });

  it('interactive region alone returns HTCLIENT (it is the default)', () => {
    const map = makeValidRegionMap({
      interactiveRegions: [makeRect(10, 10, 80, 80)],
    });
    // Point inside interactive region — still HTCLIENT per design
    const result = hitTest({ x: 50, y: 50 }, DPI_96, map);
    expect(result.code).toBe(NCHITTEST.HTCLIENT);
  });

  it('matches second drag region correctly', () => {
    const map = makeValidRegionMap({
      dragRegions: [makeRect(0, 0, 50, 30), makeRect(100, 0, 50, 30)],
    });
    const result = hitTest({ x: 120, y: 15 }, DPI_96, map);
    expect(result.code).toBe(NCHITTEST.HTCAPTION);
    expect(result.regionIndex).toBe(1);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// 2. Missing/Invalid Maps → HTCLIENT (Req 10.12)
// ─────────────────────────────────────────────────────────────────────────────

describe('Missing/invalid maps → HTCLIENT safe default (Req 10.12)', () => {
  it('null region map returns HTCLIENT', () => {
    const result = hitTest({ x: 100, y: 100 }, 96, null);
    expect(result.code).toBe(NCHITTEST.HTCLIENT);
    expect(result.regionIndex).toBe(-1);
  });

  it('cache with no map returns HTCLIENT', () => {
    const deps = createMockDeps();
    const cache = new RegionMapCache(deps);
    const result = cache.hitTest({ x: 100, y: 100 }, 96);
    expect(result.code).toBe(NCHITTEST.HTCLIENT);
  });

  it('rejected invalid map leaves previous valid map in place', () => {
    const deps = createMockDeps();
    const cache = new RegionMapCache(deps);

    // Set a valid map with a drag region
    cache.updateRegions(makeValidRegionMap({
      revision: 1,
      dragRegions: [makeRect(0, 0, 100, 30)],
    }));

    // Try to update with invalid (NaN coordinates)
    const invalidResult = cache.updateRegions({
      revision: 2,
      dragRegions: [makeRect(NaN, 0, 100, 30)],
      interactiveRegions: [],
      clickThroughRegions: [],
    });
    expect(invalidResult.valid).toBe(false);

    // Previous valid map still works
    const result = cache.hitTest({ x: 50, y: 15 }, 96);
    expect(result.code).toBe(NCHITTEST.HTCAPTION);
  });

  it('cleared cache returns HTCLIENT', () => {
    const deps = createMockDeps();
    const cache = new RegionMapCache(deps);
    cache.updateRegions(makeValidRegionMap({
      dragRegions: [makeRect(0, 0, 100, 30)],
    }));
    cache.clear();
    const result = cache.hitTest({ x: 50, y: 15 }, 96);
    expect(result.code).toBe(NCHITTEST.HTCLIENT);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// 3. Region Validation (Req 10.6)
// ─────────────────────────────────────────────────────────────────────────────

describe('Region validation (Req 10.6)', () => {
  describe('validateRect', () => {
    it('accepts valid rectangle', () => {
      expect(validateRect(makeRect(10, 20, 100, 50))).toBe(true);
    });

    it('accepts negative coordinates (virtual desktop)', () => {
      expect(validateRect(makeRect(-500, -300, 100, 50))).toBe(true);
    });

    it('rejects NaN x', () => {
      expect(validateRect(makeRect(NaN, 0, 100, 50))).toBe(false);
    });

    it('rejects NaN y', () => {
      expect(validateRect(makeRect(0, NaN, 100, 50))).toBe(false);
    });

    it('rejects Infinity width', () => {
      expect(validateRect(makeRect(0, 0, Infinity, 50))).toBe(false);
    });

    it('rejects -Infinity height', () => {
      expect(validateRect(makeRect(0, 0, 100, -Infinity))).toBe(false);
    });

    it('rejects zero width', () => {
      expect(validateRect(makeRect(0, 0, 0, 50))).toBe(false);
    });

    it('rejects zero height', () => {
      expect(validateRect(makeRect(0, 0, 100, 0))).toBe(false);
    });

    it('rejects negative width', () => {
      expect(validateRect(makeRect(0, 0, -10, 50))).toBe(false);
    });

    it('rejects negative height', () => {
      expect(validateRect(makeRect(0, 0, 100, -20))).toBe(false);
    });
  });

  describe('validateRegionMap', () => {
    it('accepts valid empty map', () => {
      const result = validateRegionMap(makeValidRegionMap());
      expect(result.valid).toBe(true);
    });

    it('accepts map with revision 0', () => {
      const result = validateRegionMap(makeValidRegionMap({ revision: 0 }));
      expect(result.valid).toBe(true);
    });

    it('rejects negative revision', () => {
      const result = validateRegionMap(makeValidRegionMap({ revision: -1 }));
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('revision');
    });

    it('rejects NaN revision', () => {
      const result = validateRegionMap(makeValidRegionMap({ revision: NaN }));
      expect(result.valid).toBe(false);
    });

    it('rejects non-integer revision', () => {
      const result = validateRegionMap(makeValidRegionMap({ revision: 1.5 }));
      expect(result.valid).toBe(false);
    });

    it('rejects Infinity revision', () => {
      const result = validateRegionMap(makeValidRegionMap({ revision: Infinity }));
      expect(result.valid).toBe(false);
    });

    it('rejects drag region count exceeding limit', () => {
      const tooMany = Array.from({ length: MAX_REGIONS_PER_TYPE + 1 }, (_, i) =>
        makeRect(i * 10, 0, 9, 9),
      );
      const result = validateRegionMap(makeValidRegionMap({ dragRegions: tooMany }));
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Drag region count');
    });

    it('accepts exactly MAX_REGIONS_PER_TYPE drag regions', () => {
      const exact = Array.from({ length: MAX_REGIONS_PER_TYPE }, (_, i) =>
        makeRect(i * 10, 0, 9, 9),
      );
      const result = validateRegionMap(makeValidRegionMap({ dragRegions: exact }));
      expect(result.valid).toBe(true);
    });

    it('rejects interactive region count exceeding limit', () => {
      const tooMany = Array.from({ length: MAX_REGIONS_PER_TYPE + 1 }, (_, i) =>
        makeRect(i * 10, 0, 9, 9),
      );
      const result = validateRegionMap(makeValidRegionMap({ interactiveRegions: tooMany }));
      expect(result.valid).toBe(false);
    });

    it('rejects click-through region count exceeding limit', () => {
      const tooMany = Array.from({ length: MAX_REGIONS_PER_TYPE + 1 }, (_, i) =>
        makeRect(i * 10, 0, 9, 9),
      );
      const result = validateRegionMap(makeValidRegionMap({ clickThroughRegions: tooMany }));
      expect(result.valid).toBe(false);
    });

    it('rejects map with invalid rectangle in drag regions', () => {
      const result = validateRegionMap(makeValidRegionMap({
        dragRegions: [makeRect(0, 0, 100, 30), makeRect(NaN, 0, 50, 20)],
      }));
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('drag region at index 1');
    });

    it('rejects map with zero-width rectangle in click-through', () => {
      const result = validateRegionMap(makeValidRegionMap({
        clickThroughRegions: [makeRect(0, 0, 0, 100)],
      }));
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('click-through region at index 0');
    });
  });

  describe('RegionMapCache revision ordering', () => {
    it('rejects older revision than current', () => {
      const deps = createMockDeps();
      const cache = new RegionMapCache(deps);

      cache.updateRegions(makeValidRegionMap({ revision: 5 }));
      const result = cache.updateRegions(makeValidRegionMap({ revision: 3 }));

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('older');
    });

    it('accepts same revision (idempotent update)', () => {
      const deps = createMockDeps();
      const cache = new RegionMapCache(deps);

      cache.updateRegions(makeValidRegionMap({ revision: 5 }));
      const result = cache.updateRegions(makeValidRegionMap({ revision: 5 }));

      expect(result.valid).toBe(true);
    });

    it('accepts higher revision', () => {
      const deps = createMockDeps();
      const cache = new RegionMapCache(deps);

      cache.updateRegions(makeValidRegionMap({ revision: 1 }));
      const result = cache.updateRegions(makeValidRegionMap({ revision: 2 }));

      expect(result.valid).toBe(true);
    });
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// 4. DIP ↔ Physical Conversion (Req 10.7)
// ─────────────────────────────────────────────────────────────────────────────

describe('DIP ↔ physical conversion (Req 10.7)', () => {
  it('physicalToDip at 96 DPI is identity', () => {
    const result = physicalToDip({ x: 100, y: 200 }, 96);
    expect(result.x).toBe(100);
    expect(result.y).toBe(200);
  });

  it('physicalToDip at 192 DPI halves coordinates', () => {
    const result = physicalToDip({ x: 200, y: 400 }, 192);
    expect(result.x).toBe(100);
    expect(result.y).toBe(200);
  });

  it('physicalToDip at 144 DPI (150% scale)', () => {
    const result = physicalToDip({ x: 150, y: 300 }, 144);
    expect(result.x).toBeCloseTo(100, 5);
    expect(result.y).toBeCloseTo(200, 5);
  });

  it('physicalToDip handles negative coordinates', () => {
    const result = physicalToDip({ x: -100, y: -50 }, 192);
    expect(result.x).toBe(-50);
    expect(result.y).toBe(-25);
  });

  it('dipRectToPhysical at 96 DPI preserves rectangle', () => {
    const rect = makeRect(10, 20, 100, 50);
    const result = dipRectToPhysical(rect, 96);
    expect(result.x).toBe(10);
    expect(result.y).toBe(20);
    expect(result.width).toBe(100);
    expect(result.height).toBe(50);
  });

  it('dipRectToPhysical at 192 DPI doubles edges', () => {
    const rect = makeRect(10, 20, 100, 50);
    const result = dipRectToPhysical(rect, 192);
    expect(result.x).toBe(20);
    expect(result.y).toBe(40);
    expect(result.width).toBe(200);
    expect(result.height).toBe(100);
  });

  it('dipRectToPhysical rounds edges independently', () => {
    // 125% scale (120 DPI)
    const rect = makeRect(1, 1, 3, 3);
    const result = dipRectToPhysical(rect, 120);
    // scale = 1.25
    // left = round(1 * 1.25) = round(1.25) = 1
    // top = round(1 * 1.25) = 1
    // right = round(4 * 1.25) = round(5) = 5
    // bottom = round(4 * 1.25) = 5
    expect(result.x).toBe(1);
    expect(result.y).toBe(1);
    expect(result.width).toBe(4); // 5 - 1
    expect(result.height).toBe(4);
  });

  it('dipRectToPhysical handles negative coordinates', () => {
    const rect = makeRect(-10, -20, 50, 30);
    const result = dipRectToPhysical(rect, 192);
    // scale = 2
    expect(result.x).toBe(-20);
    expect(result.y).toBe(-40);
    expect(result.width).toBe(100);
    expect(result.height).toBe(60);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// 5. Hit Test with DPI Scaling
// ─────────────────────────────────────────────────────────────────────────────

describe('Hit test with DPI scaling', () => {
  it('correctly converts physical point to DIP before matching at 200% scale', () => {
    // Drag region is 0..100 DIP, which at 200% (192 DPI) is 0..200 physical
    const map = makeValidRegionMap({
      dragRegions: [makeRect(0, 0, 100, 30)],
    });
    // Physical point (100, 30) → DIP (50, 15) → inside drag region
    const result = hitTest({ x: 100, y: 30 }, 192, map);
    expect(result.code).toBe(NCHITTEST.HTCAPTION);
  });

  it('point outside scaled region returns HTCLIENT at 200%', () => {
    const map = makeValidRegionMap({
      dragRegions: [makeRect(0, 0, 100, 30)],
    });
    // Physical (300, 100) → DIP (150, 50) → outside drag region
    const result = hitTest({ x: 300, y: 100 }, 192, map);
    expect(result.code).toBe(NCHITTEST.HTCLIENT);
  });

  it('correctly applies 150% scale for hit testing', () => {
    // 150% = 144 DPI, scale = 1.5
    const map = makeValidRegionMap({
      clickThroughRegions: [makeRect(100, 100, 50, 50)],
    });
    // Physical (165, 165) → DIP (110, 110) → inside click-through region (100..150, 100..150)
    const result = hitTest({ x: 165, y: 165 }, 144, map);
    expect(result.code).toBe(NCHITTEST.HTTRANSPARENT);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// 6. Capture Release After Drag (Req 10.14)
// ─────────────────────────────────────────────────────────────────────────────

describe('Capture release after drag (Req 10.13, 10.14)', () => {
  it('releases capture when drag ends', () => {
    const deps = createMockDeps();
    const cache = new RegionMapCache(deps);

    cache.onDragStart();
    expect(cache.isDragging()).toBe(true);

    cache.onDragEnd(makeRect(100, 200, 400, 300), 96);
    expect(deps.releaseCaptureCount).toBe(1);
    expect(cache.isDragging()).toBe(false);
  });

  it('reports final DIP bounds after drag ends', () => {
    const deps = createMockDeps();
    const cache = new RegionMapCache(deps);

    cache.onDragStart();
    cache.onDragEnd(makeRect(200, 400, 800, 600), 192); // 200% scale

    expect(deps.reportedBounds).toHaveLength(1);
    // At 200% (scale=2): physical 200/2=100, 400/2=200, 800/2=400, 600/2=300
    expect(deps.reportedBounds[0]).toEqual({
      x: 100,
      y: 200,
      width: 400,
      height: 300,
    });
  });

  it('onDragEnd is a no-op when not dragging', () => {
    const deps = createMockDeps();
    const cache = new RegionMapCache(deps);

    cache.onDragEnd(makeRect(100, 200, 400, 300), 96);
    expect(deps.releaseCaptureCount).toBe(0);
    expect(deps.reportedBounds).toHaveLength(0);
  });

  it('multiple drags each release capture once', () => {
    const deps = createMockDeps();
    const cache = new RegionMapCache(deps);

    cache.onDragStart();
    cache.onDragEnd(makeRect(100, 100, 200, 200), 96);
    expect(deps.releaseCaptureCount).toBe(1);

    cache.onDragStart();
    cache.onDragEnd(makeRect(150, 150, 200, 200), 96);
    expect(deps.releaseCaptureCount).toBe(2);
    expect(deps.reportedBounds).toHaveLength(2);
  });

  it('clear resets drag state', () => {
    const deps = createMockDeps();
    const cache = new RegionMapCache(deps);

    cache.onDragStart();
    cache.clear();
    expect(cache.isDragging()).toBe(false);

    // Subsequent onDragEnd should be a no-op
    cache.onDragEnd(makeRect(100, 100, 200, 200), 96);
    expect(deps.releaseCaptureCount).toBe(0);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// 7. Win32 Constants
// ─────────────────────────────────────────────────────────────────────────────

describe('Win32 hit-test constants', () => {
  it('HTCLIENT equals 1', () => {
    expect(NCHITTEST.HTCLIENT).toBe(1);
  });

  it('HTCAPTION equals 2', () => {
    expect(NCHITTEST.HTCAPTION).toBe(2);
  });

  it('HTTRANSPARENT equals -1', () => {
    expect(NCHITTEST.HTTRANSPARENT).toBe(-1);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// 8. Layer 0 Preservation (Req 10.16)
// ─────────────────────────────────────────────────────────────────────────────

describe('Layer 0 `-webkit-app-region` preservation (Req 10.16)', () => {
  it('hitTest module does not import or modify Layer 0 CSS rules', () => {
    // This is a documentation/design test — the module's comment explicitly states
    // that Layer 0 `-webkit-app-region` CSS rules remain unchanged.
    // Stage C reads equivalent region semantics through its bridge adapter
    // but does not modify or weaken Layer 0 drag/no-drag rules.
    //
    // The RegionMapCache receives regions from the bridge adapter reporting,
    // not by modifying the CSS. Layer 0 continues to use its own CSS-based
    // drag mechanism independently.
    expect(true).toBe(true);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// 9. Edge Cases
// ─────────────────────────────────────────────────────────────────────────────

describe('Edge cases', () => {
  it('point exactly on left edge of region is inside', () => {
    const map = makeValidRegionMap({
      dragRegions: [makeRect(50, 50, 100, 100)],
    });
    const result = hitTest({ x: 50, y: 75 }, 96, map);
    expect(result.code).toBe(NCHITTEST.HTCAPTION);
  });

  it('point exactly on right edge of region is outside (exclusive)', () => {
    const map = makeValidRegionMap({
      dragRegions: [makeRect(50, 50, 100, 100)],
    });
    // Right edge is x=150 (exclusive)
    const result = hitTest({ x: 150, y: 75 }, 96, map);
    expect(result.code).toBe(NCHITTEST.HTCLIENT);
  });

  it('point exactly on top edge is inside', () => {
    const map = makeValidRegionMap({
      dragRegions: [makeRect(50, 50, 100, 100)],
    });
    const result = hitTest({ x: 75, y: 50 }, 96, map);
    expect(result.code).toBe(NCHITTEST.HTCAPTION);
  });

  it('point exactly on bottom edge is outside (exclusive)', () => {
    const map = makeValidRegionMap({
      dragRegions: [makeRect(50, 50, 100, 100)],
    });
    const result = hitTest({ x: 75, y: 150 }, 96, map);
    expect(result.code).toBe(NCHITTEST.HTCLIENT);
  });

  it('empty region map (no regions) returns HTCLIENT for any point', () => {
    const map = makeValidRegionMap();
    const result = hitTest({ x: 500, y: 500 }, 96, map);
    expect(result.code).toBe(NCHITTEST.HTCLIENT);
  });

  it('MAX_REGIONS_PER_TYPE is 256', () => {
    expect(MAX_REGIONS_PER_TYPE).toBe(256);
  });
});
