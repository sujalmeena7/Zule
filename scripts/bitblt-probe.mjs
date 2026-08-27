// Standalone check: does BitBlt from GetDC(NULL) see through
// SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)?
//
// Run `scripts/protected-window.ps1` first, then `node scripts/bitblt-probe.mjs`.
// Reports the mean luminance of the centre region, where that script puts its
// 800x600 white form. White form visible => bypass works. Near-zero => the
// protection defeats this capture path and the vision model would receive a
// black rectangle.
//
// Deliberately does not import electron/win32/desktopCapture.ts: that module
// needs `nativeImage` for the JPEG step, which only exists inside Electron. The
// BitBlt below is the same sequence of calls, minus the encode.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');

const GetSystemMetrics = user32.func('int GetSystemMetrics(int nIndex)');
const GetForegroundWindow = user32.func('void *GetForegroundWindow()');
const GetWindowTextA = user32.func('int GetWindowTextA(void *hwnd, void *s, int max)');
const IsWindowVisible = user32.func('bool IsWindowVisible(void *hwnd)');
const GetWindowRect = user32.func('bool GetWindowRect(void *hwnd, void *rect)');
const GetWindowDisplayAffinity = user32.func('bool GetWindowDisplayAffinity(void *hwnd, void *affinity)');
const GetWindowThreadProcessId = user32.func('uint32_t GetWindowThreadProcessId(void *hwnd, void *pid)');
const GetDC = user32.func('void *GetDC(void *hwnd)');
const ReleaseDC = user32.func('int ReleaseDC(void *hwnd, void *hdc)');
const CreateCompatibleDC = gdi32.func('void *CreateCompatibleDC(void *hdc)');
const CreateCompatibleBitmap = gdi32.func('void *CreateCompatibleBitmap(void *hdc, int cx, int cy)');
const SelectObject = gdi32.func('void *SelectObject(void *hdc, void *h)');
const BitBlt = gdi32.func('bool BitBlt(void *hdc, int x, int y, int cx, int cy, void *hdcSrc, int x1, int y1, uint32_t rop)');
const DeleteObject = gdi32.func('bool DeleteObject(void *ho)');
const DeleteDC = gdi32.func('bool DeleteDC(void *hdc)');
const GetDIBits = gdi32.func('int GetDIBits(void *hdc, void *hbm, uint32_t start, uint32_t cLines, void *lpvBits, void *lpbmi, uint32_t usage)');

const width = GetSystemMetrics(0);
const height = GetSystemMetrics(1);

const desktopDC = GetDC(null);
const memDC = CreateCompatibleDC(desktopDC);
const memBitmap = CreateCompatibleBitmap(desktopDC, width, height);
const oldBitmap = SelectObject(memDC, memBitmap);

const t0 = performance.now();
const blitOk = BitBlt(memDC, 0, 0, width, height, desktopDC, 0, 0, 0x00cc0020);
const blitMs = performance.now() - t0;

const bmi = Buffer.alloc(52);
bmi.writeUInt32LE(40, 0);
bmi.writeInt32LE(width, 4);
bmi.writeInt32LE(-height, 8);
bmi.writeUInt16LE(1, 12);
bmi.writeUInt16LE(32, 14);
bmi.writeUInt32LE(0, 16);

const pixels = Buffer.alloc(width * height * 4);
const scanlines = GetDIBits(memDC, memBitmap, 0, height, pixels, bmi, 0);

SelectObject(memDC, oldBitmap);
DeleteObject(memBitmap);
DeleteDC(memDC);
ReleaseDC(null, desktopDC);

/** Mean luminance and the share of near-black pixels over one rectangle. */
function region(x0, y0, w, h) {
  let sum = 0;
  let dark = 0;
  let n = 0;
  for (let y = y0; y < y0 + h; y += 2) {
    for (let x = x0; x < x0 + w; x += 2) {
      const i = (y * width + x) * 4;
      // 0.299R + 0.587G + 0.114B on BGRA, in eighths to stay in integers.
      const lum = (pixels[i + 2] * 77 + pixels[i + 1] * 150 + pixels[i] * 29) >> 8;
      sum += lum;
      if (lum < 8) dark += 1;
      n += 1;
    }
  }
  return { mean: (sum / n).toFixed(1), darkPct: ((dark / n) * 100).toFixed(1) };
}

