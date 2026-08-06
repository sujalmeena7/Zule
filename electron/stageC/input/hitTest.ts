/**
 * Stage C Hit Testing — Region Maps, WM_NCHITTEST, and Native Drag
 * Zule AI — Stage C
 *
 * Implements:
 *   - Versioned region map model (drag, interactive, click-through DIP rectangles)
 *   - Region validation (finite coords, positive dims, count limit, revision)
 *   - Cached region storage without synchronous renderer calls
 *   - Hit-test logic for WM_NCHITTEST with precedence: drag > click-through > HTCLIENT
 *   - Native drag via HTCAPTION → Windows move loop
 *   - Capture release after drag completion
 *   - Final DIP bounds reporting to App Core
 *
 * Layer 0 `-webkit-app-region` CSS rules remain unchanged. Stage C reads
 * equivalent DOM region semantics through its bridge adapter but does not
 * modify or weaken Layer 0 drag/no-drag rules.
 *
 * Requirements: 10.6–10.16
 */

// ─────────────────────────────────────────────────────────────────────────────
// Win32 Hit-Test Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Windows hit-test return values used in WM_NCHITTEST */
export const NCHITTEST = {
  /** Client area — default interactive region */
  HTCLIENT: 1,
  /** Caption area — delegates to Windows native move loop */
  HTCAPTION: 2,
  /** Transparent — pass-through to window below */
  HTTRANSPARENT: -1,
} as const;

export type HitTestCode = typeof NCHITTEST[keyof typeof NCHITTEST];

// ─────────────────────────────────────────────────────────────────────────────
// DIP Rectangle Type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A rectangle in Device Independent Pixels (96 DPI).
 * Coordinates may be negative (virtual desktop).
 * Width and height must be positive for valid regions.
 */
export interface DipRect {
  /** Left edge in DIPs */
  x: number;
  /** Top edge in DIPs */
  y: number;
  /** Width in DIPs (must be > 0) */
  width: number;
  /** Height in DIPs (must be > 0) */
  height: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Region Map Model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maximum number of rectangles per region type.
 * Prevents unbounded memory use from a malformed renderer report.
 */
export const MAX_REGIONS_PER_TYPE = 256;

/**
 * Versioned region map reported by the renderer after layout changes.
 * The sidecar validates and caches this without synchronous renderer calls.
 */
export interface RegionMap {
  /** Non-negative integer revision, incremented by renderer on each update */
  revision: number;

  /** Drag regions — points here return HTCAPTION (Windows native move loop) */
  dragRegions: readonly DipRect[];

  /** Interactive regions — points here receive normal input */
  interactiveRegions: readonly DipRect[];

