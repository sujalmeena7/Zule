// ============================================
// Zule AI — FramePrepWorker Property-Based Tests
// ============================================
//
// Feature: screen-context-latency, Property 8: Keyframe payload bounded
// Feature: screen-context-latency, Property 9: Keyframe is valid base64 JPEG
//
// Validates: Requirements 7.1, 7.2, 7.4

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';
import { prepareFrame, _setOffThreadAvailable } from '../framePrepWorker';

// --- JPEG SOI marker bytes ---
const JPEG_SOI_BYTE_0 = 0xFF;
const JPEG_SOI_BYTE_1 = 0xD8;

/**
 * Build a minimal valid JPEG binary (SOI marker + padding) that fits within
 * a byte budget influenced by the quality parameter. This simulates the
 * re-encode loop: at high quality the output is larger than budget, at lower
 * quality it shrinks below.
 */
function buildMockJpegDataUrl(
  canvasWidth: number,
  canvasHeight: number,
  quality: number,
  maxBytes: number,
): string {
  // Simulate compression: higher quality/larger canvas = larger output
  // At quality <= 0.25 or canvas <= 200px, always fit within budget
  const pixelCount = canvasWidth * canvasHeight;
  const scaleFactor = quality * Math.sqrt(pixelCount) * 0.3;
  const simulatedSize = Math.max(2, Math.ceil(scaleFactor));

  // Build a byte array starting with JPEG SOI marker
  const payloadSize = Math.max(2, Math.min(simulatedSize, maxBytes * 3));
  const bytes = new Uint8Array(payloadSize);
  bytes[0] = JPEG_SOI_BYTE_0;
  bytes[1] = JPEG_SOI_BYTE_1;
  // Fill the rest with dummy JPEG content
  for (let i = 2; i < payloadSize; i++) {
    bytes[i] = (i * 7 + 0x42) & 0xFF;
  }

  // Convert to base64
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return `data:image/jpeg;base64,${base64}`;
}

/**
 * Shared state for mock canvas operations. Tracks the maxKeyframeBytes
 * so toDataURL can produce appropriately sized responses.
 */
let mockMaxBytes = 50000;

/**
 * Stub for ImageData that the jsdom env doesn't provide.
 */
class MockImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;

  constructor(dataOrWidth: Uint8ClampedArray | number, widthOrHeight: number, height?: number) {
    if (dataOrWidth instanceof Uint8ClampedArray) {
      this.data = dataOrWidth;
      this.width = widthOrHeight;
      this.height = height!;
    } else {
      const w = dataOrWidth as number;
      const h = widthOrHeight;
      this.width = w;
      this.height = h;
      this.data = new Uint8ClampedArray(w * h * 4);
    }
  }
}

/**
 * Creates a mock canvas element that simulates JPEG encoding behavior.
 * The toDataURL method produces outputs sized relative to quality,
 * allowing the re-encode loop to exercise its bounding logic.
 */
function createMockCanvasElement(): unknown {
  let w = 0;
  let h = 0;

  const mockCtx = {
    putImageData: vi.fn(),
    drawImage: vi.fn((...args: unknown[]) => {
      // When drawImage is called with destination dimensions, update canvas size
      if (args.length >= 5) {
        w = args[3] as number;
        h = args[4] as number;
      }
    }),
    getImageData: vi.fn((_x: number, _y: number, gw: number, gh: number) => {
      return new MockImageData(gw, gh);
    }),
  };

  const canvas = {
    get width() { return w; },
    set width(v: number) { w = v; },
    get height() { return h; },
    set height(v: number) { h = v; },
    getContext: vi.fn(() => mockCtx),
    toDataURL: vi.fn((_type?: string, quality?: number) => {
      const q = typeof quality === 'number' ? quality : 0.8;
      return buildMockJpegDataUrl(w, h, q, mockMaxBytes);
    }),
  };

  return canvas;
}

