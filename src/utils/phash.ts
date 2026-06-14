// Perceptual hash and Hamming distance helpers for the Screen_Capture_Module.
//
// The hash is a 64-bit average-hash (aHash) variant:
//   1. The input frame is reduced to an 8×8 grid by box-averaging each cell.
//   2. The 64 luminance samples are averaged.
//   3. Bit `i` of the hash is set when sample `i` is greater-than-or-equal
//      to the grid mean.
//
// aHash is intentionally simple — its goal here is *change detection* before
// running OCR (Requirement 13.2), not forensic similarity. It is fast (no
// DCT), browser-friendly (no extra dependencies), deterministic on identical
// inputs, and produces a 64-bit fingerprint that can be compared via
// `hammingDistance` in O(1) time.

/**
 * Minimal `ImageData`-like shape so this helper works in jsdom, in Web
 * Workers, and in main-thread browser code without depending on the DOM
 * `ImageData` constructor (which jsdom only partially polyfills).
 */
export interface ImageDataLike {
  readonly data: Uint8ClampedArray | Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** 8×8 cells — one bit per cell. */
const HASH_GRID = 8;

/** Byte-length of every fingerprint. 64 bits / 8 = 8 bytes. */
export const PHASH_BYTES = 8;

/**
 * Compute the 64-bit perceptual hash of `image`.
 *
 * The result is returned as a fresh `Uint8Array(8)` so callers can store,
 * compare, or transmit it without worrying about aliasing. Cells are
 * iterated in row-major order; cell `(cx, cy)` occupies bit `cy * 8 + cx`,
 * which lives in `byte = bit >> 3`, `mask = 1 << (bit & 7)`.
 *
 * Throws when `image` has zero width or height — a hash of an empty frame
 * is not meaningful and would otherwise divide by zero.
 */
export function phash(image: ImageDataLike): Uint8Array {
  const { data, width, height } = image;
  if (width <= 0 || height <= 0) {
    throw new Error('phash: image must have positive width and height');
  }
  if (data.length < width * height * 4) {
    throw new Error('phash: image data shorter than width * height * 4');
  }

  // 1. Down-sample to 8×8 by box-averaging the source pixels covered by
  //    each cell. RGB channels are mixed via Rec. 601 luma weights —
  //    matching what humans (and OCR engines) perceive as brightness.
  const samples = new Float64Array(HASH_GRID * HASH_GRID);
  let total = 0;

  for (let cy = 0; cy < HASH_GRID; cy++) {
    const y0 = Math.floor((cy * height) / HASH_GRID);
    // Guarantee at least one pixel per cell row, even on tiny frames where
    // `height < 8` and consecutive `floor` boundaries collide.
    const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * height) / HASH_GRID));
    const yEnd = Math.min(y1, height);

    for (let cx = 0; cx < HASH_GRID; cx++) {
      const x0 = Math.floor((cx * width) / HASH_GRID);
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * width) / HASH_GRID));
      const xEnd = Math.min(x1, width);

      let sum = 0;
      let count = 0;
      for (let y = y0; y < yEnd; y++) {
        for (let x = x0; x < xEnd; x++) {
          const idx = (y * width + x) * 4;
          const luma =
            0.299 * data[idx] +
            0.587 * data[idx + 1] +
            0.114 * data[idx + 2];
          sum += luma;
          count += 1;
        }
      }

      const mean = count > 0 ? sum / count : 0;
      samples[cy * HASH_GRID + cx] = mean;
      total += mean;
    }
  }

  // 2. Bit `i` is set iff sample `i` is at-or-above the grid mean. Using
  //    `>=` (rather than `>`) makes a uniformly-coloured frame hash to
  //    `0xFF…FF`, which is reflexive and Hamming-distance-zero to itself.
  const gridMean = total / samples.length;
  const out = new Uint8Array(PHASH_BYTES);
  for (let i = 0; i < samples.length; i++) {
    if (samples[i] >= gridMean) {
      out[i >> 3] |= 1 << (i & 7);
    }
  }
  return out;
}

/**
 * Bit-level Hamming distance between two 64-bit fingerprints.
 *
 * Returns an integer in `[0, 64]`. Throws when either argument has the
 * wrong byte length so callers cannot accidentally compare hashes from
 * different bit-widths (a silent bug that would defeat the OCR-skip
 * threshold in the screen-capture pipeline).
 */
export function hammingDistance(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== PHASH_BYTES || b.length !== PHASH_BYTES) {
    throw new Error(
      `hammingDistance: both inputs must be ${PHASH_BYTES} bytes`,
    );
  }
  let d = 0;
  for (let i = 0; i < PHASH_BYTES; i++) {
    let x = a[i] ^ b[i];
    // Brian Kernighan popcount: each iteration clears the lowest set bit.
    while (x !== 0) {
      x &= x - 1;
      d += 1;
    }
  }
  return d;
}