  /** Click-through regions — points here return HTTRANSPARENT */
  clickThroughRegions: readonly DipRect[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Hit-Test Result
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of a hit test, including the Win32 code and matched region index.
 */
export interface HitTestResult {
  /** Win32 hit-test code: HTCAPTION, HTTRANSPARENT, or HTCLIENT */
  code: HitTestCode;

  /** Index of the matched region in the corresponding array, or -1 if no match */
  regionIndex: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Region Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validation result for a region map update.
 */
export interface RegionValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates a single DIP rectangle.
 * Requires: finite coordinates, positive width and height.
 */
export function validateRect(rect: DipRect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

/**
 * Validates a complete region map update from the renderer.
 *
 * Checks:
 * - Revision is a non-negative finite integer
 * - All rectangle coordinates are finite
 * - All rectangles have positive dimensions
 * - Each region type has at most MAX_REGIONS_PER_TYPE rectangles
 *
 * Requirements: 10.6
 */
export function validateRegionMap(map: RegionMap): RegionValidationResult {
  // Revision must be non-negative finite integer
  if (
    !Number.isFinite(map.revision) ||
    map.revision < 0 ||
    !Number.isInteger(map.revision)
  ) {
    return { valid: false, reason: 'Invalid revision: must be a non-negative integer' };
  }

  // Count limits
  if (map.dragRegions.length > MAX_REGIONS_PER_TYPE) {
    return { valid: false, reason: `Drag region count ${map.dragRegions.length} exceeds maximum ${MAX_REGIONS_PER_TYPE}` };
  }
  if (map.interactiveRegions.length > MAX_REGIONS_PER_TYPE) {
    return { valid: false, reason: `Interactive region count ${map.interactiveRegions.length} exceeds maximum ${MAX_REGIONS_PER_TYPE}` };
  }
  if (map.clickThroughRegions.length > MAX_REGIONS_PER_TYPE) {
    return { valid: false, reason: `Click-through region count ${map.clickThroughRegions.length} exceeds maximum ${MAX_REGIONS_PER_TYPE}` };
  }

  // Validate each rectangle in all region types
  for (let i = 0; i < map.dragRegions.length; i++) {
    if (!validateRect(map.dragRegions[i])) {
      return { valid: false, reason: `Invalid drag region at index ${i}` };
    }
  }
  for (let i = 0; i < map.interactiveRegions.length; i++) {
    if (!validateRect(map.interactiveRegions[i])) {
      return { valid: false, reason: `Invalid interactive region at index ${i}` };
    }
  }
  for (let i = 0; i < map.clickThroughRegions.length; i++) {
    if (!validateRect(map.clickThroughRegions[i])) {
      return { valid: false, reason: `Invalid click-through region at index ${i}` };
    }
  }

  return { valid: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Coordinate Conversion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts physical client-area pixels to DIP coordinates.
 * Uses the active monitor DPI. Standard DPI is 96.
 *
 * Requirement: 10.7
 */
export function physicalToDip(
  point: { x: number; y: number },
  dpi: number,
): { x: number; y: number } {
  const scale = dpi / 96;
  return {
    x: point.x / scale,
    y: point.y / scale,
  };
}

/**
 * Converts DIP rectangle edges to physical client pixels.
 * Rounds each edge independently to avoid drift.
 *
 * Requirement: 10.7 (used for region-to-physical transform)
 */
export function dipRectToPhysical(rect: DipRect, dpi: number): DipRect {
  const scale = dpi / 96;
  const left = Math.round(rect.x * scale);
  const top = Math.round(rect.y * scale);
  const right = Math.round((rect.x + rect.width) * scale);
  const bottom = Math.round((rect.y + rect.height) * scale);
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Point-in-Rectangle Test
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tests whether a DIP point lies inside a DIP rectangle.
 */
function pointInRect(px: number, py: number, rect: DipRect): boolean {
  return (
    px >= rect.x &&
    px < rect.x + rect.width &&
    py >= rect.y &&
    py < rect.y + rect.height
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Hit-Test Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Performs a WM_NCHITTEST-equivalent determination for a screen point.
 *
 * Algorithm (from design):
 *   1. Convert screen point to client physical pixels (caller provides this)
 *   2. Convert client physical to DIP using current DPI
 *   3. If region map is missing or invalid → HTCLIENT (safe default)
 *   4. Check drag regions first (drag wins over interactive)
 *   5. Check click-through regions (only if not drag)
 *   6. Default: HTCLIENT
 *
 * Precedence: drag > click-through > interactive > default
 * Invalid/missing maps → HTCLIENT (never click-through or drag)
 *
 * Requirements: 10.8–10.12
 *
 * @param clientPhysical - Point in physical client coordinates
 * @param dpi - Current effective DPI of the active monitor
 * @param regionMap - The current validated cached region map, or null if absent/invalid
 */
export function hitTest(
  clientPhysical: { x: number; y: number },
  dpi: number,
  regionMap: RegionMap | null,
): HitTestResult {
  // Safe default when region map is missing or invalid (Req 10.12)
  if (regionMap === null) {
    return { code: NCHITTEST.HTCLIENT, regionIndex: -1 };
  }

  // Convert physical client point to DIP
  const pointDip = physicalToDip(clientPhysical, dpi);

  // Check drag regions first — drag wins over everything (Req 10.9)
  for (let i = 0; i < regionMap.dragRegions.length; i++) {
    if (pointInRect(pointDip.x, pointDip.y, regionMap.dragRegions[i])) {
      return { code: NCHITTEST.HTCAPTION, regionIndex: i };
    }
  }

  // Check click-through regions (only when not in drag) (Req 10.10)
  for (let i = 0; i < regionMap.clickThroughRegions.length; i++) {
    if (pointInRect(pointDip.x, pointDip.y, regionMap.clickThroughRegions[i])) {
      return { code: NCHITTEST.HTTRANSPARENT, regionIndex: i };
    }
  }

  // Default: HTCLIENT (interactive or no region match) (Req 10.11)
  return { code: NCHITTEST.HTCLIENT, regionIndex: -1 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Region Map Cache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies for the region map cache.
 * Allows testable injection of reporting behavior.
 */
export interface RegionCacheDeps {
  /**
   * Called when native drag movement completes or is cancelled.
   * Reports final DIP bounds to App Core for canonical persistence.
   * Requirement: 10.14
   */
  reportFinalBounds(bounds: DipRect): void;

  /**
   * Called to release pointer capture after drag ends.
   * On Windows: ReleaseCapture()
   * Requirement: 10.14
   */
  releaseCapture(): void;
}

/**
 * Manages the validated cached region map for WM_NCHITTEST.
 *
 * Key behaviors:
 * - Stores validated regions without synchronous renderer calls (Req 10.8)
 * - Only updates cache when new valid regions arrive
 * - Tracks drag state for native move loop completion
 * - Reports final DIP bounds and releases capture after drag (Req 10.14)
 *
 * Layer 0 `-webkit-app-region` CSS rules remain unchanged (Req 10.16).
 * Stage C reads equivalent region semantics through its bridge adapter but
 * does not modify or weaken Layer 0 drag/no-drag CSS rules.
 */
export class RegionMapCache {
  private cachedMap: RegionMap | null = null;
  private dragging = false;
  private readonly deps: RegionCacheDeps;

  constructor(deps: RegionCacheDeps) {
    this.deps = deps;
  }

  /**
   * Updates the cached region map if the new map passes validation.
   * Invalid maps are rejected — the previous valid map is retained.
   *
   * Requirement: 10.6 — validate revision, finite coords, rect edges, count, size
   */
  updateRegions(map: RegionMap): RegionValidationResult {
    const result = validateRegionMap(map);
    if (!result.valid) {
      // Reject: keep previous cached map unchanged
      return result;
    }

    // Only accept higher or equal revision (no rollback)
    if (this.cachedMap !== null && map.revision < this.cachedMap.revision) {
      return { valid: false, reason: `Revision ${map.revision} is older than current ${this.cachedMap.revision}` };
    }

    this.cachedMap = map;
    return { valid: true };
  }

  /**
   * Performs hit testing against the cached region map.
   * Called from WM_NCHITTEST — no synchronous renderer call (Req 10.8).
   *
   * @param clientPhysical - Point in physical client coordinates
   * @param dpi - Current effective DPI
   */
  hitTest(clientPhysical: { x: number; y: number }, dpi: number): HitTestResult {
    return hitTest(clientPhysical, dpi, this.cachedMap);
  }

  /**
   * Signals that the Windows native move loop has started (HTCAPTION was returned
   * and Windows initiated SC_MOVE). The native move loop handles actual movement.
   *
   * Requirement: 10.13 — use the Windows native move loop
   */
  onDragStart(): void {
    this.dragging = true;
  }

  /**
   * Signals that the Windows native move loop has completed or been cancelled.
   * Releases capture and reports final DIP bounds to App Core.
   *
   * Requirements: 10.13, 10.14
   *
   * @param finalPhysicalBounds - The final window rect in physical screen pixels
   * @param dpi - Current effective DPI for conversion to DIPs
   */
  onDragEnd(finalPhysicalBounds: DipRect, dpi: number): void {
    if (!this.dragging) return;
    this.dragging = false;

    // Release capture — no capture must remain after drag (Req 10.14)
    this.deps.releaseCapture();

    // Convert final physical bounds to DIPs for App Core persistence
    const scale = dpi / 96;
    const finalDipBounds: DipRect = {
      x: finalPhysicalBounds.x / scale,
      y: finalPhysicalBounds.y / scale,
      width: finalPhysicalBounds.width / scale,
      height: finalPhysicalBounds.height / scale,
    };

    // Report to App Core (Req 10.14)
    this.deps.reportFinalBounds(finalDipBounds);
  }

  /**
   * Returns whether a drag is currently in progress.
   */
  isDragging(): boolean {
    return this.dragging;
  }

  /**
   * Returns the current cached region map, or null if none.
   * Exposed for testing and diagnostics.
   */
  getCachedMap(): RegionMap | null {
    return this.cachedMap;
  }

  /**
   * Clears the cached region map (e.g., on sidecar disconnect).
   * After clearing, all hit tests return HTCLIENT (safe default).
   */
  clear(): void {
    this.cachedMap = null;
    this.dragging = false;
  }
}
