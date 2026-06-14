// Tests for the perceptual-hash helpers.
//
// Property 38 (Requirement 13.2): the perceptual-hash skip is reflexive
// and bounded. Concretely:
//   - For every frame F, hammingDistance(phash(F), phash(F)) === 0.
//   - For every pair of fingerprints (a, b), hammingDistance(a, b) is an
//     integer in [0, 64], and the function is symmetric.
//
// The bound is what makes the OCR-skip threshold in
// `Screen_Capture_Module` well-defined: any θ ≥ 64 makes the skip total,
// any θ ≤ 0 makes it empty. The reflexive guarantee ensures that
// re-hashing an identical frame never produces a phantom "change".

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  hammingDistance,
  phash,
  PHASH_BYTES,
  type ImageDataLike,
} from './phash';

/**
 * Smart generator for `ImageDataLike` frames.
 *
 * Width and height are constrained to 1..32 px so that hundreds of
 * fast-check runs finish in well under a second. The byte-array length
 * is locked to `width * height * 4` so the generator never produces
 * shape-invalid frames that would short-circuit the property under
 * test.
 */
const arbImageData: fc.Arbitrary<ImageDataLike> = fc
  .record({
    width: fc.integer({ min: 1, max: 32 }),
    height: fc.integer({ min: 1, max: 32 }),
  })
  .chain(({ width, height }) =>
    fc
      .uint8Array({
        minLength: width * height * 4,
        maxLength: width * height * 4,
      })
      .map((data): ImageDataLike => ({ data, width, height })),
  );

/** Arbitrary 8-byte fingerprints (any value the hash space can hold). */
const arbHashBytes = fc.uint8Array({
  minLength: PHASH_BYTES,
  maxLength: PHASH_BYTES,
});

describe('phash / hammingDistance', () => {
  // ── Example-based sanity checks ───────────────────────────────────────
  it('produces an 8-byte fingerprint', () => {
    const img: ImageDataLike = {
      data: new Uint8ClampedArray(4),
      width: 1,
      height: 1,
    };
    expect(phash(img)).toHaveLength(PHASH_BYTES);
  });

  it('rejects non-positive frame dimensions', () => {
    expect(() =>
      phash({ data: new Uint8ClampedArray(0), width: 0, height: 1 }),
    ).toThrow();
    expect(() =>
      phash({ data: new Uint8ClampedArray(0), width: 1, height: 0 }),
    ).toThrow();
  });

  it('rejects buffers shorter than width * height * 4', () => {
    expect(() =>
      phash({ data: new Uint8ClampedArray(3), width: 1, height: 1 }),
    ).toThrow();
  });

  it('hammingDistance has well-known fixed-point values', () => {
    const zero = new Uint8Array(PHASH_BYTES);
    const ones = new Uint8Array(PHASH_BYTES).fill(0xff);
    expect(hammingDistance(zero, zero)).toBe(0);
    expect(hammingDistance(ones, ones)).toBe(0);
    expect(hammingDistance(zero, ones)).toBe(64);
  });

  it('rejects fingerprints of the wrong byte length', () => {
    const ok = new Uint8Array(PHASH_BYTES);
    const bad = new Uint8Array(PHASH_BYTES - 1);
    expect(() => hammingDistance(ok, bad)).toThrow();
    expect(() => hammingDistance(bad, ok)).toThrow();
  });

  // ── Property-based tests ──────────────────────────────────────────────

  /**
   * **Validates: Requirements 13.2**
   *
   * Property 38 (reflexive half): phash is deterministic on identical
   * inputs, and the Hamming distance from a fingerprint to itself is
   * zero. Without this guarantee the OCR-skip pipeline would re-run
   * even on frames that have not changed.
   */
  it('Property 38 — phash is deterministic and Hamming-reflexive', () => {
    fc.assert(
      fc.property(arbImageData, (img) => {
        const h1 = phash(img);
        const h2 = phash(img);
        expect(h1).toEqual(h2);
        expect(hammingDistance(h1, h2)).toBe(0);
      }),
    );
  });

  /**
   * **Validates: Requirements 13.2**
   *
   * Property 38 (bounded half): hammingDistance is non-negative,
   * symmetric, and bounded above by 64 for any pair of 8-byte
   * fingerprints. This is what lets the screen-capture module choose
   * a threshold θ ∈ [0, 64] knowing the comparison is total.
   */
  it('Property 38 — hammingDistance is in [0, 64] and symmetric', () => {
    fc.assert(
      fc.property(arbHashBytes, arbHashBytes, (a, b) => {
        const d = hammingDistance(a, b);
        expect(Number.isInteger(d)).toBe(true);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(64);
        expect(hammingDistance(b, a)).toBe(d);
      }),
    );
  });
});
