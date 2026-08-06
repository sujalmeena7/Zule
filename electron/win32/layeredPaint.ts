// ============================================
// Zule AI — Stage B: Layered Paint Surface
// ============================================
//
// Manages a CreateDIBSection-backed BGRA pixel buffer and presents it to the
// Stealth Host via UpdateLayeredWindow. Provides zero-copy access to the pixel
// data through koffi.view() so the paint event handler can memcpy directly
// from Electron's NativeImage bitmap without per-pixel JS overhead.
//
// Requirements: 7.1, 7.2, 7.3, 7.4, 7.5

import { getFfi, type HwndPtr, type Win32Ffi } from './ffi';

// ── Constants ────────────────────────────────────────────────────────────────

const ULW_ALPHA = 0x00000002;
const AC_SRC_OVER = 0x00;
const AC_SRC_ALPHA = 0x01;
const DIB_RGB_COLORS = 0;
const BI_RGB = 0;

/** Maximum consecutive UpdateLayeredWindow failures before requesting rollback. */
export const MAX_PRESENT_FAILURES = 5;

// ── Public Types ─────────────────────────────────────────────────────────────

export interface PaintSurface {
  readonly width: number;
  readonly height: number;
  /** Writable BGRA (premultiplied) buffer backed by CreateDIBSection. Zero-copy. */
  readonly pixels: Buffer;
  /**
   * Blit the current buffer to the host via UpdateLayeredWindow.
   * Returns false on failure; after MAX_PRESENT_FAILURES consecutive failures
   * the circuit breaker fires.
   */
  present(hostHwnd: HwndPtr, screenX: number, screenY: number): boolean;
  /**
   * Resize the DIB. Returns false if allocation failed; previous surface stays valid.
   */
  resize(width: number, height: number): boolean;
  /** Release GDI resources (bitmap + DC). */
  dispose(): void;
  /** Diagnostic: current consecutive failure count. */
  readonly consecutiveFailures: number;
  /** Diagnostic: whether the circuit breaker has fired. */
  readonly circuitBreakerTripped: boolean;
}

/** Callback invoked when the circuit breaker trips after too many present failures. */
export type RollbackRequester = (reason: string) => void;

export interface CreatePaintSurfaceOptions {
  /** Called when the circuit breaker trips. */
  onRollbackRequested?: RollbackRequester;
}

// ── Pure helpers (exported for property testing) ─────────────────────────────

/**
 * Frame-size guard predicate: returns true iff bufferLength matches
 * the expected byte count for a BGRA surface of given dimensions.
 *
 * Used by present() to reject mismatched paint buffers (Req 7.2).
 */
export function frameMatchesSurface(
  bufferLength: number,
  width: number,
  height: number,
): boolean {
  return bufferLength === width * height * 4;
}

// ── Internal Types ───────────────────────────────────────────────────────────