// Interrogate the foreground window rather than assuming where the form is. A
// guessed centre rect cannot tell "the form is black" from "the form was never
// in front of the editor", and those two have opposite conclusions.
const fgHwnd = GetForegroundWindow();
const titleBuf = Buffer.alloc(512);
GetWindowTextA(fgHwnd, titleBuf, 512);
const fgTitle = titleBuf.toString('latin1').split('\0')[0];
const fgVisible = IsWindowVisible(fgHwnd);

const rectBuf = Buffer.alloc(16);
GetWindowRect(fgHwnd, rectBuf);
const left = rectBuf.readInt32LE(0);
const top = rectBuf.readInt32LE(4);
const right = rectBuf.readInt32LE(8);
const bottom = rectBuf.readInt32LE(12);

// WDA_NONE 0, WDA_MONITOR 1 (renders black to capture), WDA_EXCLUDEFROMCAPTURE
// 0x11 (removed from capture entirely — the capture shows what is behind it).
const affBuf = Buffer.alloc(4);
const affOk = GetWindowDisplayAffinity(fgHwnd, affBuf);
const affinity = affOk ? affBuf.readUInt32LE(0) : -1;
const affinityName = { 0: 'WDA_NONE', 1: 'WDA_MONITOR', 0x11: 'WDA_EXCLUDEFROMCAPTURE' }[affinity]
  ?? `unknown(${affinity})`;

const fx = Math.max(0, left);
const fy = Math.max(0, top);
const fw = Math.max(1, Math.min(right, width) - fx);
const fh = Math.max(1, Math.min(bottom, height) - fy);

const form = region(fx, fy, fw, fh);
const whole = region(0, 0, width, height);

console.log(`screen        ${width}x${height}  BitBlt ok=${blitOk} ${blitMs.toFixed(1)}ms  GetDIBits scanlines=${scanlines}`);
console.log(`foreground    "${fgTitle}"  visible=${fgVisible}  rect ${left},${top} ${right - left}x${bottom - top}`);
console.log(`affinity      ${affinityName}`);

// Mirrors the ownership test in `foregroundWindowIsCaptureProtected`. Zule's
// overlay sets content protection on itself, so a by-pid exclusion is what keeps
// the overlay taking focus from reading as a protected foreground.
const ownerPidBuf = Buffer.alloc(4);
const tid = GetWindowThreadProcessId(fgHwnd, ownerPidBuf);
console.log(`owner         pid ${ownerPidBuf.readUInt32LE(0)} tid ${tid} (this process is ${process.pid})`);
console.log(`whole screen  mean luminance ${whole.mean}  near-black ${whole.darkPct}%`);
console.log(`fg rect       mean luminance ${form.mean}  near-black ${form.darkPct}%`);
console.log('');

if (scanlines === 0) {
  console.log('VERDICT  GetDIBits returned nothing — the capture failed outright.');
} else if (affinity === 0) {
  console.log('VERDICT  N/A. The foreground window is not capture-protected, so this run');
  console.log('         says nothing about the bypass. Focus the protected window first.');
} else if (Number(form.darkPct) > 90) {
  console.log('VERDICT  BLOCKED, as black. The protected window reads as a black rectangle,');
  console.log('         so the vision model receives no question text.');
} else if (Number(form.mean) > 120) {
  console.log('VERDICT  BYPASS WORKS. The white form is present in the capture, so the');
  console.log('         vision model sees the question text.');
} else {
  console.log('VERDICT  BLOCKED, invisibly. The window is protected and in the foreground,');
  console.log('         yet its rect is neither white (the form) nor black — the capture is');
  console.log('         showing whatever sits behind it. WDA_EXCLUDEFROMCAPTURE removes the');
  console.log('         window from the capture rather than blacking it out, so there is no');
  console.log('         visual marker that anything is missing.');
}
