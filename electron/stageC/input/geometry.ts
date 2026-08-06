/**
 * Stage C Geometry — Edge-Rounded DIP/Physical Conversion and Topology Recovery
 * Zule AI — Stage C
 *
 * Implements:
 *   - Edge-rounded DIP→physical conversion (rounds left/top/right/bottom independently)
 *   - Physical→DIP inverse conversion with signed coordinates
 *   - WM_DPICHANGED handler (applies OS-recommended rect, updates raster/composition/input/regions)
 *   - Monitor topology validation (reachable check, recenter unreachable, typed degradation)
 *   - Geometry operations: move/resize/nudge/recenter/snap/maximize/restore/show/hide/toggle
 *     producing physical edges within 1px of Layer 0 target
 *   - Negative virtual-desktop coordinates stay signed throughout
 *
 * Design: App Core stores canonical rectangles in DIPs. Sidecar converts at target
 * monitor's effective DPI. Conversion rounds rectangle edges, not width/height
 * independently, to avoid drift. WM_DPICHANGED applies recommended rect before
 * next visible frame.
 *
 * Requirements: 11.1–11.13
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A rectangle in physical pixels (screen coordinates).
 * Left/top may be negative on virtual desktops.
 * Width and height are always >= 0 for valid rects.
 */
export interface PhysicalRect {
  /** Left edge in physical pixels (signed) */
  left: number;
  /** Top edge in physical pixels (signed) */
  top: number;
  /** Width in physical pixels (non-negative) */
  width: number;
  /** Height in physical pixels (non-negative) */
  height: number;
}

/**
 * A rectangle in Device Independent Pixels (96 DPI base).
 * Coordinates may be negative (virtual desktop).
 */
export interface DipRectEdges {
  /** Left edge in DIPs (signed) */
  left: number;
  /** Top edge in DIPs (signed) */
  top: number;
  /** Width in DIPs (non-negative) */
  width: number;
  /** Height in DIPs (non-negative) */
  height: number;
}

/**
 * Monitor information for topology validation.
 */
export interface MonitorInfo {
  /** Work area in physical pixels (excludes taskbar etc.) */
  workArea: PhysicalRect;
  /** DPI scale factor (e.g. 1.0, 1.25, 1.5, 2.0) */
  scaleFactor: number;
  /** Whether this is the primary monitor */
  isPrimary: boolean;
}

/**
 * Result of topology validation for bounds reachability.
 */
export interface TopologyValidationResult {
  /** Whether the bounds are reachable on at least one monitor */
  reachable: boolean;
  /** The validated/corrected bounds (recentered if unreachable) */
  bounds: PhysicalRect;
  /** Degradation reason when recovery was impossible */
  degradation: TopologyDegradation | null;
}

/**
 * Typed degradation reasons for topology recovery failures.
 */
export enum TopologyDegradation {
  /** No monitors available for recovery */
  NO_MONITORS = 'NO_MONITORS',
  /** Primary monitor work area is invalid (zero area) */
  INVALID_PRIMARY_WORK_AREA = 'INVALID_PRIMARY_WORK_AREA',
  /** Recovery produced non-finite or negative-area rectangle */
  INVALID_RECOVERY_RECT = 'INVALID_RECOVERY_RECT',
}

/**
 * Context passed when a DPI change event (WM_DPICHANGED) occurs.
 */
export interface DpiChangeContext {
  /** New effective DPI after the change */
  newDpi: number;
  /** OS-recommended physical rectangle from WM_DPICHANGED lParam */
  recommendedRect: PhysicalRect;
  /** DPI before the change */
  previousDpi: number;
}

/**
 * Result from applying a DPI change.
 */
export interface DpiChangeResult {
  /** New bounds after applying DPI change */
  bounds: PhysicalRect;
  /** New raster scale factor */
  rasterScale: number;
  /** New DPI value */
  dpi: number;
}

/**
 * Geometry operation types that match Layer 0's operations.
 */
export type GeometryOperation =
  | 'move'
  | 'resize'
  | 'nudge'
  | 'recenter'
  | 'snap'
  | 'maximize'
  | 'restore'
  | 'show'
  | 'hide'
  | 'toggle';

