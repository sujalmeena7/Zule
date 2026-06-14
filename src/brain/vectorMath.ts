// ============================================
// Zule AI — Vector Math Helpers
// ============================================
//
// Pure helpers used by Vector_Index, Response_Cache, and Memory_Store:
//   * cosineSimilarity(a, b) — bounded in [-1, 1], returns 0 on degenerate
//     inputs (mismatched lengths or a zero-magnitude vector) so callers never
//     see `NaN` even when the embedding model emits an all-zero vector.
//   * quantize(v) — int8 quantization with per-vector `min`/`max` metadata,
//     mapping values from [min, max] linearly onto [-127, 127]. The result
//     occupies one byte per component, achieving the ≥ 4× storage reduction
//     called out by Requirement 6.4 versus a Float32Array.
//   * dequantize(qv) — the inverse mapping, returning a Float32Array within
//     a half-LSB of the original (worst case `(max - min) / 254`).
//
// Validated by:
//   * Property 18 (validates Requirement 6.4) — see vectorMath.test.ts.
//
// Design references:
//   * design.md §"Components and Interfaces — 7. Vector_Index" specifies the
//     `cosineSimilarity(a: Float32Array, b: Float32Array): number` signature
//     and the int8 quantization scheme with per-vector min/max metadata.
//   * design.md "Property 18" pins the per-component error bound at
//     `(max(v) - min(v)) / 254` and the storage bound at `n + 8` bytes.

/**
 * The compact, per-vector serialization produced by {@link quantize}.
 *
 * `data` holds one signed byte per component in the range [-127, 127];
 * `min` and `max` are the original component-wise extrema, stored at full
 * precision so `dequantize` can reconstruct the affine mapping exactly.
 */
export interface QuantizedVector {
  data: Int8Array;
  min: number;
  max: number;
}

/**
 * Cosine similarity between two equal-length vectors.
 *
 * Returns 0 when:
 *   - the vectors have different lengths,
 *   - either vector is empty, or
 *   - either vector has zero magnitude (avoids `NaN` from a 0/0 division).
 *
 * Otherwise returns `dot(a, b) / (|a| * |b|)`, which is mathematically
 * bounded in `[-1, 1]`. Floating-point round-off can in principle land a
 * hair outside that interval; callers that need the strict bound should
 * clamp the result.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Quantize a Float32Array to int8 with per-vector min/max metadata.
 *
 * The mapping is linear from `[min, max]` onto `[-127, 127]`:
 *
 *   q(v) = round((v - min) / (max - min) * 254 - 127)
 *
 * Edge cases:
 *   - An empty input returns `{ data: empty, min: 0, max: 0 }`.
 *   - A constant input (`min === max`) returns all-zero `data`; `dequantize`
 *     reads back the constant value exactly.
 *   - The output is always clamped into `[-127, 127]` so that no byte ever
 *     stores `-128`. This keeps the representation symmetric and lets
 *     callers reason about the quantized range without considering the
 *     two's-complement asymmetry.
 *
 * Storage: `data.byteLength === vector.length` (one byte per component),
 * versus `vector.byteLength === vector.length * 4` for the Float32Array
 * input — a 4× reduction excluding the small per-vector min/max overhead.
 */
export function quantize(vector: Float32Array): QuantizedVector {
  const n = vector.length;
  if (n === 0) {
    return { data: new Int8Array(0), min: 0, max: 0 };
  }

  let min = vector[0];
  let max = vector[0];
  for (let i = 1; i < n; i++) {
    const v = vector[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const data = new Int8Array(n);

  // Constant vector: every component round-trips exactly through `min`.
  if (max === min) {
    return { data, min, max };
  }

  const range = max - min;
  for (let i = 0; i < n; i++) {
    const normalized = (vector[i] - min) / range; // in [0, 1]
    let q = Math.round(normalized * 254 - 127);
    if (q > 127) q = 127;
    if (q < -127) q = -127;
    data[i] = q;
  }

  return { data, min, max };
}

/**
 * Inverse of {@link quantize}.
 *
 * Reconstructs a Float32Array within `(max - min) / 254` per component
 * (half-LSB worst case is `(max - min) / 508`; the bound advertised by
 * Property 18 is the conservative full-LSB figure).
 *
 * For a constant input (`min === max`) every component decodes to the
 * stored constant exactly.
 */
export function dequantize(qv: QuantizedVector): Float32Array {
  const { data, min, max } = qv;
  const out = new Float32Array(data.length);

  if (data.length === 0) return out;

  if (max === min) {
    out.fill(min);
    return out;
  }

  const range = max - min;
  for (let i = 0; i < data.length; i++) {
    out[i] = ((data[i] + 127) / 254) * range + min;
  }
  return out;
}
