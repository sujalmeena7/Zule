// electron/edgeSnap.ts — Pure edge-snap, bounds-clamping, and size-clamping algorithms.

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapResult {
  snapped: boolean;
  bounds: Rect;
  edges: ('left' | 'right' | 'top' | 'bottom')[];
}

// ─── Size Constants ───────────────────────────────────────────────────────────

// JITTER FIX: All modes use same width (480). See useOverlayMode.ts.
export const MIN_WIDTH = 480;
export const MIN_HEIGHT = 80;
export const MAX_WIDTH = 700;
export const MAX_HEIGHT = 900;
export const COMPACT_WIDTH = 480;
export const COMPACT_HEIGHT = 80;
export const EXPANDED_WIDTH = 480;
export const EXPANDED_HEIGHT = 400;
export const MAXIMIZED_WIDTH = 480;
export const MAXIMIZED_HEIGHT = 680;
export const SNAP_DISTANCE = 16;
export const NUDGE_STEP = 40;
export const RESIZE_DURATION = 180;

// ─── computeSnap ──────────────────────────────────────────────────────────────

/**
 * Compute the snapped position for a window within a work area.
 *
 * For any edge of the window that is within `snapDistance` of the
 * corresponding work-area edge, that window edge is aligned to the
 * work-area edge. Multiple edges can snap simultaneously (corner snap).
 *
 * Pure function — no side effects.
 */
export function computeSnap(
  windowBounds: Rect,
  workArea: Rect,
  snapDistance: number,
): SnapResult {
  const edges: SnapResult['edges'] = [];
  let { x, y } = windowBounds;
  const { width, height } = windowBounds;

  // Left edge: window's left vs work area's left
  if (Math.abs(x - workArea.x) <= snapDistance) {
    x = workArea.x;
    edges.push('left');
  }

  // Right edge: window's right vs work area's right
  const windowRight = x + width;
  const workAreaRight = workArea.x + workArea.width;
  if (Math.abs(windowRight - workAreaRight) <= snapDistance) {
    x = workAreaRight - width;
    edges.push('right');
  }

  // Top edge: window's top vs work area's top
  if (Math.abs(y - workArea.y) <= snapDistance) {
    y = workArea.y;
    edges.push('top');
  }

  // Bottom edge: window's bottom vs work area's bottom
  const windowBottom = y + height;
  const workAreaBottom = workArea.y + workArea.height;
  if (Math.abs(windowBottom - workAreaBottom) <= snapDistance) {
    y = workAreaBottom - height;
    edges.push('bottom');
  }

  const snapped = edges.length > 0;
  return {
    snapped,
    bounds: { x, y, width, height },
    edges,
  };
}

// ─── clampToWorkArea ──────────────────────────────────────────────────────────

/**
 * Clamp bounds so the entire rectangle is within the work area.
 * If the window is larger than the work area in any dimension,
 * pin to top-left of that axis.
 *
 * Pure, idempotent: clamp(clamp(b, w), w) === clamp(b, w).
 */
export function clampToWorkArea(bounds: Rect, workArea: Rect): Rect {
  let { x, y } = bounds;
  const { width, height } = bounds;

  // Horizontal clamping
  if (width >= workArea.width) {
    // Window wider than work area — pin to left
    x = workArea.x;
  } else {
    // Ensure left edge is not before work area left
    if (x < workArea.x) {
      x = workArea.x;
    }
    // Ensure right edge is not past work area right
    if (x + width > workArea.x + workArea.width) {
      x = workArea.x + workArea.width - width;
    }
  }

  // Vertical clamping
  if (height >= workArea.height) {
    // Window taller than work area — pin to top
    y = workArea.y;
  } else {
    // Ensure top edge is not before work area top
    if (y < workArea.y) {
      y = workArea.y;
    }
    // Ensure bottom edge is not past work area bottom
    if (y + height > workArea.y + workArea.height) {
      y = workArea.y + workArea.height - height;
    }
  }

  return { x, y, width, height };
}

// ─── clampSize ────────────────────────────────────────────────────────────────

/**
 * Clamp width/height to min/max size constraints.
 * Pure, idempotent.
 */
export function clampSize(
  width: number,
  height: number,
  constraints: { minWidth: number; minHeight: number; maxWidth: number; maxHeight: number },
): { width: number; height: number } {
  return {
    width: Math.max(constraints.minWidth, Math.min(width, constraints.maxWidth)),
    height: Math.max(constraints.minHeight, Math.min(height, constraints.maxHeight)),
  };
}
