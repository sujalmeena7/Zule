// ============================================================================
// Zule AI — Main-Process Embedding Service (onnxruntime-node)
// ============================================================================
//
// Runs the feature-extraction (text embedding) model in the ELECTRON MAIN
// PROCESS using `@huggingface/transformers`'s native `node` build, for the same
// reason as electron/whisperService.ts: the renderer's onnxruntime-WEB backend
// (WASM/WebGPU) natively crashes the Electron 42 renderer with 0xC0000005 when
// it builds an inference session. The native node engine sidesteps that
// entirely.
//
// The renderer's `vectorStore` delegates here over IPC (embed:generate) and
// keeps doing everything else (LRU cache, quantization, cosine similarity) in
// the renderer — only the model inference moves out of process.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { app } = require('electron') as typeof import('electron');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Extractor = (text: string, opts?: Record<string, unknown>) => Promise<{ data: ArrayLike<number> }>;

let extractor: Extractor | null = null;
let loadPromise: Promise<Extractor> | null = null;
// Serialize inference so the native session is never re-entered concurrently.
let chain: Promise<unknown> = Promise.resolve();

/** Vendored models dir (mirrors whisperService.resolveModelsDir). */
function resolveModelsDir(): string {
  const packaged = app?.isPackaged ?? true;
  const base = packaged
    ? path.join(__dirname, '..', 'dist', 'vendor', 'models')
    : path.join(__dirname, '..', 'public', 'vendor', 'models');
  return base + path.sep;
}

async function ensureExtractor(modelId: string): Promise<Extractor> {
  if (extractor) return extractor;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const t0 = Date.now();
    const { pipeline, env } = (await import('@huggingface/transformers')) as unknown as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pipeline: (task: string, model: string, opts?: any) => Promise<any>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env: any;
    };
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.localModelPath = resolveModelsDir();

    console.info(`[embeddingService] loading ${modelId} from ${env.localModelPath}`);
    const ex = (await pipeline('feature-extraction', modelId, {
      dtype: 'q8',
    })) as unknown as Extractor;
    console.info(`[embeddingService] model ready in ${Date.now() - t0}ms`);

    extractor = ex;
    return ex;
  })();

  try {
    return await loadPromise;
  } catch (err) {
    loadPromise = null;
    throw err;
  }
}

/** Pre-warm the embedding model. */
export async function preloadEmbedding(modelId: string = DEFAULT_MODEL_ID): Promise<void> {
  await ensureExtractor(modelId);
}

/**
 * Generate a mean-pooled, normalized embedding for `text`. Returns a plain
 * number[] (structured-cloneable over IPC). Calls are serialized.
 */
export async function generateEmbedding(
  text: string,
  opts: { modelId?: string } = {},
): Promise<number[]> {
  const ex = await ensureExtractor(opts.modelId ?? DEFAULT_MODEL_ID);
  const run = chain.then(async () => {
    const out = await ex(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data);
  });
  chain = run.catch(() => undefined);
  return run;
}

/**
 * Sub-batch window used by callers that want to bound IPC payload size and
 * keep individual native-session entries short. The Settings upload path
 * issues one IPC per window of this size; this service itself processes
 * whatever it receives in a single serialized chain entry.
 */
export const EMBED_BATCH_SIZE = 32;

const WHITESPACE_ONLY = /^\s*$/;

/**
 * Generate mean-pooled, L2-normalized embeddings for an array of texts.
 *
 * Behavior:
 * - An empty input returns `[]` immediately without loading or invoking the
 *   model (Requirement 1.2).
 * - Each input is pre-classified: whitespace-only entries (matching
 *   `/^\s*$/`, including empty strings) yield a zero-length vector at the
 *   corresponding output index; real entries are passed through the
 *   extractor (Requirement 1.3).
 * - Output indices match input indices exactly (Requirement 1.1).
 * - The same extractor configuration as `generateEmbedding`
 *   (mean-pool + L2-normalize, `dtype: 'q8'`) is reused, so the batched
 *   vector for a given text is element-wise equal to the single-call
 *   vector for the same text and model id (Requirement 1.4).
 * - All real-entry inferences for a single batch run inside one entry on
 *   the module-level `chain` so the native session is never re-entered
 *   concurrently with any other embedding call.
 *
 * The `batchSize` option is part of the public surface so callers can pass
 * `EMBED_BATCH_SIZE` for symmetry; sub-batching across windows is performed
 * by the renderer (one IPC per window) and not inside this function.
 */
export async function generateEmbeddingBatch(
  texts: readonly string[],
  opts: { modelId?: string; batchSize?: number } = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];

  // Pre-classify each input. Whitespace-only entries get a zero-length
  // vector at their original index; real entries are queued for inference.
  const result: number[][] = new Array(texts.length);
  const realIndices: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    if (WHITESPACE_ONLY.test(texts[i])) {
      result[i] = [];
    } else {
      realIndices.push(i);
    }
  }

  if (realIndices.length === 0) return result;

  const ex = await ensureExtractor(opts.modelId ?? DEFAULT_MODEL_ID);

  const run = chain.then(async () => {
    for (const i of realIndices) {
      const out = await ex(texts[i], { pooling: 'mean', normalize: true });
      result[i] = Array.from(out.data);
    }
    return result;
  });
  chain = run.catch(() => undefined);
  return run;
}

