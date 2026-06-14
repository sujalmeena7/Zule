// ============================================================================
// scripts/copy-vendor.mjs
// ============================================================================
//
// Self-host the runtime assets that the application would otherwise fetch from
// third-party CDNs (Requirement 15.7, 21.5; Audit defect "PDF.js worker fetched
// from cdnjs.cloudflare.com").
//
// At install / dev / build time this script copies the following files from
// `node_modules/` into `public/vendor/`, after which the Vite dev server and
// the production build serve them from the application origin:
//
//   - PDF.js worker         → public/vendor/pdfjs/pdf.worker.min.mjs
//   - Tesseract.js worker   → public/vendor/tesseract/worker.min.js
//   - Tesseract.js core     → public/vendor/tesseract-core/* (.js + .wasm)
//   - ONNX runtime (web)    → public/vendor/onnx/* (.wasm + worker .js)
//
// The script is idempotent: it skips a file when an up-to-date copy already
// exists at the destination (keyed on size + mtime), so running it on every
// dev-server start is cheap.
//
// The Tesseract *language* data files (`<lang>.traineddata.gz`) are NOT copied
// here. They are loaded lazily on demand and self-hosting them is the scope of
// task 15.2 ("Lazy-load Tesseract language packs on demand"). A follow-up to
// this task should also extend the application's CSP `script-src` directive to
// drop the legacy CDN origins once 15.2 lands.
//
// This script has zero runtime dependencies beyond Node's standard library so
// it can run in any environment that has `node_modules/` populated.

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const nodeModules = join(projectRoot, 'node_modules');
const publicVendor = join(projectRoot, 'public', 'vendor');

/**
 * One mapping describes a single file copy or a directory-glob copy.
 *
 *   - `from`   absolute source path (file or directory)
 *   - `to`     absolute destination path (file or directory mirroring `from`)
 *   - `match`  optional predicate, applied per filename, when `from` is a dir
 */
const mappings = [
  // --- PDF.js worker (Requirement 15.7, 21.5) -----------------------------
  {
    from: join(nodeModules, 'pdfjs-dist', 'build', 'pdf.worker.min.mjs'),
    to: join(publicVendor, 'pdfjs', 'pdf.worker.min.mjs'),
  },

  // --- Tesseract.js worker (Requirement 15.7) -----------------------------
  {
    from: join(nodeModules, 'tesseract.js', 'dist', 'worker.min.js'),
    to: join(publicVendor, 'tesseract', 'worker.min.js'),
  },

  // --- Tesseract.js-core runtime (Requirement 15.7) -----------------------
  // Copy the full set so the worker can pick the variant matching the
  // browser's WASM feature support (plain / SIMD / relaxed-SIMD, with or
  // without the LSTM-only model loader).
  {
    from: join(nodeModules, 'tesseract.js-core'),
    to: join(publicVendor, 'tesseract-core'),
    match: (name) =>
      name.startsWith('tesseract-core') &&
      (name.endsWith('.js') || name.endsWith('.wasm')),
  },

  // --- ONNX Runtime Web — Transformers.js backend (Requirement 15.7) ------
  // Transformers.js delegates inference to onnxruntime-web, which in turn
  // fetches its WASM blobs from a CDN unless `env.backends.onnx.wasm.wasmPaths`
  // is set. We mirror the dist files so the runtime can be served from the
  // application origin.
  {
    from: join(nodeModules, 'onnxruntime-web', 'dist'),
    to: join(publicVendor, 'onnx'),
    match: (name) =>
      (name.startsWith('ort-wasm') || name === 'ort-wasm-threaded.worker.js') &&
      (name.endsWith('.wasm') || name.endsWith('.js')),
  },
];

/** Copy a single file if missing or outdated at the destination. */
function copyOne(from, to) {
  if (!existsSync(from)) {
    throw new Error(`copy-vendor: source missing → ${from}`);
  }
  mkdirSync(dirname(to), { recursive: true });

  if (existsSync(to)) {
    const src = statSync(from);
    const dst = statSync(to);
    if (src.size === dst.size && src.mtimeMs <= dst.mtimeMs) {
      return false; // up to date
    }
  }
  copyFileSync(from, to);
  return true;
}

/** Apply a single mapping. Returns the number of files copied (0 if all current). */
function applyMapping(mapping) {
  if (!existsSync(mapping.from)) {
    // Source not found — skip gracefully. This handles the case where a
    // transitive dependency (e.g. onnxruntime-web) is removed or its dist
    // directory is relocated by the package manager / Vite optimizer.
    return 0;
  }
  const fromStat = statSync(mapping.from);
  if (fromStat.isFile()) {
    return copyOne(mapping.from, mapping.to) ? 1 : 0;
  }
  if (!fromStat.isDirectory()) {
    throw new Error(`copy-vendor: unsupported source type → ${mapping.from}`);
  }
  const entries = readdirSync(mapping.from);
  let copied = 0;
  for (const name of entries) {
    if (mapping.match && !mapping.match(name)) continue;
    const src = join(mapping.from, name);
    const dst = join(mapping.to, name);
    if (statSync(src).isDirectory()) continue; // shallow only
    if (copyOne(src, dst)) copied += 1;
  }
  return copied;
}

/** Public entry point used both as a CLI script and as a Vite-plugin helper. */
export function copyVendorAssets({ silent = false } = {}) {
  const summary = [];
  for (const mapping of mappings) {
    const count = applyMapping(mapping);
    summary.push({ to: mapping.to, copied: count });
  }
  if (!silent) {
    const total = summary.reduce((sum, e) => sum + e.copied, 0);
    if (total > 0) {
      console.log(`[copy-vendor] copied ${total} file(s) into public/vendor/`);
    } else {
      console.log('[copy-vendor] all vendor assets up to date');
    }
  }
  return summary;
}

// Run when invoked directly (e.g. `node scripts/copy-vendor.mjs`).
if (import.meta.url === `file://${process.argv[1]}` ||
    fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  copyVendorAssets();
}