/**
 * Target bounds for a geometry operation, specified in DIPs.
 */
export interface GeometryTarget {
  /** The operation type */
  operation: GeometryOperation;
  /** Target bounds in DIPs */
  targetDip: DipRectEdges;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Standard DPI baseline (Windows default at 100% scale) */
export const BASE_DPI = 96;

/** Maximum allowed edge error in physical pixels for Layer 0 equivalence */
export const MAX_EDGE_ERROR_PX = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Edge-Rounded DIP → Physical Conversion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts DIP rectangle to physical pixel rectangle using edge rounding.
 *
 * Per design: rounds left, top, right, bottom edges independently,
 * then derives width = right - left, height = bottom - top.
 * This avoids cumulative drift from rounding width/height separately.
 *
 * Negative coordinates (virtual desktop) are preserved as signed.
 *
 * Requirements: 11.3, 11.5
 *
 * @param rect - Rectangle in Device Independent Pixels
 * @param dpi - Effective DPI of the target monitor
 * @returns Rectangle in physical pixels
 */
export function dipEdgesToPhysical(rect: DipRectEdges, dpi: number): PhysicalRect {
  const scale = dpi / BASE_DPI;

  // Round each edge independently per design pseudocode
  const left = Math.round(rect.left * scale);
  const top = Math.round(rect.top * scale);
  const right = Math.round((rect.left + rect.width) * scale);
  const bottom = Math.round((rect.top + rect.height) * scale);

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Physical → DIP Edge Conversion (Inverse)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts physical pixel rectangle to DIP rectangle using edge-based inverse.
 *
 * Inverse-scales left, top, right, bottom edges using effective DPI,
 * then derives width and height. Signed coordinates preserved.
 *
 * Requirements: 11.4, 11.5, 11.13
 *
 * @param rect - Rectangle in physical pixels
 * @param dpi - Effective DPI of the active monitor
 * @returns Rectangle in Device Independent Pixels
 */
export function physicalEdgesToDip(rect: PhysicalRect, dpi: number): DipRectEdges {
  const scale = dpi / BASE_DPI;

  // Inverse-scale each edge independently
  const left = rect.left / scale;
  const top = rect.top / scale;
  const right = (rect.left + rect.width) / scale;
  const bottom = (rect.top + rect.height) / scale;

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WM_DPICHANGED Handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Applies DPI change by using the OS-recommended physical rectangle.
 *
 * Per design: WM_DPICHANGED applies the OS-recommended physical rectangle
 * before the next visible frame, then updates:
 * - WebView2 rasterization scale
 * - Composition bounds
 * - Input conversion
 * - Region maps
 *
 * All four updates happen together before the next frame is presented.
 *
 * Requirements: 11.7, 11.8
 *
 * @param context - DPI change context with new DPI and recommended rect
 * @returns Result with new bounds, raster scale, and DPI
 */
export function applyDpiChange(context: DpiChangeContext): DpiChangeResult {
  const { newDpi, recommendedRect } = context;

  // Use the OS-recommended rectangle directly — it accounts for the DPI change
  // and avoids position drift from manual recalculation
  return {
    bounds: { ...recommendedRect },
    rasterScale: newDpi / BASE_DPI,
    dpi: newDpi,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Monitor Topology Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks whether a physical rectangle has any intersection with a monitor work area.
 */
function intersects(rect: PhysicalRect, monitor: PhysicalRect): boolean {
  const rectRight = rect.left + rect.width;
  const rectBottom = rect.top + rect.height;
  const monRight = monitor.left + monitor.width;
  const monBottom = monitor.top + monitor.height;

  return (
    rect.left < monRight &&
    rectRight > monitor.left &&
    rect.top < monBottom &&
    rectBottom > monitor.top
  );
}

/**
 * Validates whether bounds are reachable on any available monitor.
 *
 * Rules per design:
 * - If bounds intersect any monitor work area → reachable, bounds unmodified
 * - If bounds have zero intersection → recenter on primary monitor work area
 * - If topology recovery cannot calculate valid replacement → retain current, report degradation
 *
 * Requirements: 11.9, 11.10, 11.11
 *
 * @param bounds - Current physical pixel bounds to validate
 * @param monitors - Available monitor information
 * @returns Validation result with reachability status and potentially corrected bounds
 */
export function validateTopology(
  bounds: PhysicalRect,
  monitors: MonitorInfo[],
): TopologyValidationResult {
  // No monitors available — cannot recover
  if (monitors.length === 0) {
    return {
      reachable: false,
      bounds,
      degradation: TopologyDegradation.NO_MONITORS,
    };
  }

  // Check if bounds intersect any monitor work area
  for (const monitor of monitors) {
    if (intersects(bounds, monitor.workArea)) {
      return {
        reachable: true,
        bounds,
        degradation: null,
      };
    }
  }

  // Bounds are unreachable — recenter on primary monitor work area
  const primary = monitors.find(m => m.isPrimary) ?? monitors[0];
  const workArea = primary.workArea;

  // Validate primary work area has positive area
  if (workArea.width <= 0 || workArea.height <= 0) {
    return {
      reachable: false,
      bounds,
      degradation: TopologyDegradation.INVALID_PRIMARY_WORK_AREA,
    };
  }

  // Calculate centered position within primary work area
  const newLeft = workArea.left + Math.round((workArea.width - bounds.width) / 2);
  const newTop = workArea.top + Math.round((workArea.height - bounds.height) / 2);

  const newBounds: PhysicalRect = {
    left: newLeft,
    top: newTop,
    width: bounds.width,
    height: bounds.height,
  };

  // Validate recovery produced a finite positive-area rectangle
  if (
    !Number.isFinite(newBounds.left) ||
    !Number.isFinite(newBounds.top) ||
    !Number.isFinite(newBounds.width) ||
    !Number.isFinite(newBounds.height) ||
    newBounds.width <= 0 ||
    newBounds.height <= 0
  ) {
    return {
      reachable: false,
      bounds,
      degradation: TopologyDegradation.INVALID_RECOVERY_RECT,
    };
  }

  return {
    reachable: false,
    bounds: newBounds,
    degradation: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry Operations — Layer 0 Edge Equivalence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts a geometry operation's DIP target bounds to physical pixel bounds.
 *
 * Every operation (move, resize, nudge, recenter, snap, maximize, restore,
 * show, hide, toggle) produces physical edges within 1 pixel of Layer 0's
 * equivalent target by using the same edge-rounding algorithm.
 *
 * Requirement: 11.12
 *
 * @param target - The geometry operation target with DIP bounds
 * @param dpi - Effective DPI of the target monitor
 * @returns Physical pixel rectangle matching Layer 0 within 1px per edge
 */
export function operationToPhysical(target: GeometryTarget, dpi: number): PhysicalRect {
  // All operations use the same edge-rounded DIP→physical conversion,
  // which guarantees ≤1px error per edge compared to Layer 0's equivalent.
  return dipEdgesToPhysical(target.targetDip, dpi);
}

/**
 * Validates that two physical rectangles match within the allowed edge error
 * (1 physical pixel per edge).
 *
 * Requirement: 11.12
 *
 * @param actual - The actual physical rect produced by Stage C
 * @param expected - The expected physical rect from Layer 0
 * @returns Whether all edges are within MAX_EDGE_ERROR_PX
 */
export function edgesMatchWithinTolerance(
  actual: PhysicalRect,
  expected: PhysicalRect,
): boolean {
  const leftDiff = Math.abs(actual.left - expected.left);
  const topDiff = Math.abs(actual.top - expected.top);
  const rightDiff = Math.abs((actual.left + actual.width) - (expected.left + expected.width));
  const bottomDiff = Math.abs((actual.top + actual.height) - (expected.top + expected.height));

  return (
    leftDiff <= MAX_EDGE_ERROR_PX &&
    topDiff <= MAX_EDGE_ERROR_PX &&
    rightDiff <= MAX_EDGE_ERROR_PX &&
    bottomDiff <= MAX_EDGE_ERROR_PX
  );
}
