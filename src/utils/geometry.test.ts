// ============================================
// Zule AI — Geometry helpers tests
// ============================================
//
// Covers the unit and property-based tests for `clampPosition` and
// `downscaleSize`. Property numbers refer to design.md §"Correctness
// Properties".
//
// Tests are structured as:
//   1. Unit tests: small, exhaustive examples that pin down the contract.
//   2. Property tests: fast-check generators that exercise the contract
//      across the full input space.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { clampPosition, downscaleSize } from './geometry';

// ---------------------------------------------------------------------
// clampPosition — unit tests
// ---------------------------------------------------------------------

describe('clampPosition', () => {
  const viewport = { viewportWidth: 1000, viewportHeight: 800 };

  it('returns the input position when the rect already fits inside the viewport', () => {
    const result = clampPosition(
      { x: 100, y: 200, width: 300, height: 100 },
      viewport,
    );
    expect(result).toEqual({ x: 100, y: 200 });
  });

  it('clamps a negative x/y up to (0, 0)', () => {
    const result = clampPosition(
      { x: -50, y: -25, width: 300, height: 100 },
      viewport,
    );
    expect(result).toEqual({ x: 0, y: 0 });
  });

  it('clamps an over-extending position down to the viewport boundary', () => {
    const result = clampPosition(
      { x: 9999, y: 9999, width: 300, height: 100 },
      viewport,
    );
    // 1000 - 300 = 700, 800 - 100 = 700
    expect(result).toEqual({ x: 700, y: 700 });
  });

  it('pins to the top-left when the element is wider than the viewport', () => {
    // Graceful degradation rather than NaN/negative bounds.
    const result = clampPosition(
      { x: 50, y: 50, width: 1500, height: 50 },
      viewport,
    );
    expect(result).toEqual({ x: 0, y: 50 });
  });

  it('coerces NaN to 0 and lets ±Infinity clamp to the viewport boundary', () => {
    const result = clampPosition(
      { x: Number.NaN, y: Number.POSITIVE_INFINITY, width: 200, height: 100 },
      viewport,
    );
    // x: NaN -> 0 (then clamp keeps it at 0 since 0 is in range)
    // y: +Infinity -> Math.min(Infinity, 700) = 700
    expect(result).toEqual({ x: 0, y: 700 });
  });

  it('is idempotent — clamping twice equals clamping once', () => {
    const rect = { x: 9999, y: -50, width: 300, height: 100 };
    const once = clampPosition(rect, viewport);
    const twice = clampPosition({ ...rect, ...once }, viewport);
    expect(twice).toEqual(once);
  });
});

// ---------------------------------------------------------------------
// clampPosition — property tests
// ---------------------------------------------------------------------
//
// Property 34: Position clamp keeps the overlay on-screen.
// Validates: Requirements 12.3, 18.4
//
// For all `(x, y, viewportW, viewportH, elemW, elemH)` with
// `viewportW >= elemW > 0` and `viewportH >= elemH > 0`,
// `clampPosition({x, y, width, height}, {viewportWidth, viewportHeight})`
// returns `{cx, cy}` with `0 <= cx <= viewportW - elemW` and
// `0 <= cy <= viewportH - elemH`. The clamp is idempotent:
// `clamp(clamp(p)) === clamp(p)`.

