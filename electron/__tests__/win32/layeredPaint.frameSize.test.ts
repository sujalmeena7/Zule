// ============================================
// Property 19: Paint frame size safety
// ============================================
//
// ∀ paint buffers b and surfaces s: copy occurs only when
// b.length = s.width * s.height * 4; otherwise frame dropped and
// previous surface unchanged; no write exceeds s.pixels.length.
//
// **Validates: Requirements 7.2, 7.1**

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import { frameMatchesSurface } from '../../win32/layeredPaint';

// ── Arbitraries ──────────────────────────────────────────────────────────────

/** Surface dimensions: small enough to avoid allocation pressure in tests. */
const arbWidth = fc.integer({ min: 1, max: 2000 });
const arbHeight = fc.integer({ min: 1, max: 2000 });

/** Arbitrary buffer length — sometimes matching, sometimes not. */
const arbBufferLength = fc.integer({ min: 0, max: 16_000_001 });

// ── Model: PaintSurface frame-size guard ─────────────────────────────────────

/**
 * A minimal model of the PaintSurface's frame-size guard behavior.
 * Simulates the guard logic without requiring real GDI32/koffi.
 */
interface ModelSurface {
  width: number;
  height: number;
  pixels: Uint8Array;
  /** Snapshot of pixels content before present attempt. */
  previousSnapshot: Uint8Array;
}

function createModelSurface(width: number, height: number): ModelSurface {
  const byteLength = width * height * 4;
  const pixels = new Uint8Array(byteLength);
  // Fill with a known pattern so we can detect changes
  for (let i = 0; i < byteLength; i++) {
    pixels[i] = i & 0xff;
  }
  return {
    width,
    height,
    pixels,
    previousSnapshot: new Uint8Array(pixels),
  };
}

/**
 * Simulates present() with frame-size guard: returns true if buffer matches,
 * false otherwise. When false, surface pixels are unchanged.
 */
function modelPresent(surface: ModelSurface, incomingBuffer: Uint8Array): boolean {
  if (!frameMatchesSurface(incomingBuffer.length, surface.width, surface.height)) {
    // Frame dropped — previous surface unchanged
    return false;
  }

  // Guard passed — copy the buffer into the surface (simulating memcpy)
  // Ensure no write exceeds s.pixels.length
  const bytesToCopy = Math.min(incomingBuffer.length, surface.pixels.length);
  surface.pixels.set(incomingBuffer.subarray(0, bytesToCopy));
  surface.previousSnapshot = new Uint8Array(surface.pixels);
  return true;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Property 19: Paint frame size safety', () => {
  it('∀ matching buffers: frameMatchesSurface returns true when bufferLength = width * height * 4', () => {
    fc.assert(
      fc.property(arbWidth, arbHeight, (width, height) => {
        const expectedLength = width * height * 4;
        return frameMatchesSurface(expectedLength, width, height) === true;
      }),
      { numRuns: 1000 },
    );
  });

  it('∀ mismatched buffers: frameMatchesSurface returns false when bufferLength ≠ width * height * 4', () => {
    fc.assert(
      fc.property(
        arbWidth,
        arbHeight,
        arbBufferLength,
        (width, height, bufferLength) => {
          const expectedLength = width * height * 4;
          // Skip cases where the buffer happens to match
          fc.pre(bufferLength !== expectedLength);
          return frameMatchesSurface(bufferLength, width, height) === false;
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('∀ buffers and surfaces: copy occurs ONLY when buffer.length = width * height * 4', () => {
    fc.assert(
      fc.property(
        arbWidth,
        arbHeight,
        arbBufferLength,
        (width, height, bufferLength) => {
          // Limit surface size to keep test fast
          const safeWidth = Math.min(width, 100);
          const safeHeight = Math.min(height, 100);
          const surface = createModelSurface(safeWidth, safeHeight);
          const incomingBuffer = new Uint8Array(bufferLength);

          const accepted = modelPresent(surface, incomingBuffer);
          const shouldAccept = frameMatchesSurface(
            bufferLength,
            safeWidth,
            safeHeight,
          );

          return accepted === shouldAccept;
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('∀ mismatched buffers: frame is dropped and previous surface pixels unchanged', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 0, max: 50_000 }),
        (width, height, bufferLength) => {
          const expectedLength = width * height * 4;
          // Only test mismatched cases
          fc.pre(bufferLength !== expectedLength);

          const surface = createModelSurface(width, height);
          const snapshotBefore = new Uint8Array(surface.pixels);

          // Use Uint8Array.fill for performance instead of byte-by-byte loop
          const incomingBuffer = new Uint8Array(bufferLength);
          incomingBuffer.fill(0xff);

          const accepted = modelPresent(surface, incomingBuffer);

          // Frame must be dropped
          if (accepted) return false;

          // Previous surface must be unchanged
          for (let i = 0; i < snapshotBefore.length; i++) {
            if (surface.pixels[i] !== snapshotBefore[i]) return false;
          }

          return true;
        },
      ),
      { numRuns: 500 },
    );
  });

  it('∀ matching buffers: accepted write never exceeds s.pixels.length', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        (width, height) => {
          const surface = createModelSurface(width, height);
          const bufferLength = width * height * 4;
          const incomingBuffer = new Uint8Array(bufferLength);

          // Fill with distinct data
          for (let i = 0; i < bufferLength; i++) {
            incomingBuffer[i] = (i + 42) & 0xff;
          }

          const accepted = modelPresent(surface, incomingBuffer);

          // Must be accepted (buffer matches surface dimensions)
          if (!accepted) return false;

          // Verify no out-of-bounds write occurred by checking pixel array length unchanged
          if (surface.pixels.length !== bufferLength) return false;

          // Verify the write landed correctly (content matches incoming buffer)
          for (let i = 0; i < bufferLength; i++) {
            if (surface.pixels[i] !== incomingBuffer[i]) return false;
          }

          return true;
        },
      ),
      { numRuns: 500 },
    );
  });

  it('∀ zero-dimension buffers: frameMatchesSurface handles edge cases', () => {
    // Zero width or height means expected length is 0
    fc.assert(
      fc.property(arbBufferLength, (bufferLength) => {
        // Width=0 or height=0 → expected = 0
        const matchesZeroWidth = frameMatchesSurface(bufferLength, 0, 5);
        const matchesZeroHeight = frameMatchesSurface(bufferLength, 5, 0);

        // Only length 0 should match width*height*4 = 0
        if (bufferLength === 0) {
          return matchesZeroWidth === true && matchesZeroHeight === true;
        }
        return matchesZeroWidth === false && matchesZeroHeight === false;
      }),
      { numRuns: 200 },
    );
  });

  it('∀ surfaces: the guard predicate is mathematically exact (no off-by-one)', () => {
    fc.assert(
      fc.property(arbWidth, arbHeight, (width, height) => {
        const exact = width * height * 4;

        // Exact match → true
        if (!frameMatchesSurface(exact, width, height)) return false;

        // Off by ±1 → false (unless exact is 0 or max, handle edge)
        if (exact > 0 && frameMatchesSurface(exact - 1, width, height)) return false;
        if (exact < Number.MAX_SAFE_INTEGER && frameMatchesSurface(exact + 1, width, height)) {
          return false;
        }

        return true;
      }),
      { numRuns: 1000 },
    );
  });
});
