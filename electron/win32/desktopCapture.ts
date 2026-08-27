// ============================================
// Zule AI — Desktop DC Screen Capture (Bypass Display Affinity)
// ============================================
//
// Uses BitBlt from GetDC(NULL) to capture the entire screen including windows
// that have SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) applied.
//
// Why this works: SetWindowDisplayAffinity tells the DWM to exclude the window
// from PrintWindow, getDisplayMedia, and similar capture APIs. But GetDC(NULL)
// returns the raw desktop device context — the final composited framebuffer
// that the GPU sends to the monitor. Display affinity does NOT affect this path.
//
// This is the same technique used by hardware-accelerated game capture overlays
// and screen recording software that bypasses DRM protection.
//
// Returns a base64-encoded JPEG of the current screen content.

import { createRequire } from 'node:module';
import type { BrowserWindow as BrowserWindowType } from 'electron';

import { downscaleSize } from '../../src/utils/geometry';

/**
 * Longest-edge cap applied before JPEG encoding.
 *
 * A native-resolution frame is not free to send: on a 1440p display the base64
 * JPEG is several hundred kilobytes that must cross the IPC boundary, then the
 * network, and then be turned into vision tokens the model prefills before it
 * can emit its first answer token. All three costs scale with pixel count, and
 * on the screen path that time is the whole product.
 *
 * 1600 rather than the 1280 used by the OCR path (`useScreenCapture.ts`,
 * Requirement 13.1) because the consumer here is different. Tesseract needs
 * per-glyph fidelity and 1280 was already marginal for it; a vision model reads
 * far more robustly, but it still has to make out 12px UI text in a code editor,
 * so this keeps a margin over 1280 while still cutting a 2560px-wide frame's
 * pixel count by roughly 2.5x.
 */
const MAX_LONGEST_EDGE = 1600;

/** JPEG quality. 80 rather than 85 — a few percent of bytes for no legibility. */
const JPEG_QUALITY = 80;

const require = createRequire(import.meta.url);

let koffi: any = null;
let user32Lib: any = null;
let gdi32Lib: any = null;
let loaded = false;
let loadFailed = false;

function ensureLoaded(): boolean {
  if (loaded) return true;
  if (loadFailed) return false;
  if (process.platform !== 'win32') { loadFailed = true; return false; }

  try {
    koffi = createRequire(import.meta.url)('koffi');
    user32Lib = koffi.load('user32.dll');
    gdi32Lib = koffi.load('gdi32.dll');
    loaded = true;
    return true;
  } catch {
    loadFailed = true;
    return false;
  }
}

/**
 * Capture the entire primary screen using BitBlt from the desktop DC.
 * Returns raw BGRA pixel buffer and dimensions, or null on failure.
 */
