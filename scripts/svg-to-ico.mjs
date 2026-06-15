/**
 * svg-to-ico.mjs
 * Converts public/favicon.svg → public/favicon.ico
 * using the sharp instance bundled with @huggingface/transformers.
 *
 * ICO format: concatenates 16x16, 32x32, 48x48, 256x256 PNG images
 * with a standard ICO header so Windows recognises it as a real icon.
 */

import { createRequire } from 'module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const sharp = require(path.join(root, 'node_modules/@huggingface/transformers/node_modules/sharp'));
const svgPath = path.join(root, 'public', 'favicon.svg');
const icoPath = path.join(root, 'public', 'favicon.ico');

const SIZES = [16, 32, 48, 256];

async function svgToPng(svgBuffer, size) {
  return sharp(svgBuffer, { density: Math.ceil(size * 90 / 16) })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

function buildIco(pngBuffers) {
  const n = pngBuffers.length;
  // ICO header: 6 bytes
  // Each directory entry: 16 bytes
  // Total header size: 6 + n*16
  const headerSize = 6 + n * 16;

  // Calculate offsets
  const offsets = [];
  let offset = headerSize;
  for (const buf of pngBuffers) {
    offsets.push(offset);
    offset += buf.length;
  }

  const totalSize = offset;
  const ico = Buffer.alloc(totalSize);

  // ICO file header (6 bytes)
  ico.writeUInt16LE(0, 0);      // Reserved, must be 0
  ico.writeUInt16LE(1, 2);      // Type: 1 = ICO
  ico.writeUInt16LE(n, 4);      // Number of images

  // Directory entries (16 bytes each)
  for (let i = 0; i < n; i++) {
    const size = SIZES[i];
    const buf = pngBuffers[i];
    const base = 6 + i * 16;
    ico.writeUInt8(size >= 256 ? 0 : size, base);      // Width (0 = 256)
    ico.writeUInt8(size >= 256 ? 0 : size, base + 1);  // Height (0 = 256)
    ico.writeUInt8(0, base + 2);    // Color count (0 = no palette)
    ico.writeUInt8(0, base + 3);    // Reserved
    ico.writeUInt16LE(1, base + 4); // Color planes
    ico.writeUInt16LE(32, base + 6); // Bits per pixel
    ico.writeUInt32LE(buf.length, base + 8);  // Size of image data
    ico.writeUInt32LE(offsets[i], base + 12); // Offset of image data
  }

  // Write PNG data
  for (let i = 0; i < n; i++) {
    pngBuffers[i].copy(ico, offsets[i]);
  }

  return ico;
}

async function main() {
  const svgBuffer = fs.readFileSync(svgPath);
  console.log(`Converting ${svgPath} → ${icoPath}`);
  console.log(`Generating sizes: ${SIZES.join(', ')}px`);

  const pngBuffers = await Promise.all(SIZES.map(size => svgToPng(svgBuffer, size)));

  const ico = buildIco(pngBuffers);
  fs.writeFileSync(icoPath, ico);
  console.log(`✓ favicon.ico written (${ico.length} bytes)`);

  // Also write a crisp 256x256 PNG for electron-builder fallback
  const png256Path = path.join(root, 'public', 'favicon.png');
  fs.writeFileSync(png256Path, pngBuffers[pngBuffers.length - 1]);
  console.log(`✓ favicon.png (256x256) updated from SVG`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
