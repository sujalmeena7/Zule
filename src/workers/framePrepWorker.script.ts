// ============================================
// Zule AI — Frame Preparation Worker Script
// ============================================
//
// This script runs in a Web Worker context. It receives raw RGBA pixel
// buffers from the main thread, downscales them to ≤1280px longest edge,
// computes a perceptual hash, and encodes the result as JPEG.
//
// Communication protocol:
//   Main → Worker: FramePrepRequest (pixels transferred, not copied)
//   Worker → Main: FramePrepResult
//
// Requirements covered: 5.1, 5.2, 5.3, 5.5, 7.1, 7.2, 7.4

/// <reference lib="webworker" />

const HASH_GRID = 8;
const PHASH_BYTES = 8;
const MAX_LONGEST_EDGE = 1280;

interface WorkerRequest {
  pixels: ArrayBuffer;
  width: number;
  height: number;
  maxKeyframeBytes: number;
  initialQuality: number;
}

interface WorkerResult {
  hash: Uint8Array;
  keyframeBase64: string;
  keyframeBytes: number;
  reEncodeCount: number;
}

/**
 * Compute the 64-bit perceptual hash from raw RGBA pixel data.
 * This is a port of `src/utils/phash.ts` logic for use inside the worker.
 */
function computePhash(data: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  const samples = new Float64Array(HASH_GRID * HASH_GRID);
  let total = 0;

  for (let cy = 0; cy < HASH_GRID; cy++) {
    const y0 = Math.floor((cy * height) / HASH_GRID);
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
          const luma = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
          sum += luma;
          count += 1;
        }
      }

      const mean = count > 0 ? sum / count : 0;
      samples[cy * HASH_GRID + cx] = mean;
      total += mean;
    }
  }

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
 * Downscale dimensions so the longest edge does not exceed maxLongestEdge.
 * Preserves aspect ratio, never upscales.
 */
function downscale(width: number, height: number, maxLongestEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxLongestEdge) {
    return { width, height };
  }
  const scale = maxLongestEdge / longest;
  if (width >= height) {
    return { width: maxLongestEdge, height: Math.max(1, Math.round(height * scale)) };
  }
  return { width: Math.max(1, Math.round(width * scale)), height: maxLongestEdge };
}

/**
 * Encode the pixel data on an OffscreenCanvas as JPEG and return base64.
 * Re-encodes at lower quality if the result exceeds maxBytes.
 * When quality reduction alone isn't sufficient, reduces canvas dimensions
 * by 50% per pass until the limit is satisfied or MAX_REENCODE_PASSES is hit.
 */
async function encodeJpeg(
  pixelData: Uint8ClampedArray,
  width: number,
  height: number,
  initialQuality: number,
  maxBytes: number,
): Promise<{ base64: string; bytes: number; reEncodeCount: number }> {
  const MIN_QUALITY = 0.1;
  const QUALITY_STEP = 0.15;
  const MAX_REENCODE_PASSES = 10;
  const DIMENSION_SCALE_FACTOR = 0.5;

  let currentWidth = width;
  let currentHeight = height;
  let quality = initialQuality;
  let reEncodeCount = 0;

  // Helper: draw pixels onto a canvas and return the canvas
  function createCanvas(pixels: Uint8ClampedArray, w: number, h: number): OffscreenCanvas {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('framePrepWorker: failed to get 2d context on OffscreenCanvas');
    }
    const imageData = new ImageData(pixels as unknown as ImageDataArray, w, h);
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  // Helper: downscale current canvas by the given factor
  function downscaleCanvas(
    srcCanvas: OffscreenCanvas,
    srcW: number,
    srcH: number,
    factor: number,
  ): { canvas: OffscreenCanvas; pixels: Uint8ClampedArray; width: number; height: number } {
    const newW = Math.max(1, Math.round(srcW * factor));
    const newH = Math.max(1, Math.round(srcH * factor));
    const dstCanvas = new OffscreenCanvas(newW, newH);
    const dstCtx = dstCanvas.getContext('2d');
    if (!dstCtx) {
      throw new Error('framePrepWorker: failed to get 2d context for dimension reduction');
    }
    dstCtx.drawImage(srcCanvas, 0, 0, newW, newH);
    const dstPixels = dstCtx.getImageData(0, 0, newW, newH).data;
    return { canvas: dstCanvas, pixels: dstPixels, width: newW, height: newH };
  }

  let canvas = createCanvas(pixelData, currentWidth, currentHeight);

  while (reEncodeCount <= MAX_REENCODE_PASSES) {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = arrayBuffer.byteLength;

    if (bytes <= maxBytes) {
      // Success — convert to base64 and validate JPEG SOI marker
      const uint8 = new Uint8Array(arrayBuffer);
      if (uint8.length < 2 || uint8[0] !== 0xFF || uint8[1] !== 0xD8) {
        throw new Error('framePrepWorker: encoded output is not a valid JPEG (missing SOI marker)');
      }
      let binary = '';
      for (let i = 0; i < uint8.length; i++) {
        binary += String.fromCharCode(uint8[i]);
      }
      const base64 = btoa(binary);
      return { base64, bytes, reEncodeCount };
    }

    // Cap reached — return whatever we have (best effort)
    if (reEncodeCount >= MAX_REENCODE_PASSES) {
      const uint8 = new Uint8Array(arrayBuffer);
      if (uint8.length < 2 || uint8[0] !== 0xFF || uint8[1] !== 0xD8) {
        throw new Error('framePrepWorker: encoded output is not a valid JPEG (missing SOI marker)');
      }
      let binary = '';
      for (let i = 0; i < uint8.length; i++) {
        binary += String.fromCharCode(uint8[i]);
      }
      const base64 = btoa(binary);
      return { base64, bytes, reEncodeCount };
    }

    // Strategy: first reduce quality, then reduce dimensions
    if (quality > MIN_QUALITY) {
      quality = Math.max(MIN_QUALITY, quality - QUALITY_STEP);
    } else {
      // Quality is at minimum — reduce dimensions by 50%
      const scaled = downscaleCanvas(canvas, currentWidth, currentHeight, DIMENSION_SCALE_FACTOR);
      currentWidth = scaled.width;
      currentHeight = scaled.height;
      canvas = scaled.canvas;
      // Reset quality to allow another round of quality reduction at the new size
      quality = initialQuality;
    }
    reEncodeCount++;
  }

  // Should not reach here due to the cap check inside the loop, but safety fallback
  throw new Error('framePrepWorker: re-encode loop exceeded maximum passes');
}

