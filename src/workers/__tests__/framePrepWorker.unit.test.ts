// ============================================
// Zule AI — FramePrepWorker Unit Tests
// ============================================
//
// Unit tests for the FramePrepWorker synchronous fallback path.
// Since we run in Node/vitest without real DOM/Canvas/OffscreenCanvas,
// we mock `document.createElement('canvas')` and force the sync fallback
// path via `_setOffThreadAvailable(false)`.
//
// Requirements covered:
//   - 5.2: Frame_Hash without synchronous main-thread pass over full-res buffer
//   - 5.3: Keyframe encoding without synchronous main-thread encode
//   - 7.1: Keyframe payload bounded
//   - 7.4: Keyframe is valid base64 JPEG

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { phash, type ImageDataLike } from '../../utils/phash';

// Polyfill ImageData for Node/vitest environment (not available outside browser)
if (typeof globalThis.ImageData === 'undefined') {
  (globalThis as any).ImageData = class ImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    constructor(dataOrWidth: Uint8ClampedArray | number, widthOrHeight: number, height?: number) {
      if (dataOrWidth instanceof Uint8ClampedArray) {
        this.data = dataOrWidth;
        this.width = widthOrHeight;
        this.height = height ?? (dataOrWidth.length / (widthOrHeight * 4));
      } else {
        this.width = dataOrWidth;
        this.height = widthOrHeight;
        this.data = new Uint8ClampedArray(this.width * this.height * 4);
      }
    }
  };
}

// We need to mock document.createElement before importing the module under test.
// The mock produces canvas objects with controllable toDataURL output.

/** A small valid JPEG: SOI marker (0xFF 0xD8) + some filler + EOI (0xFF 0xD9). */
function makeJpegBase64(byteLength: number): string {
  const bytes = new Uint8Array(Math.max(4, byteLength));
  bytes[0] = 0xFF;
  bytes[1] = 0xD8;
  // Fill with arbitrary content
  for (let i = 2; i < bytes.length - 2; i++) {
    bytes[i] = 0x00;
  }
  bytes[bytes.length - 2] = 0xFF;
  bytes[bytes.length - 1] = 0xD9;
  // Convert to base64
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Build a data URL from base64, mimicking canvas toDataURL output. */
function jpegDataUrl(base64: string): string {
  return `data:image/jpeg;base64,${base64}`;
}

/**
 * Create a uniform RGBA pixel buffer (all pixels the same color).
 */
function makeUniformPixels(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
  a = 255,
): ArrayBuffer {
  const buf = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = a;
  }
  return buf.buffer;
}


/**
 * Create a pattern pixel buffer (gradient-like) for testing hash differentiation.
 */
function makePatternPixels(width: number, height: number): ArrayBuffer {
  const buf = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      buf[i] = (x * 255) / width;        // R gradient
      buf[i + 1] = (y * 255) / height;    // G gradient
      buf[i + 2] = 128;                   // B constant
      buf[i + 3] = 255;                   // A opaque
    }
  }
  return buf.buffer;
}

// ---- Mock canvas infrastructure ----

interface MockCanvasContext {
  putImageData: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
  getImageData: ReturnType<typeof vi.fn>;
  _pixelData: Uint8ClampedArray | null;
  _width: number;
  _height: number;
}

interface MockCanvas {
  width: number;
  height: number;
  getContext: ReturnType<typeof vi.fn>;
  toDataURL: ReturnType<typeof vi.fn>;
  _ctx: MockCanvasContext;
}

/**
 * Track what the toDataURL mock should return based on quality.
 * This allows us to simulate the re-encode loop behavior where lower
 * quality produces smaller output.
 */
let toDataURLBehavior: {
  /** Base size in bytes for quality=1.0 */
  baseSizeBytes: number;
  /** If true, size scales linearly with quality */
  scaleWithQuality: boolean;
} = { baseSizeBytes: 500, scaleWithQuality: false };

function createMockCanvas(sourcePixelData?: Uint8ClampedArray): MockCanvas {
  const ctx: MockCanvasContext = {
    putImageData: vi.fn(),
    drawImage: vi.fn(),
    getImageData: vi.fn(),
    _pixelData: sourcePixelData ?? null,
    _width: 0,
    _height: 0,
  };

  const canvas: MockCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn().mockReturnValue(ctx),
    toDataURL: vi.fn(),
    _ctx: ctx,
  };

  // getImageData returns data based on the canvas dimensions
  ctx.getImageData = vi.fn().mockImplementation(
    (_x: number, _y: number, w: number, h: number) => {
      // If we have source pixel data and dimensions match, use it
      if (ctx._pixelData && w * h * 4 === ctx._pixelData.length) {
        return { data: ctx._pixelData, width: w, height: h };
      }
      // Otherwise generate uniform gray pixels for the requested size
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        data[i * 4] = 128;
        data[i * 4 + 1] = 128;
        data[i * 4 + 2] = 128;
        data[i * 4 + 3] = 255;
      }
      return { data, width: w, height: h };
    },
  );

  // toDataURL: generate JPEG data URLs with size varying by quality
  canvas.toDataURL = vi.fn().mockImplementation(
    (_type: string, quality: number) => {
      let sizeBytes = toDataURLBehavior.baseSizeBytes;
      if (toDataURLBehavior.scaleWithQuality) {
        // Lower quality → smaller output (linear approximation)
        sizeBytes = Math.max(4, Math.round(sizeBytes * quality));
      }
      const base64 = makeJpegBase64(sizeBytes);
      return jpegDataUrl(base64);
    },
  );

  return canvas;
}

