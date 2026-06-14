// ============================================
// Zule AI — Vector Math Helper Tests
// ============================================
//
// Includes example/edge-case unit tests plus the property-based test
// **Property 18 (validates Requirement 6.4)** referenced by tasks.md
// task 2.14:
//
//   For all Float32Array inputs `v` of length n ≥ 1,
//   `dequantize(quantize(v))` is component-wise within `(max(v) - min(v)) / 254`
//   of `v`. The quantized representation occupies one byte per component
//   versus four bytes per component for the input — a strict 4× reduction.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { cosineSimilarity, dequantize, quantize } from './vectorMath';

// ---------------------------------------------------------------------------
// cosineSimilarity — unit tests
// ---------------------------------------------------------------------------

describe('cosineSimilarity (unit)', () => {
  it('is 1 for identical non-zero vectors', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);
  });

  it('is -1 for opposite vectors', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([-1, -2, -3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 6);
  });

  it('is 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 6);
  });

  it('returns 0 (not NaN) when one vector has zero magnitude', () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('returns 0 when both vectors have zero magnitude', () => {
    const a = new Float32Array([0, 0]);
    const b = new Float32Array([0, 0]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('returns 0 when lengths differ', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity(new Float32Array(0), new Float32Array(0))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// quantize / dequantize — unit tests
// ---------------------------------------------------------------------------

describe('quantize / dequantize (unit)', () => {
  it('round-trips a constant vector exactly', () => {
    const v = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    const qv = quantize(v);
    expect(qv.min).toBe(0.5);
    expect(qv.max).toBe(0.5);
    const back = dequantize(qv);
    for (let i = 0; i < v.length; i++) {
      expect(back[i]).toBe(v[i]);
    }
  });

  it('preserves the component-wise extrema after a round-trip', () => {
    const v = new Float32Array([-1, 0, 1]);
    const qv = quantize(v);
    expect(qv.min).toBe(-1);
    expect(qv.max).toBe(1);
    const back = dequantize(qv);
    expect(back[0]).toBeCloseTo(-1, 6);
    expect(back[2]).toBeCloseTo(1, 6);
  });

  it('shrinks storage by exactly 4× (data byteLength only)', () => {
    const v = new Float32Array(64);
    for (let i = 0; i < v.length; i++) v[i] = Math.sin(i);
    const qv = quantize(v);
    expect(qv.data.byteLength).toBe(v.byteLength / 4);
    expect(qv.data.byteLength).toBe(v.length); // 1 byte per component
  });

  it('handles an empty vector without throwing', () => {
    const v = new Float32Array(0);
    const qv = quantize(v);
    expect(qv.data.length).toBe(0);
    expect(dequantize(qv).length).toBe(0);
  });

  it('clamps quantized bytes into [-127, 127]', () => {
    const v = new Float32Array([0, 0.25, 0.5, 0.75, 1]);
    const qv = quantize(v);
    for (const byte of qv.data) {
      expect(byte).toBeGreaterThanOrEqual(-127);
      expect(byte).toBeLessThanOrEqual(127);
    }
    // First and last components hit the bounds exactly.
    expect(qv.data[0]).toBe(-127);
    expect(qv.data[qv.data.length - 1]).toBe(127);
  });
});

// ---------------------------------------------------------------------------
// Property 18: Quantization is approximately reversible and shrinks storage.
// Validates: Requirement 6.4.
//
// Generators:
//   * Length 1..256.
//   * Components are finite Float32 values bounded in [-1e3, 1e3] so that
//     the reconstruction-error budget `(max - min) / 254` is comfortably
//     above f32 round-off noise. Real embedding vectors live in a much
//     tighter range (typically [-1, 1] after L2-normalization), so this
//     bound is generous.
// ---------------------------------------------------------------------------

const finiteFloat32Arb = fc.float({
  noNaN: true,
  noDefaultInfinity: true,
  min: Math.fround(-1e3),
  max: Math.fround(1e3),
});

const float32ArrayArb = fc
  .array(finiteFloat32Arb, { minLength: 1, maxLength: 256 })
  .map((arr) => Float32Array.from(arr));

describe('quantize / dequantize (Property 18)', () => {
  // Validates: Requirement 6.4.
  it('round-trips within (max - min) / 254 per component', () => {
    fc.assert(
      fc.property(float32ArrayArb, (v) => {
        const qv = quantize(v);
        const back = dequantize(qv);

        // Worst-case error is half a quantization step, but Property 18
        // only requires a full-step bound. We add a small epsilon to absorb
        // f32 rounding when min/max are stored back through the Float32Array
        // dequantization output.
        const range = qv.max - qv.min;
        const tolerance = range === 0 ? 0 : range / 254 + 1e-5;

        expect(back.length).toBe(v.length);
        for (let i = 0; i < v.length; i++) {
          expect(Math.abs(back[i] - v[i])).toBeLessThanOrEqual(tolerance);
        }
      }),
      { numRuns: 200 }
    );
  });

  // Validates: Requirement 6.4 — storage shrinks by ≥ 4×.
  it('produces an Int8Array whose byteLength is exactly v.byteLength / 4', () => {
    fc.assert(
      fc.property(float32ArrayArb, (v) => {
        const qv = quantize(v);
        expect(qv.data.byteLength).toBe(v.byteLength / 4);
      }),
      { numRuns: 200 }
    );
  });
});