/**
 * Draw source pixels onto a downscaled OffscreenCanvas and return the
 * downscaled pixel data.
 */
function downscalePixels(
  sourceData: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): Uint8ClampedArray {
  const srcCanvas = new OffscreenCanvas(srcWidth, srcHeight);
  const srcCtx = srcCanvas.getContext('2d');
  if (!srcCtx) {
    throw new Error('framePrepWorker: failed to get 2d context for source canvas');
  }

  const srcImageData = new ImageData(
    new Uint8ClampedArray(sourceData.buffer, sourceData.byteOffset, sourceData.byteLength) as unknown as ImageDataArray,
    srcWidth,
    srcHeight,
  );
  srcCtx.putImageData(srcImageData, 0, 0);

  const dstCanvas = new OffscreenCanvas(dstWidth, dstHeight);
  const dstCtx = dstCanvas.getContext('2d');
  if (!dstCtx) {
    throw new Error('framePrepWorker: failed to get 2d context for destination canvas');
  }

  dstCtx.drawImage(srcCanvas, 0, 0, dstWidth, dstHeight);
  return dstCtx.getImageData(0, 0, dstWidth, dstHeight).data;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { pixels, width, height, maxKeyframeBytes, initialQuality } = event.data;

  try {
    const sourcePixels = new Uint8Array(pixels);

    // 1. Downscale to ≤1280px longest edge
    const scaled = downscale(width, height, MAX_LONGEST_EDGE);
    let processedPixels: Uint8ClampedArray;

    if (scaled.width === width && scaled.height === height) {
      // No downscale needed — use source directly
      processedPixels = new Uint8ClampedArray(sourcePixels.buffer, sourcePixels.byteOffset, sourcePixels.byteLength);
    } else {
      // Downscale using OffscreenCanvas
      processedPixels = downscalePixels(sourcePixels, width, height, scaled.width, scaled.height);
    }

    // 2. Compute perceptual hash on the downscaled pixels
    const hash = computePhash(processedPixels, scaled.width, scaled.height);

    // 3. Encode as JPEG with bounded payload
    const { base64, bytes, reEncodeCount } = await encodeJpeg(
      processedPixels,
      scaled.width,
      scaled.height,
      initialQuality,
      maxKeyframeBytes,
    );

    const result: WorkerResult = {
      hash,
      keyframeBase64: base64,
      keyframeBytes: bytes,
      reEncodeCount,
    };

    self.postMessage(result, { transfer: [result.hash.buffer] });
  } catch (error) {
    // Post error back to main thread
    self.postMessage({
      error: error instanceof Error ? error.message : 'Unknown worker error',
    });
  }
};