// Keep track of all created canvases for inspection
let createdCanvases: MockCanvas[] = [];

// Setup the document mock
const originalCreateElement = globalThis.document?.createElement;

function setupDocumentMock(sourcePixelData?: Uint8ClampedArray) {
  createdCanvases = [];

  const mockCreateElement = vi.fn().mockImplementation((tag: string) => {
    if (tag === 'canvas') {
      const canvas = createMockCanvas(sourcePixelData);
      createdCanvases.push(canvas);
      return canvas;
    }
    // Fallback for non-canvas elements
    if (originalCreateElement) {
      return originalCreateElement.call(document, tag);
    }
    return {};
  });

  // Ensure document exists in the test env
  if (!globalThis.document) {
    (globalThis as any).document = { createElement: mockCreateElement };
  } else {
    vi.spyOn(document, 'createElement').mockImplementation(mockCreateElement);
  }
}

function teardownDocumentMock() {
  if (globalThis.document && 'createElement' in globalThis.document) {
    vi.restoreAllMocks();
  }
}

// ---- Tests ----

describe('FramePrepWorker (sync fallback)', () => {
  let prepareFrame: typeof import('../framePrepWorker').prepareFrame;
  let _setOffThreadAvailable: typeof import('../framePrepWorker')._setOffThreadAvailable;
  let _resetOffThreadDetection: typeof import('../framePrepWorker')._resetOffThreadDetection;

  beforeEach(async () => {
    // Reset mocks and module state
    toDataURLBehavior = { baseSizeBytes: 500, scaleWithQuality: false };

    // Import the module fresh each time so _offThreadAvailable resets
    const mod = await import('../framePrepWorker');
    prepareFrame = mod.prepareFrame;
    _setOffThreadAvailable = mod._setOffThreadAvailable;
    _resetOffThreadDetection = mod._resetOffThreadDetection;

    // Force sync fallback path
    _setOffThreadAvailable(false);
  });

  afterEach(() => {
    teardownDocumentMock();
    _resetOffThreadDetection();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Test: Correct hash output for known pixel buffers
  // Validates: Requirement 5.2
  // ──────────────────────────────────────────────────────────────────────
  describe('correct hash output for known pixel buffers', () => {
    it('produces the expected hash for an all-black frame', async () => {
      const width = 64;
      const height = 64;
      const pixels = makeUniformPixels(width, height, 0, 0, 0);

      // Compute expected hash directly via phash utility
      const pixelArray = new Uint8ClampedArray(pixels);
      const expectedHash = phash({ data: pixelArray, width, height });

      // Setup mock — the getImageData should return the same pixels
      // since dimensions match (no downscale needed for 64x64 < 1280)
      setupDocumentMock(pixelArray);

      const result = await prepareFrame({
        pixels: pixels.slice(0), // copy since it gets transferred
        width,
        height,
        maxKeyframeBytes: 100_000,
        initialQuality: 0.85,
      });

      expect(result.hash).toBeInstanceOf(Uint8Array);
      expect(result.hash).toHaveLength(8);
      expect(result.hash).toEqual(expectedHash);
    });

    it('produces the expected hash for an all-white frame', async () => {
      const width = 32;
      const height = 32;
      const pixels = makeUniformPixels(width, height, 255, 255, 255);

      const pixelArray = new Uint8ClampedArray(pixels);
      const expectedHash = phash({ data: pixelArray, width, height });

      setupDocumentMock(pixelArray);

      const result = await prepareFrame({
        pixels: pixels.slice(0),
        width,
        height,
        maxKeyframeBytes: 100_000,
        initialQuality: 0.85,
      });

      expect(result.hash).toEqual(expectedHash);
    });

    it('produces the expected hash for a patterned frame', async () => {
      const width = 100;
      const height = 100;
      const pixels = makePatternPixels(width, height);

      const pixelArray = new Uint8ClampedArray(pixels);
      const expectedHash = phash({ data: pixelArray, width, height });

      setupDocumentMock(pixelArray);

      const result = await prepareFrame({
        pixels: pixels.slice(0),
        width,
        height,
        maxKeyframeBytes: 100_000,
        initialQuality: 0.85,
      });

      expect(result.hash).toEqual(expectedHash);
    });

    it('produces different hashes for different content', async () => {
      const width = 64;
      const height = 64;
      const blackPixels = makeUniformPixels(width, height, 0, 0, 0);
      const whitePixels = makeUniformPixels(width, height, 255, 255, 255);

      const blackArray = new Uint8ClampedArray(blackPixels);
      const whiteArray = new Uint8ClampedArray(whitePixels);

      // Compute hashes directly
      const blackHash = phash({ data: blackArray, width, height });
      const whiteHash = phash({ data: whiteArray, width, height });

      // For uniform frames, the hash is all-ones (all samples >= mean)
      // so both uniform frames produce the same hash (0xFF * 8).
      // This is expected behavior documented in phash.ts — uniform frames
      // hash to 0xFF...FF. Let's use a pattern vs uniform instead.
      const patternPixels = makePatternPixels(width, height);
      const patternArray = new Uint8ClampedArray(patternPixels);
      const patternHash = phash({ data: patternArray, width, height });

      // Pattern should differ from uniform black
      // (at least some bits should differ for non-trivial content)
      expect(patternHash).not.toEqual(blackHash);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Test: JPEG header presence in output
  // Validates: Requirement 7.4
  // ──────────────────────────────────────────────────────────────────────
  describe('JPEG header presence in output', () => {
    it('output decodes to bytes starting with JPEG SOI marker 0xFF 0xD8', async () => {
      const width = 32;
      const height = 32;
      const pixels = makeUniformPixels(width, height, 100, 150, 200);
      const pixelArray = new Uint8ClampedArray(pixels);

      setupDocumentMock(pixelArray);

      const result = await prepareFrame({
        pixels: pixels.slice(0),
        width,
        height,
        maxKeyframeBytes: 100_000,
        initialQuality: 0.85,
      });

      // Decode the base64 output and check JPEG SOI marker
      expect(result.keyframeBase64).toBeTruthy();
      expect(result.keyframeBase64.length).toBeGreaterThan(0);

      // Decode base64 to check the first two bytes
      const binaryString = atob(result.keyframeBase64);
      expect(binaryString.charCodeAt(0)).toBe(0xFF);
      expect(binaryString.charCodeAt(1)).toBe(0xD8);
    });

    it('keyframeBase64 is valid base64 (no data URI prefix)', async () => {
      const width = 16;
      const height = 16;
      const pixels = makeUniformPixels(width, height, 50, 50, 50);
      const pixelArray = new Uint8ClampedArray(pixels);

      setupDocumentMock(pixelArray);

      const result = await prepareFrame({
        pixels: pixels.slice(0),
        width,
        height,
        maxKeyframeBytes: 100_000,
        initialQuality: 0.85,
      });

      // Should not contain data URI prefix
      expect(result.keyframeBase64).not.toContain('data:');
      expect(result.keyframeBase64).not.toContain(';base64,');

      // Should be valid base64 (atob should not throw)
      expect(() => atob(result.keyframeBase64)).not.toThrow();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Test: Re-encode loop terminates within bounds
  // Validates: Requirement 7.1
  // ──────────────────────────────────────────────────────────────────────
  describe('re-encode loop terminates within bounds', () => {
    it('re-encodes when initial output exceeds maxKeyframeBytes', async () => {
      const width = 64;
      const height = 64;
      const pixels = makeUniformPixels(width, height, 200, 100, 50);
      const pixelArray = new Uint8ClampedArray(pixels);

      // Configure mock so initial encode produces ~1000 bytes,
      // and lower quality produces smaller output
      toDataURLBehavior = { baseSizeBytes: 1000, scaleWithQuality: true };
      setupDocumentMock(pixelArray);

      // Set maxKeyframeBytes very small to force re-encoding
      const result = await prepareFrame({
        pixels: pixels.slice(0),
        width,
        height,
        maxKeyframeBytes: 100, // Very small limit
        initialQuality: 0.85,
      });

      // The re-encode loop should have iterated at least once
      expect(result.reEncodeCount).toBeGreaterThan(0);
      // But should terminate (not infinite loop) — max is 10
      expect(result.reEncodeCount).toBeLessThanOrEqual(10);
    });

    it('returns reEncodeCount=0 when initial encode is within budget', async () => {
      const width = 32;
      const height = 32;
      const pixels = makeUniformPixels(width, height, 128, 128, 128);
      const pixelArray = new Uint8ClampedArray(pixels);

      // Initial encode produces ~500 bytes, well within the 100KB limit
      toDataURLBehavior = { baseSizeBytes: 500, scaleWithQuality: false };
      setupDocumentMock(pixelArray);

      const result = await prepareFrame({
        pixels: pixels.slice(0),
        width,
        height,
        maxKeyframeBytes: 100_000,
        initialQuality: 0.85,
      });

      expect(result.reEncodeCount).toBe(0);
    });

    it('terminates even when output cannot be reduced below max', async () => {
      const width = 64;
      const height = 64;
      const pixels = makeUniformPixels(width, height, 200, 100, 50);
      const pixelArray = new Uint8ClampedArray(pixels);

      // Configure mock: output is always large regardless of quality
      // This simulates worst-case where quality reduction has minimal effect
      toDataURLBehavior = { baseSizeBytes: 5000, scaleWithQuality: false };
      setupDocumentMock(pixelArray);

      const result = await prepareFrame({
        pixels: pixels.slice(0),
        width,
        height,
        maxKeyframeBytes: 10, // Impossibly small
        initialQuality: 0.85,
      });

      // Should still terminate (capped at 10 passes)
      expect(result.reEncodeCount).toBeLessThanOrEqual(10);
      // Should report actual byte length even if over budget
      expect(result.keyframeBytes).toBeGreaterThan(0);
    });

    it('reports accurate keyframeBytes in the result', async () => {
      const width = 32;
      const height = 32;
      const pixels = makeUniformPixels(width, height, 0, 255, 0);
      const pixelArray = new Uint8ClampedArray(pixels);

      toDataURLBehavior = { baseSizeBytes: 600, scaleWithQuality: false };
      setupDocumentMock(pixelArray);

      const result = await prepareFrame({
        pixels: pixels.slice(0),
        width,
        height,
        maxKeyframeBytes: 100_000,
        initialQuality: 0.85,
      });

      // keyframeBytes should be a positive number representing the decoded size
      expect(result.keyframeBytes).toBeGreaterThan(0);
      // Verify it's consistent with the base64 output length
      // base64 length * 3/4 ≈ decoded byte length
      const expectedApproxBytes = Math.ceil((result.keyframeBase64.length * 3) / 4);
      expect(result.keyframeBytes).toBe(expectedApproxBytes);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Test: Synchronous fallback produces same hash as worker path
  // Validates: Requirements 5.2, 5.3
  // ──────────────────────────────────────────────────────────────────────
  describe('synchronous fallback produces same hash as direct phash computation', () => {
    it('sync fallback hash matches phash() computed directly on same pixels', async () => {
      const width = 80;
      const height = 60;
      const pixels = makePatternPixels(width, height);
      const pixelArray = new Uint8ClampedArray(pixels);

      // Compute expected hash directly using phash utility
      // (no downscale since 80x60 < 1280)
      const expectedHash = phash({ data: pixelArray, width, height });

      // Setup mock with the same pixel data
      setupDocumentMock(pixelArray);

      // Force sync fallback
      _setOffThreadAvailable(false);

      const result = await prepareFrame({
        pixels: pixels.slice(0),
        width,
        height,
        maxKeyframeBytes: 100_000,
        initialQuality: 0.85,
      });

      // The sync path should produce the exact same hash
      expect(result.hash).toEqual(expectedHash);
    });

    it('sync fallback produces correct hash for frames within 1280px (no downscale)', async () => {
      const width = 640;
      const height = 480;
      const pixels = makeUniformPixels(width, height, 42, 84, 126);
      const pixelArray = new Uint8ClampedArray(pixels);

      // No downscale needed — longest edge 640 < 1280
      const expectedHash = phash({ data: pixelArray, width, height });

      setupDocumentMock(pixelArray);
      _setOffThreadAvailable(false);

      const result = await prepareFrame({
        pixels: pixels.slice(0),
        width,
        height,
        maxKeyframeBytes: 100_000,
        initialQuality: 0.85,
      });

      expect(result.hash).toEqual(expectedHash);
    });

    it('sync fallback produces consistent results across multiple calls', async () => {
      const width = 48;
      const height = 48;
      const pixels = makePatternPixels(width, height);
      const pixelArray = new Uint8ClampedArray(pixels);

      setupDocumentMock(pixelArray);
      _setOffThreadAvailable(false);

      const result1 = await prepareFrame({
        pixels: pixels.slice(0),
        width,
        height,
        maxKeyframeBytes: 100_000,
        initialQuality: 0.85,
      });

      // Re-setup mock for second call (fresh canvases)
      teardownDocumentMock();
      setupDocumentMock(pixelArray);

      const result2 = await prepareFrame({
        pixels: pixels.slice(0),
        width,
        height,
        maxKeyframeBytes: 100_000,
        initialQuality: 0.85,
      });

      // Same input → same hash (deterministic)
      expect(result1.hash).toEqual(result2.hash);
    });
  });
});
