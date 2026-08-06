// ============================================
// Zule AI — Frame Preparation Worker API
// ============================================
//
// Main-thread interface to the FramePrepWorker. Delegates phash computation
// and JPEG encoding to a Web Worker using OffscreenCanvas when available,
// and falls back to synchronous main-thread computation otherwise.
//
// Requirements covered:
//   - 5.1: No more than 50ms synchronous main-thread work for frame prep
//   - 5.2: Frame_Hash without synchronous main-thread pass over full-res buffer
//   - 5.3: Keyframe encoding without synchronous main-thread encode
//   - 5.5: Synchronous fallback when off-thread unavailable

import { phash, type ImageDataLike } from '../utils/phash';
import { downscaleSize } from '../utils/geometry';
import { telemetry } from '../brain/telemetry';

/** Maximum longest edge in pixels for downscaling. */
const MAX_LONGEST_EDGE = 1280;

/** Minimum JPEG quality floor during re-encoding. */
const MIN_QUALITY = 0.1;

/** Quality reduction per re-encode pass. */
const QUALITY_STEP = 0.15;

// ---- Public interfaces ----

export interface FramePrepRequest {
  /** Raw RGBA pixel buffer transferred from the main thread. */
  pixels: ArrayBuffer;
  width: number;
  height: number;
  /** Max byte length for JPEG output. */
  maxKeyframeBytes: number;
  /** Initial JPEG quality (0–1). */
  initialQuality: number;
}

export interface FramePrepResult {
  /** 8-byte perceptual hash. */
  hash: Uint8Array;
  /** Base64-encoded JPEG (stripped of data URI prefix). */
  keyframeBase64: string;
  /** Final encoded byte length. */
  keyframeBytes: number;
  /** Number of re-encode passes (0 = first pass was within budget). */
  reEncodeCount: number;
}

// ---- Feature detection ----

/** Cached result of feature detection. */
let _offThreadAvailable: boolean | null = null;

/**
 * Returns true if the current runtime supports off-main-thread frame prep.
 *
 * Checks for:
 *   - `Worker` constructor availability
 *   - `OffscreenCanvas` constructor availability
 *   - `OffscreenCanvas.convertToBlob` method (needed for JPEG encoding)
 */
export function isOffThreadAvailable(): boolean {
  if (_offThreadAvailable !== null) return _offThreadAvailable;

  try {
    const hasWorker = typeof Worker !== 'undefined';
    const hasOffscreenCanvas = typeof OffscreenCanvas !== 'undefined';
    const hasConvertToBlob =
      hasOffscreenCanvas &&
      typeof OffscreenCanvas.prototype.convertToBlob === 'function';

    _offThreadAvailable = hasWorker && hasOffscreenCanvas && hasConvertToBlob;
  } catch {
    _offThreadAvailable = false;
  }

  return _offThreadAvailable;
}

/**
 * Reset the cached feature detection (for testing).
 * @internal
 */
export function _resetOffThreadDetection(): void {
  _offThreadAvailable = null;
}

/**
 * Override the off-thread availability flag (for testing).
 * @internal
 */
export function _setOffThreadAvailable(value: boolean | null): void {
  _offThreadAvailable = value;
}

// ---- Worker instance management ----

let workerInstance: Worker | null = null;

function getWorker(): Worker {
  if (!workerInstance) {
    workerInstance = new Worker(
      new URL('./framePrepWorker.script.ts', import.meta.url),
      { type: 'module' },
    );
  }
  return workerInstance;
}

/**
 * Terminate the worker instance. Called during cleanup/teardown.
 */
export function terminateFramePrepWorker(): void {
  if (workerInstance) {
    workerInstance.terminate();
    workerInstance = null;
  }
}

// ---- Off-thread path ----

function prepareFrameOffThread(req: FramePrepRequest): Promise<FramePrepResult> {
  return new Promise((resolve, reject) => {
    const worker = getWorker();

    const handler = (event: MessageEvent) => {
      worker.removeEventListener('message', handler);
      worker.removeEventListener('error', errorHandler);

      if (event.data.error) {
        reject(new Error(event.data.error));
        return;
      }

      const result: FramePrepResult = {
        hash: event.data.hash instanceof Uint8Array
          ? event.data.hash
          : new Uint8Array(event.data.hash),
        keyframeBase64: event.data.keyframeBase64,
        keyframeBytes: event.data.keyframeBytes,
        reEncodeCount: event.data.reEncodeCount,
      };

      // Emit telemetry when off-thread re-encoding occurred (Req 9.4)
      if (result.reEncodeCount > 0) {
        telemetry.emit({
          kind: 'screen.keyframeReencode',
          passes: result.reEncodeCount,
          finalBytes: result.keyframeBytes,
        });
      }

      resolve(result);
    };

    const errorHandler = (event: ErrorEvent) => {
      worker.removeEventListener('message', handler);
      worker.removeEventListener('error', errorHandler);
      reject(new Error(`Worker error: ${event.message}`));
    };

    worker.addEventListener('message', handler);
    worker.addEventListener('error', errorHandler);

    // Transfer the pixel buffer to avoid copy overhead
    worker.postMessage(
      {
        pixels: req.pixels,
        width: req.width,
        height: req.height,
        maxKeyframeBytes: req.maxKeyframeBytes,
        initialQuality: req.initialQuality,
      },
      [req.pixels],
    );
  });
}

// ---- JPEG validation helper ----

/**
 * Validates that a base64-encoded string decodes to bytes starting with
 * the JPEG SOI marker (0xFF 0xD8). Throws if invalid.
 */
