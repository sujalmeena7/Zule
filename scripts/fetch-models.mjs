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

// Each model lists the exact set of files Transformers.js loads. The renderer
// runs WebGPU (fp32) with a single-threaded WASM fallback (q8 == the
// `_quantized` onnx variant), so models that run on both devices vendor BOTH
// the full-precision and the quantized ONNX files for full offline support.
const MODELS = [
  {
    // Embeddings (Vector_Index). vectorStore.ts loads dtype:'q8' on both
    // devices, so only the quantized ONNX is needed.
    id: 'Xenova/all-MiniLM-L6-v2',
    files: [
      'config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/model_quantized.onnx',
    ],
  },
  {
    // Local Whisper (system-audio transcription). Inference runs natively in
    // the main process (onnxruntime-node) with dtype:'q8' → the `_quantized`
    // ONNX files. We also vendor the fp32 pair so the in-renderer fallback path
    // (if ever used) has its weights too. base.en is more accurate than tiny.en.
    id: 'Xenova/whisper-base.en',
    files: [
      'config.json',
      'generation_config.json',
      'preprocessor_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      // q8 / quantized (used by onnxruntime-node):
      'onnx/encoder_model_quantized.onnx',
      'onnx/decoder_model_merged_quantized.onnx',
      // fp32 (renderer fallback):
      'onnx/encoder_model.onnx',
      'onnx/decoder_model_merged.onnx',
    ],
  },
];

/** Download one file unless an up-to-date copy already exists. */
async function fetchOne(modelId, relPath, { silent }) {
  const hfBase = `https://huggingface.co/${modelId}/resolve/main`;
  const destRoot = join(projectRoot, 'public', 'vendor', 'models', modelId);
  const url = `${hfBase}/${relPath}`;
  const dest = join(destRoot, relPath);

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
  for (const model of MODELS) {
    for (const relPath of model.files) {
      try {
        if (await fetchOne(model.id, relPath, { silent })) downloaded += 1;
      } catch (err) {
        // Non-fatal: the renderer falls back to the remote HF fetch (the CSP
        // entries are retained for exactly this case). We log and continue so
        // a transient network failure during dev start doesn't block the app.
        console.warn(
          `[fetch-models] ${model.id}/${relPath}: ` +
            `${err instanceof Error ? err.message : String(err)} ` +
            `(runtime will fall back to remote HuggingFace fetch)`,
        );
      }
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