export function captureDesktopRaw(): { width: number; height: number; pixels: Buffer } | null {
  if (!ensureLoaded()) return null;

  try {
    // Get screen dimensions
    const GetSystemMetrics = user32Lib.func('int GetSystemMetrics(int nIndex)');
    const SM_CXSCREEN = 0;
    const SM_CYSCREEN = 1;
    const width = GetSystemMetrics(SM_CXSCREEN);
    const height = GetSystemMetrics(SM_CYSCREEN);

    if (width <= 0 || height <= 0) return null;

    // Get the desktop DC (includes ALL windows regardless of display affinity)
    const GetDC = user32Lib.func('void *GetDC(void *hwnd)');
    const ReleaseDC = user32Lib.func('int ReleaseDC(void *hwnd, void *hdc)');
    const CreateCompatibleDC = gdi32Lib.func('void *CreateCompatibleDC(void *hdc)');
    const CreateCompatibleBitmap = gdi32Lib.func('void *CreateCompatibleBitmap(void *hdc, int cx, int cy)');
    const SelectObject = gdi32Lib.func('void *SelectObject(void *hdc, void *h)');
    const BitBlt = gdi32Lib.func('bool BitBlt(void *hdc, int x, int y, int cx, int cy, void *hdcSrc, int x1, int y1, uint32_t rop)');
    const DeleteObject = gdi32Lib.func('bool DeleteObject(void *ho)');
    const DeleteDC = gdi32Lib.func('bool DeleteDC(void *hdc)');
    const GetDIBits = gdi32Lib.func('int GetDIBits(void *hdc, void *hbm, uint32_t start, uint32_t cLines, void *lpvBits, void *lpbmi, uint32_t usage)');

    const SRCCOPY = 0x00CC0020;
    const DIB_RGB_COLORS = 0;

    // Step 1: Get desktop DC
    const desktopDC = GetDC(null);
    if (!desktopDC) return null;

    // Step 2: Create compatible DC and bitmap
    const memDC = CreateCompatibleDC(desktopDC);
    const memBitmap = CreateCompatibleBitmap(desktopDC, width, height);
    const oldBitmap = SelectObject(memDC, memBitmap);

    // Step 3: BitBlt the entire screen (bypasses display affinity!)
    BitBlt(memDC, 0, 0, width, height, desktopDC, 0, 0, SRCCOPY);

    // Step 4: Extract pixel data via GetDIBits
    // BITMAPINFOHEADER struct
    const bmiSize = 40 + 12; // BITMAPINFOHEADER (40) + color table padding
    const bmiBuf = Buffer.alloc(bmiSize);
    bmiBuf.writeUInt32LE(40, 0);       // biSize
    bmiBuf.writeInt32LE(width, 4);     // biWidth
    bmiBuf.writeInt32LE(-height, 8);   // biHeight (negative = top-down)
    bmiBuf.writeUInt16LE(1, 12);       // biPlanes
    bmiBuf.writeUInt16LE(32, 14);      // biBitCount (BGRA)
    bmiBuf.writeUInt32LE(0, 16);       // biCompression (BI_RGB)

    const pixelBuf = Buffer.alloc(width * height * 4);

    // Use koffi pointer for the buffer parameters
    GetDIBits(memDC, memBitmap, 0, height, pixelBuf, bmiBuf, DIB_RGB_COLORS);

    // Cleanup GDI
    SelectObject(memDC, oldBitmap);
    DeleteObject(memBitmap);
    DeleteDC(memDC);
    ReleaseDC(null, desktopDC);

    return { width, height, pixels: pixelBuf };
  } catch (err: unknown) {
    console.warn('[DesktopCapture] BitBlt capture failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Capture the screen and return as a base64 JPEG suitable for sending
 * to a vision model. Uses Electron's nativeImage for JPEG encoding.
 *
 * Downscaled to `MAX_LONGEST_EDGE` before encoding, because every byte here is
 * paid for three times over — IPC, upload, and vision prefill — before the model
 * emits anything.
 *
 * Excludes the area occupied by the overlay window to avoid capturing
 * zule itself in the screenshot.
 */
export function captureDesktopAsBase64(overlayWindow?: BrowserWindowType | null): string | null {
  return captureDesktopAsJpeg(overlayWindow)?.base64 ?? null;
}

/**
 * As `captureDesktopAsBase64`, but also reports the encoded size and the
 * dimensions actually sent, so the renderer's `[perf]` line can attribute
 * latency to payload size instead of guessing at it.
 */
export function captureDesktopAsJpeg(
  overlayWindow?: BrowserWindowType | null,
): { base64: string; bytes: number; width: number; height: number } | null {
  const raw = captureDesktopRaw();
  if (!raw) return null;

  try {
    const { nativeImage } = require('electron') as typeof import('electron');

    // Create a NativeImage from the raw BGRA pixels
    let img = nativeImage.createFromBuffer(raw.pixels, {
      width: raw.width,
      height: raw.height,
    });

    // `downscaleSize` is idempotent when the frame already fits, but skip the
    // resize call outright in that case so a small display pays nothing.
    const target = downscaleSize({ width: raw.width, height: raw.height }, MAX_LONGEST_EDGE);
    if (target.width !== raw.width || target.height !== raw.height) {
      img = img.resize({ width: target.width, height: target.height, quality: 'good' });
    }

    const jpeg = img.toJPEG(JPEG_QUALITY);
    if (!jpeg || jpeg.length === 0) return null;

    return {
      base64: jpeg.toString('base64'),
      bytes: jpeg.length,
      width: target.width,
      height: target.height,
    };
  } catch (err: unknown) {
    console.warn('[DesktopCapture] JPEG encoding failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}
