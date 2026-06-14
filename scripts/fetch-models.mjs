// ============================================================================
// scripts/fetch-models.mjs
// ============================================================================
//
// Self-host the Transformers.js embedding model so the renderer never has to
// reach huggingface.co at runtime (privacy / stealth / offline — matches the
// self-hosting intent of Requirement 15.7, 21.5 already applied to the ONNX
// runtime, PDF.js worker, and Tesseract core).
//
// Downloads the quantized `Xenova/all-MiniLM-L6-v2` feature-extraction model
// into `public/vendor/models/Xenova/all-MiniLM-L6-v2/`, mirroring the exact
// directory layout Transformers.js expects when `env.localModelPath` points
// at `/vendor/models/`:
//
//   public/vendor/models/Xenova/all-MiniLM-L6-v2/
//     ├── config.json
//     ├── tokenizer.json
//     ├── tokenizer_config.json
//     └── onnx/model_quantized.onnx
//
// The script is idempotent: a file already present on disk is skipped, so it
// is cheap to run on every dev-server start and only performs network I/O the
// first time (or when a file is missing).
//
// Network access is required ONLY on first run. After the files are mirrored,
// the application embeds fully offline. The HuggingFace CSP `connect-src`
// entries are retained as a runtime fallback in case these files are ever
// absent (see index.html and vectorStore.ts `allowRemoteModels`).

import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

// The model id and the exact set of files Transformers.js loads for a
// quantized feature-extraction pipeline. (The pipeline in vectorStore.ts is
// created with the default `quantized: true`, so it fetches
// `onnx/model_quantized.onnx` — not the full-precision `onnx/model.onnx`.)
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const HF_BASE = `https://huggingface.co/${MODEL_ID}/resolve/main`;
const DEST_ROOT = join(projectRoot, 'public', 'vendor', 'models', MODEL_ID);

const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx',
];

/** Download one file unless an up-to-date copy already exists. */
async function fetchOne(relPath, { silent }) {
  const url = `${HF_BASE}/${relPath}`;
  const dest = join(DEST_ROOT, relPath);

  if (existsSync(dest) && statSync(dest).size > 0) {
    return false; // already present — idempotent skip
  }

  mkdirSync(dirname(dest), { recursive: true });

  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(
      `fetch-models: failed to download ${url} → HTTP ${res.status} ${res.statusText}`,
    );
  }

  // Stream the response body to disk so large weights don't sit in memory.
  await streamPipeline(Readable.fromWeb(res.body), createWriteStream(dest));

  if (!silent) {
    const kb = Math.round(statSync(dest).size / 1024);
    console.log(`[fetch-models] downloaded ${relPath} (${kb} KB)`);
  }
  return true;
}

/** Public entry point — also callable from the Vite plugin. */
export async function fetchModels({ silent = false } = {}) {
  let downloaded = 0;
  for (const relPath of FILES) {
    try {
      if (await fetchOne(relPath, { silent })) downloaded += 1;
    } catch (err) {
      // Non-fatal: the renderer falls back to the remote HF fetch (the CSP
      // entries are retained for exactly this case). We log and continue so
      // a transient network failure during dev start doesn't block the app.
      console.warn(
        `[fetch-models] ${err instanceof Error ? err.message : String(err)} ` +
          `(runtime will fall back to remote HuggingFace fetch)`,
      );
    }
  }
  if (!silent) {
    console.log(
      downloaded > 0
        ? `[fetch-models] mirrored ${downloaded} model file(s) into public/vendor/models/`
        : '[fetch-models] embedding model already present — nothing to download',
    );
  }
  return downloaded;
}

// Run when invoked directly (e.g. `node scripts/fetch-models.mjs`).
if (
  import.meta.url === `file://${process.argv[1]}` ||
  fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')
) {
  fetchModels().catch((err) => {
    console.error('[fetch-models] fatal:', err);
    process.exit(1);
  });
}