describe('FramePrepWorker Property Tests', () => {
  let originalImageData: typeof globalThis.ImageData;

  beforeEach(() => {
    // Force the synchronous fallback path (no OffscreenCanvas in test env)
    _setOffThreadAvailable(false);

    // Provide ImageData globally since jsdom doesn't have it
    originalImageData = (globalThis as unknown as Record<string, unknown>).ImageData as typeof globalThis.ImageData;
    (globalThis as unknown as Record<string, unknown>).ImageData = MockImageData;

    // Mock document.createElement to intercept canvas creation
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') {
        return createMockCanvasElement() as unknown as HTMLCanvasElement;
      }
      // For non-canvas elements, create a minimal stub
      return { tagName: tag.toUpperCase() } as unknown as HTMLElement;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (globalThis as unknown as Record<string, unknown>).ImageData = originalImageData;
  });

  // Feature: screen-context-latency, Property 8: Keyframe payload bounded
  describe('Property 8: Keyframe payload bounded', () => {
    it('output keyframeBytes ≤ maxKeyframeBytes for random pixel buffers', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Random dimensions between 100 and 4000 px
          fc.integer({ min: 100, max: 4000 }),
          fc.integer({ min: 100, max: 4000 }),
          // Random maxKeyframeBytes between 500 and 200000
          fc.integer({ min: 500, max: 200000 }),
          async (width, height, maxKeyframeBytes) => {
            // Set the shared maxBytes so mock toDataURL knows the budget
            mockMaxBytes = maxKeyframeBytes;

            // Build a pixel buffer (4 bytes per pixel: RGBA)
            const pixelCount = width * height;
            const pixels = new ArrayBuffer(pixelCount * 4);
            const view = new Uint8Array(pixels);
            // Fill with some deterministic content
            for (let i = 0; i < Math.min(view.length, 1000); i++) {
              view[i] = (i * 13 + 7) & 0xFF;
            }

            const result = await prepareFrame({
              pixels,
              width,
              height,
              maxKeyframeBytes,
              initialQuality: 0.8,
            });

            // **Validates: Requirements 7.1, 7.2**
            // Property assertion: encoded output does not exceed maxKeyframeBytes
            expect(result.keyframeBytes).toBeLessThanOrEqual(maxKeyframeBytes);
            expect(result.keyframeBytes).toBeGreaterThan(0);
            expect(result.reEncodeCount).toBeGreaterThanOrEqual(0);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: screen-context-latency, Property 9: Keyframe is valid base64 JPEG
  describe('Property 9: Keyframe is valid base64 JPEG', () => {
    it('output decodes to bytes starting with JPEG SOI marker (0xFF 0xD8)', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Random dimensions between 100 and 4000 px
          fc.integer({ min: 100, max: 4000 }),
          fc.integer({ min: 100, max: 4000 }),
          async (width, height) => {
            const maxKeyframeBytes = 50000;
            mockMaxBytes = maxKeyframeBytes;

            // Build a pixel buffer (4 bytes per pixel: RGBA)
            const pixelCount = width * height;
            const pixels = new ArrayBuffer(pixelCount * 4);
            const view = new Uint8Array(pixels);
            // Fill with some content
            for (let i = 0; i < Math.min(view.length, 2000); i++) {
              view[i] = (i * 17 + 3) & 0xFF;
            }

            const result = await prepareFrame({
              pixels,
              width,
              height,
              maxKeyframeBytes,
              initialQuality: 0.8,
            });

            // **Validates: Requirements 7.4**
            // Property assertion 1: keyframeBase64 is a non-empty string
            expect(result.keyframeBase64).toBeTruthy();
            expect(typeof result.keyframeBase64).toBe('string');
            expect(result.keyframeBase64.length).toBeGreaterThan(0);

            // Property assertion 2: base64 decodes successfully
            const decoded = atob(result.keyframeBase64);
            expect(decoded.length).toBeGreaterThanOrEqual(2);

            // Property assertion 3: first 2 bytes are JPEG SOI marker (0xFF 0xD8)
            expect(decoded.charCodeAt(0)).toBe(JPEG_SOI_BYTE_0);
            expect(decoded.charCodeAt(1)).toBe(JPEG_SOI_BYTE_1);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
