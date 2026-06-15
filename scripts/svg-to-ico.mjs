/**
 * svg-to-ico.mjs (v2)
 * Uses Playwright's Chromium to render favicon.svg pixel-perfectly,
 * then packages the result into a multi-resolution .ico file.
 */

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const svgPath = path.join(root, 'public', 'favicon.svg');
const icoPath = path.join(root, 'public', 'favicon.ico');
const pngPath = path.join(root, 'public', 'favicon.png');

const SIZES = [16, 32, 48, 256];

async function renderSvgToPng(svgContent, size) {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${size}px; height: ${size}px; background: transparent; overflow: hidden; }
  svg { width: ${size}px; height: ${size}px; display: block; }
</style>
</head>
<body>${svgContent}</body>
</html>`;

  await page.setViewportSize({ width: size, height: size });
  await page.setContent(html, { waitUntil: 'networkidle' });

  const pngBuffer = await page.screenshot({
    type: 'png',
    clip: { x: 0, y: 0, width: size, height: size },
    omitBackground: true,
  });

  await browser.close();
  return pngBuffer;
}

function buildIco(pngBuffers, sizes) {
  const n = pngBuffers.length;
  const headerSize = 6 + n * 16;

  const offsets = [];
  let offset = headerSize;
  for (const buf of pngBuffers) {
    offsets.push(offset);
    offset += buf.length;
  }

  const ico = Buffer.alloc(offset);
  ico.writeUInt16LE(0, 0);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(n, 4);

  for (let i = 0; i < n; i++) {
    const size = sizes[i];
    const base = 6 + i * 16;
    ico.writeUInt8(size >= 256 ? 0 : size, base);
    ico.writeUInt8(size >= 256 ? 0 : size, base + 1);
    ico.writeUInt8(0, base + 2);
    ico.writeUInt8(0, base + 3);
    ico.writeUInt16LE(1, base + 4);
    ico.writeUInt16LE(32, base + 6);
    ico.writeUInt32LE(pngBuffers[i].length, base + 8);
    ico.writeUInt32LE(offsets[i], base + 12);
  }

  for (let i = 0; i < n; i++) {
    pngBuffers[i].copy(ico, offsets[i]);
  }

  return ico;
}

async function main() {
  const svgContent = fs.readFileSync(svgPath, 'utf8');
  console.log(`Rendering ${svgPath} at sizes: ${SIZES.join(', ')}px`);

  const pngBuffers = [];
  for (const size of SIZES) {
    process.stdout.write(`  Rendering ${size}x${size}...`);
    const buf = await renderSvgToPng(svgContent, size);
    pngBuffers.push(buf);
    console.log(' done');
  }

  const ico = buildIco(pngBuffers, SIZES);
  fs.writeFileSync(icoPath, ico);
  console.log(`✓ favicon.ico written (${ico.length} bytes)`);

  // Save the 256x256 as favicon.png too
  fs.writeFileSync(pngPath, pngBuffers[pngBuffers.length - 1]);
  console.log(`✓ favicon.png (256×256) updated`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