describe('clampPosition — Property 34: keeps overlay on-screen and is idempotent', () => {
  it('clamped position lies within the viewport and is idempotent', () => {
    fc.assert(
      fc.property(
        // Position the user is trying to set — can be wildly out of range.
        fc.integer({ min: -100_000, max: 100_000 }),
        fc.integer({ min: -100_000, max: 100_000 }),
        // Viewport / element sizes — generated jointly so that
        // viewport >= element (the non-degenerate precondition).
        fc.tuple(
          fc.integer({ min: 1, max: 5000 }),
          fc.integer({ min: 1, max: 5000 }),
        ).chain(([w, h]) =>
          fc.tuple(
            fc.constant(w),
            fc.constant(h),
            fc.integer({ min: w, max: w + 5000 }),
            fc.integer({ min: h, max: h + 5000 }),
          ),
        ),
        (x, y, [width, height, viewportWidth, viewportHeight]) => {
          const rect = { x, y, width, height };
          const viewport = { viewportWidth, viewportHeight };

          const clamped = clampPosition(rect, viewport);

          // 1. On-screen invariant.
          expect(clamped.x).toBeGreaterThanOrEqual(0);
          expect(clamped.y).toBeGreaterThanOrEqual(0);
          expect(clamped.x).toBeLessThanOrEqual(viewportWidth - width);
          expect(clamped.y).toBeLessThanOrEqual(viewportHeight - height);

          // 2. Idempotence: clamping the result yields the result.
          const twice = clampPosition(
            { ...rect, x: clamped.x, y: clamped.y },
            viewport,
          );
          expect(twice).toEqual(clamped);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------
// downscaleSize — unit tests
// ---------------------------------------------------------------------

describe('downscaleSize', () => {
  it('returns the input dimensions when already within the bound', () => {
    expect(downscaleSize({ width: 800, height: 600 }, 1280)).toEqual({
      width: 800,
      height: 600,
    });
  });

  it('downscales a 4K landscape frame to a 1280-pixel longest edge', () => {
    const result = downscaleSize({ width: 3840, height: 2160 }, 1280);
    expect(result.width).toBe(1280);
    // 2160 * 1280 / 3840 = 720
    expect(result.height).toBe(720);
  });

  it('downscales a portrait frame symmetrically', () => {
    const result = downscaleSize({ width: 2160, height: 3840 }, 1280);
    expect(result.height).toBe(1280);
    expect(result.width).toBe(720);
  });

  it('keeps a square frame square after downscaling', () => {
    expect(downscaleSize({ width: 2000, height: 2000 }, 500)).toEqual({
      width: 500,
      height: 500,
    });
  });

  it('never upscales a small frame', () => {
    expect(downscaleSize({ width: 100, height: 50 }, 1280)).toEqual({
      width: 100,
      height: 50,
    });
  });

  it('clamps the smaller dimension to at least 1 pixel', () => {
    // Extreme aspect ratio: longest edge gets clamped, shortest would
    // round to 0 but is floored at 1.
    const result = downscaleSize({ width: 1000, height: 1 }, 10);
    expect(result.width).toBe(10);
    expect(result.height).toBe(1);
  });

  it('rejects non-positive or non-finite inputs', () => {
    expect(() => downscaleSize({ width: 0, height: 100 }, 1280)).toThrow(RangeError);
    expect(() => downscaleSize({ width: 100, height: -1 }, 1280)).toThrow(RangeError);
    expect(() => downscaleSize({ width: 100, height: 100 }, 0)).toThrow(RangeError);
    expect(() => downscaleSize({ width: Number.NaN, height: 100 }, 1280)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------
// downscaleSize — property tests
// ---------------------------------------------------------------------
//
// Property 37: Downscale preserves aspect ratio and the longest-edge bound.
// Validates: Requirements 13.1
//
// For all `(w, h, maxEdge)` with `w > 0`, `h > 0`, `maxEdge > 0`:
//   1. max(w', h') <= maxEdge (longest-edge bound).
//   2. |w'/h' - w/h| <= 1 / min(w', h') (aspect ratio within rounding).
//   3. The function is idempotent for inputs already within `maxEdge`.
//   4. The function never upscales: w' <= w and h' <= h.

describe('downscaleSize — Property 37: preserves aspect ratio and longest-edge bound', () => {
  it('respects longest-edge bound, preserves aspect ratio, never upscales, and is idempotent in-bounds', () => {
    fc.assert(
      fc.property(
        // Generate (width, height, maxEdge) jointly so that
        //   1. the aspect ratio max(w,h) / min(w,h) <= 2:1, and
        //   2. the smaller scaled dimension rounds to >= 1.
        // Both constraints are needed for the design's stated tolerance
        // `1 / min(w', h')` to be mathematically achievable under integer-
        // pixel rounding. Beyond a 2:1 aspect ratio the rounding error
        // in the smaller dimension scales linearly with the ratio and
        // can exceed `1 / min(w', h')`; that is a property of integer
        // rasterisation, not of the implementation, so the test stays
        // inside the regime the design specifies.
        fc.tuple(
          fc.integer({ min: 1, max: 4096 }),
          fc.integer({ min: 1, max: 4096 }),
        )
          .filter(([w, h]) => Math.max(w, h) / Math.min(w, h) <= 2)
          .chain(([w, h]) => {
            const longest = Math.max(w, h);
            const shortest = Math.min(w, h);
            // shortest * (maxEdge / longest) >= 0.5 (so it rounds to >= 1).
            const minMaxEdge = Math.max(1, Math.ceil(longest / (2 * shortest)));
            return fc.tuple(
              fc.constant(w),
              fc.constant(h),
              fc.integer({ min: minMaxEdge, max: 8192 }),
            );
          }),
        ([width, height, maxLongestEdge]) => {
          const result = downscaleSize({ width, height }, maxLongestEdge);

          // 1. Longest-edge bound.
          expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(maxLongestEdge);

          // 2. Aspect ratio preserved within the rounding tolerance.
          //    Both result dimensions are guaranteed to be >= 1.
          expect(result.width).toBeGreaterThanOrEqual(1);
          expect(result.height).toBeGreaterThanOrEqual(1);
          const targetRatio = width / height;
          const actualRatio = result.width / result.height;
          const tolerance = 1 / Math.min(result.width, result.height);
          expect(Math.abs(actualRatio - targetRatio)).toBeLessThanOrEqual(tolerance);

          // 3. Never upscales.
          expect(result.width).toBeLessThanOrEqual(width);
          expect(result.height).toBeLessThanOrEqual(height);

          // 4. Idempotent for inputs already within the bound.
          if (Math.max(width, height) <= maxLongestEdge) {
            const again = downscaleSize(result, maxLongestEdge);
            expect(again).toEqual(result);
          }

          // 4b. Idempotent on the OUTPUT: applying the function to the
          //     already-downscaled size returns the same size, since
          //     the output is now within the bound by construction.
          const reapplied = downscaleSize(result, maxLongestEdge);
          expect(reapplied).toEqual(result);
        },
      ),
    );
  });
});