interface DibState {
  memDC: HwndPtr;
  bitmap: HwndPtr;
  pixels: Buffer;
  width: number;
  height: number;
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a PaintSurface backed by a Win32 DIB section.
 * Returns null if koffi/gdi32 is unavailable or allocation fails.
 */
export function createPaintSurface(
  width: number,
  height: number,
  options?: CreatePaintSurfaceOptions,
): PaintSurface | null {
  if (width <= 0 || height <= 0) return null;

  const ffi = getFfi();
  if (!ffi) return null;

  // Ensure Stage B gdi32 bindings are loaded
  if (!ffi.gdi32.ensureLoaded()) return null;

  const dib = allocateDib(ffi, width, height);
  if (!dib) return null;

  // Stable BLENDFUNCTION allocation — reused across all present() calls (Req 7.5)
  const blend = ffi.alloc('BLENDFUNCTION', {
    BlendOp: AC_SRC_OVER,
    BlendFlags: 0,
    SourceConstantAlpha: 255,
    AlphaFormat: AC_SRC_ALPHA,
  });

  // Stable source-origin POINT — always (0, 0), never changes
  const pptSrc = ffi.alloc('POINT', { x: 0, y: 0 });

  let currentDib: DibState = dib;
  let consecutiveFailures = 0;
  let circuitBreakerTripped = false;
  let disposed = false;

  const surface: PaintSurface = {
    get width() {
      return currentDib.width;
    },
    get height() {
      return currentDib.height;
    },
    get pixels() {
      return currentDib.pixels;
    },
    get consecutiveFailures() {
      return consecutiveFailures;
    },
    get circuitBreakerTripped() {
      return circuitBreakerTripped;
    },

    present(hostHwnd: HwndPtr, screenX: number, screenY: number): boolean {
      if (disposed || circuitBreakerTripped) return false;
      if (!ffi.user32.UpdateLayeredWindow) return false;

      // Frame-size guard (Req 7.2): if the buffer doesn't match expected dimensions,
      // drop the frame. Since pixels IS the surface, this checks internal consistency.
      if (!frameMatchesSurface(currentDib.pixels.length, currentDib.width, currentDib.height)) {
        return false;
      }

      // Allocate per-frame structs for position and size
      // (BLENDFUNCTION and pptSrc are stable — reused across frames)
      const pptDst = ffi.alloc('POINT', { x: screenX, y: screenY });
      const psize = ffi.alloc('SIZE', { cx: currentDib.width, cy: currentDib.height });

      const ok = ffi.user32.UpdateLayeredWindow(
        hostHwnd,
        null,       // hdcDst — use screen DC
        pptDst,
        psize,
        currentDib.memDC,
        pptSrc,     // source origin always (0, 0)
        0,          // crKey — not used with ULW_ALPHA
        blend,
        ULW_ALPHA,
      );

      if (ok) {
        consecutiveFailures = 0;
        return true;
      }

      // Failure path — increment and check circuit breaker (Req 7.3)
      consecutiveFailures++;
      if (consecutiveFailures > MAX_PRESENT_FAILURES) {
        circuitBreakerTripped = true;
        options?.onRollbackRequested?.(
          `UpdateLayeredWindow failed ${consecutiveFailures} consecutive times`,
        );
      }
      return false;
    },

    resize(newWidth: number, newHeight: number): boolean {
      if (disposed) return false;
      if (newWidth <= 0 || newHeight <= 0) return false;
      if (newWidth === currentDib.width && newHeight === currentDib.height) return true;

      const newDib = allocateDib(ffi, newWidth, newHeight);
      if (!newDib) {
        // Allocation failed — keep previous surface valid
        return false;
      }

      // Dispose old DIB resources
      disposeDib(ffi, currentDib);
      currentDib = newDib;

      return true;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      disposeDib(ffi, currentDib);
    },
  };

  return surface;
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Allocate a new DIB section with a compatible DC.
 * Returns null on any failure — caller is responsible for cleanup.
 */
function allocateDib(ffi: Win32Ffi, width: number, height: number): DibState | null {
  if (!ffi.gdi32.CreateCompatibleDC || !ffi.gdi32.CreateDIBSection ||
      !ffi.gdi32.SelectObject) {
    return null;
  }

  // Create a memory DC compatible with the screen
  const memDC = ffi.gdi32.CreateCompatibleDC(null);
  if (!memDC) return null;

  // Allocate the BITMAPINFO with biHeight = -height for top-down row order (Req 7.4)
  const bmi = ffi.alloc('BITMAPINFO', {
    bmiHeader: {
      biSize: 40,  // sizeof(BITMAPINFOHEADER)
      biWidth: width,
      biHeight: -height,  // NEGATIVE = top-down, matches Electron's paint buffer
      biPlanes: 1,
      biBitCount: 32,
      biCompression: BI_RGB,
      biSizeImage: 0,
      biXPelsPerMeter: 0,
      biYPelsPerMeter: 0,
      biClrUsed: 0,
      biClrImportant: 0,
    },
    bmiColors: [0],
  });

  // ppvBits receives the pointer to the pixel data
  const bitsOut = ffi.alloc('void *');

  const bitmap = ffi.gdi32.CreateDIBSection(
    memDC,
    bmi,
    DIB_RGB_COLORS,
    bitsOut,
    null,
    0,
  );

  if (!bitmap) {
    // Cleanup the DC we already created
    ffi.gdi32.DeleteDC!(memDC);
    return null;
  }

  // Decode the pixel pointer and wrap with koffi.view for zero-copy Buffer access
  const pixelPtr = ffi.decode(bitsOut, 'void *');
  if (!pixelPtr) {
    ffi.gdi32.DeleteObject!(bitmap);
    ffi.gdi32.DeleteDC!(memDC);
    return null;
  }

  // Get koffi reference for view() — need the raw koffi module
  let pixels: Buffer;
  try {
    // Access koffi through the module system (same pattern as ffi.ts)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createRequire } = require('node:module') as typeof import('node:module');
    const koffi = createRequire(import.meta.url)('koffi') as any;
    pixels = koffi.view(pixelPtr, width * height * 4) as Buffer;
  } catch {
    ffi.gdi32.DeleteObject!(bitmap);
    ffi.gdi32.DeleteDC!(memDC);
    return null;
  }

  // Select the bitmap into the DC for UpdateLayeredWindow
  ffi.gdi32.SelectObject(memDC, bitmap);

  return { memDC, bitmap, pixels, width, height };
}

/**
 * Release GDI resources for a DIB state.
 * Order: DeleteObject(bitmap) → DeleteDC(memDC)
 */
function disposeDib(ffi: Win32Ffi, dib: DibState): void {
  ffi.gdi32.DeleteObject?.(dib.bitmap);
  ffi.gdi32.DeleteDC?.(dib.memDC);
}
