// ============================================
// Zule AI — Geometry helpers
// ============================================
//
// Pure, framework-free helpers used by the floating overlay and the
// screen-capture pipeline. Both functions are intentionally synchronous
// and free of side effects so that they can be unit-tested and
// property-tested in isolation.
//
// Covered acceptance criteria:
//   - 12.3 — re-clamp the overlay so it stays fully on-screen after the
//     viewport changes.
//   - 13.1 — downscale screen frames to a maximum 1280-pixel longest
//     edge before they reach the OCR worker.
//   - 18.4 — keyboard repositioning of the overlay (the same clamp keeps
//     8-direction nudges and "recenter" inside the viewport).

/**
 * Rectangle of the overlay (or any element) being positioned.
 * `x` and `y` are the desired top-left coordinates in CSS pixels.
 */
export interface PositionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Viewport dimensions, typically `window.innerWidth` / `window.innerHeight`.
 */
export interface Viewport {
  viewportWidth: number;
  viewportHeight: number;
}

/**
 * Two-dimensional pixel size.
 */
export interface Size {
  width: number;
  height: number;
}

/**
 * Clamp a rectangle's top-left position so the rectangle stays fully
 * inside the viewport.
 *
 * Returns `{ x, y }` such that
 *   `0 <= x <= max(0, viewportWidth - width)` and
 *   `0 <= y <= max(0, viewportHeight - height)`.
 *
 * The function is idempotent: `clamp(clamp(p)) === clamp(p)`.
 *
 * Edge cases:
 *   - If the rectangle is wider than the viewport (or taller), the
 *     corresponding upper bound collapses to 0 and the rectangle is
 *     pinned to the top-left so the user can still see it. The clamp
 *     remains idempotent in that case.
 *   - `NaN` inputs are coerced to `0` so the overlay never disappears
 *     off-screen due to a degenerate value. `±Infinity` inputs flow
 *     through the normal min/max clamping and resolve to a valid
 *     boundary position.
 */
export function clampPosition(
  rect: PositionRect,
  viewport: Viewport,
): { x: number; y: number } {
  const x = nanToZero(rect.x);
  const y = nanToZero(rect.y);
  const width = Math.max(0, nanToZero(rect.width));
  const height = Math.max(0, nanToZero(rect.height));
  const vw = Math.max(0, nanToZero(viewport.viewportWidth));
  const vh = Math.max(0, nanToZero(viewport.viewportHeight));

  const maxX = Math.max(0, vw - width);
  const maxY = Math.max(0, vh - height);

  return {
    x: clampScalar(x, 0, maxX),
    y: clampScalar(y, 0, maxY),
  };
}

/**
 * Downscale `(width, height)` so that the longest edge does not exceed
 * `maxLongestEdge`, preserving the aspect ratio (within integer-rounding
 * tolerance) and never upscaling.
 *
 * If the input already fits (`max(width, height) <= maxLongestEdge`),
 * the original integer dimensions are returned unchanged, making the
 * function idempotent for inputs already within the bound.
 *
 * Both output dimensions are clamped to a minimum of 1 pixel so that
 * downstream consumers (canvas, OCR) never receive a zero-area image.
 *
 * @throws RangeError if `maxLongestEdge <= 0` or any dimension is non-positive / non-finite.
 */
export function downscaleSize(
  size: Size,
  maxLongestEdge: number,
): { width: number; height: number } {
  const w = size.width;
  const h = size.height;

  if (!Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(maxLongestEdge)) {
    throw new RangeError('downscaleSize: width, height, and maxLongestEdge must be finite numbers');
  }
  if (w <= 0 || h <= 0) {
    throw new RangeError('downscaleSize: width and height must be > 0');
  }
  if (maxLongestEdge <= 0) {
    throw new RangeError('downscaleSize: maxLongestEdge must be > 0');
  }

  const longest = Math.max(w, h);

  // Already within the bound — return integer-rounded original size so
  // that the function is idempotent and never upscales.
  if (longest <= maxLongestEdge) {
    return {
      width: Math.max(1, Math.round(w)),
      height: Math.max(1, Math.round(h)),
    };
  }

  const scale = maxLongestEdge / longest;
  // Pin the longest edge to `maxLongestEdge` exactly, sidestepping any
  // float-precision drift in `w * scale` (which can yield e.g.
  // 792.999... -> Math.floor = 792 even when w === longest). The other
  // edge is rounded so we stay as close to the original aspect ratio
  // as integer pixels allow.
  let scaledW: number;
  let scaledH: number;
  if (w >= h) {
    scaledW = maxLongestEdge;
    scaledH = Math.round(h * scale);
  } else {
    scaledH = maxLongestEdge;
    scaledW = Math.round(w * scale);
  }

  return {
    width: Math.max(1, scaledW),
    height: Math.max(1, scaledH),
  };
}

// --- internal helpers -------------------------------------------------

function clampScalar(value: number, min: number, max: number): number {
  if (max < min) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function nanToZero(value: number): number {
  return Number.isNaN(value) ? 0 : value;
}