function validateJpegSoi(base64: string): void {
  // Decode the first 2 bytes from the base64 string
  // We only need the first few characters of base64 to check the first 2 bytes
  const firstChunk = atob(base64.slice(0, 4)); // 4 base64 chars = 3 bytes
  if (
    firstChunk.length < 2 ||
    firstChunk.charCodeAt(0) !== 0xFF ||
    firstChunk.charCodeAt(1) !== 0xD8
  ) {
    throw new Error('framePrepWorker: encoded output is not a valid JPEG (missing SOI marker)');
  }
}

// ---- Synchronous fallback path ----

/**
 * Synchronous fallback for environments where OffscreenCanvas or Worker
 * is unavailable. Performs all work on the main thread using a regular
 * canvas element.
 */
async function prepareFrameSync(req: FramePrepRequest): Promise<FramePrepResult> {
  const { pixels, width, height, maxKeyframeBytes, initialQuality } = req;
  const sourceData = new Uint8Array(pixels);

  // 1. Downscale dimensions
  const scaled = downscaleSize({ width, height }, MAX_LONGEST_EDGE);

  // 2. Draw onto canvas and get downscaled pixels
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = width;
  srcCanvas.height = height;
  const srcCtx = srcCanvas.getContext('2d');
  if (!srcCtx) {
    throw new Error('framePrepWorker fallback: failed to get 2d context');
  }

  const srcImageData = new ImageData(
    new Uint8ClampedArray(sourceData.buffer, sourceData.byteOffset, sourceData.byteLength),
    width,
    height,
  );
  srcCtx.putImageData(srcImageData, 0, 0);

  let processedCanvas: HTMLCanvasElement;
  let processedImageData: ImageData;

  if (scaled.width === width && scaled.height === height) {
    processedCanvas = srcCanvas;
    processedImageData = srcImageData;
  } else {
    processedCanvas = document.createElement('canvas');
    processedCanvas.width = scaled.width;
    processedCanvas.height = scaled.height;
    const dstCtx = processedCanvas.getContext('2d');
    if (!dstCtx) {
      throw new Error('framePrepWorker fallback: failed to get dst 2d context');
    }
    dstCtx.drawImage(srcCanvas, 0, 0, scaled.width, scaled.height);
    processedImageData = dstCtx.getImageData(0, 0, scaled.width, scaled.height);
  }

  // 3. Compute perceptual hash on downscaled pixels
  const hashInput: ImageDataLike = {
    data: processedImageData.data,
    width: scaled.width,
    height: scaled.height,
  };
  const hash = phash(hashInput);

  // 4. Encode as JPEG with bounded payload
  const MAX_REENCODE_PASSES = 10;
  const DIMENSION_SCALE_FACTOR = 0.5;
  let quality = initialQuality;
  let reEncodeCount = 0;
  let currentCanvas = processedCanvas;
  let currentWidth = processedCanvas.width;
  let currentHeight = processedCanvas.height;

  while (reEncodeCount <= MAX_REENCODE_PASSES) {
    const dataUrl = currentCanvas.toDataURL('image/jpeg', quality);
    const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');
    const bytes = Math.ceil((base64.length * 3) / 4); // approximate decoded byte length

    if (bytes <= maxKeyframeBytes) {
      // Validate JPEG SOI marker (0xFF 0xD8)
      validateJpegSoi(base64);
      // Emit telemetry when re-encoding occurred (Req 9.4)
      if (reEncodeCount > 0) {
        telemetry.emit({
          kind: 'screen.keyframeReencode',
          passes: reEncodeCount,
          finalBytes: bytes,
        });
      }
      return {
        hash,
        keyframeBase64: base64,
        keyframeBytes: bytes,
        reEncodeCount,
      };
    }

    // Cap reached — return best-effort result
    if (reEncodeCount >= MAX_REENCODE_PASSES) {
      validateJpegSoi(base64);
      // Emit telemetry for capped re-encode (Req 9.4)
      telemetry.emit({
        kind: 'screen.keyframeReencode',
        passes: reEncodeCount,
        finalBytes: bytes,
      });
      return {
        hash,
        keyframeBase64: base64,
        keyframeBytes: bytes,
        reEncodeCount,
      };
    }

    // Strategy: first reduce quality, then reduce dimensions
    if (quality > MIN_QUALITY) {
      quality = Math.max(MIN_QUALITY, quality - QUALITY_STEP);
    } else {
      // Quality is at minimum — reduce dimensions by 50%
      const newWidth = Math.max(1, Math.round(currentWidth * DIMENSION_SCALE_FACTOR));
      const newHeight = Math.max(1, Math.round(currentHeight * DIMENSION_SCALE_FACTOR));
      const smallerCanvas = document.createElement('canvas');
      smallerCanvas.width = newWidth;
      smallerCanvas.height = newHeight;
      const smallerCtx = smallerCanvas.getContext('2d');
      if (!smallerCtx) {
        throw new Error('framePrepWorker fallback: failed to get context for dimension reduction');
      }
      smallerCtx.drawImage(currentCanvas, 0, 0, newWidth, newHeight);
      currentCanvas = smallerCanvas;
      currentWidth = newWidth;
      currentHeight = newHeight;
      // Reset quality for another round of quality reduction at the new size
      quality = initialQuality;
    }
    reEncodeCount++;
  }

  // Should not reach here due to the cap check inside the loop
  throw new Error('framePrepWorker fallback: re-encode loop exceeded maximum passes');
}

// ---- Public API ----

/**
 * Posts a FramePrepRequest to the worker and resolves with the result.
 * Falls back to synchronous main-thread computation when OffscreenCanvas
 * or Worker is unavailable.
 */
export function prepareFrame(req: FramePrepRequest): Promise<FramePrepResult> {
  if (isOffThreadAvailable()) {
    return prepareFrameOffThread(req);
  }
  return prepareFrameSync(req);
}
