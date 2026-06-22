// ============================================================================
// Zule AI — Main-Process Whisper Service (onnxruntime-node)
// ============================================================================
//
// Runs local Whisper speech-to-text in the ELECTRON MAIN PROCESS using
// `@huggingface/transformers`'s `node` build, which is backed by the NATIVE
// `onnxruntime-node` engine.
//
// Why this lives in the main process and not the renderer:
//   The renderer's onnxruntime-WEB backend (WASM + WebGPU) natively crashes the
//   Electron 42 renderer with exit code 0xC0000005 (ACCESS_VIOLATION) the
//   instant it builds an inference session — confirmed across both backends and
//   two onnxruntime versions. The native node engine does not touch V8's WASM
//   runtime, so that class of crash is structurally impossible here. A proof of
//   concept loaded the vendored model in ~760 ms and transcribed 2 s of audio
//   in ~630 ms (~3× real-time).
//
// The renderer still does audio CAPTURE (getDisplayMedia / AudioContext are
// browser-only), then ships 16 kHz mono Float32 PCM chunks here over IPC; this
// module transcribes them and returns text.

// `electron` is CommonJS with no named ESM exports; this main-process module is
// bundled as ESM, so obtain `app` via createRequire (see electron/main.ts).
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { app } = require('electron') as typeof import('electron');

// ESM has no __dirname; reconstruct it from import.meta.url (resolves to
// dist-electron/ at runtime for the bundled chunk).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Loaded lazily via dynamic import so the (externalized) native ML stack is
// only resolved when the user actually enables system-audio transcription.
// `pipeline`/`env` come from the package's `node` export condition →
// transformers.node + onnxruntime-node.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WhisperPipeline = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text?: string }>;

// base.en is noticeably more accurate than tiny.en (better punctuation/question
// detection), which directly improves autonomous question-triggering. Still fast
// on a multi-core machine via the native node engine.
const DEFAULT_MODEL_ID = 'Xenova/whisper-base.en';

let transcriber: WhisperPipeline | null = null;
let loadPromise: Promise<WhisperPipeline> | null = null;
// Serialize inference: one session, one call at a time. Overlapping 2 s chunks
// would otherwise re-enter the native session concurrently.
let inferenceChain: Promise<unknown> = Promise.resolve();

/**
 * Absolute path to the directory that contains the vendored models, i.e. the
 * folder holding `Xenova/whisper-tiny.en/...`. Transformers' node build reads
 * model files from disk under `env.localModelPath`.
 *
 * - Dev: the source tree's `public/vendor/models`.
 * - Packaged: `<app>/dist/vendor/models` (Vite copies `public/` → `dist/`,
 *   which is packaged). Model files are read with `fs.readFile`, which Electron
 *   transparently serves from inside the asar.
 */
function resolveModelsDir(): string {
  // `__dirname` resolves to `dist-electron/` at runtime for the bundled main.
  // Guard `app` access: outside a real Electron main process (e.g. tests/Node)
  // `app` may be undefined — default to the packaged layout.
  const packaged = app?.isPackaged ?? true;
  const base = packaged
    ? path.join(__dirname, '..', 'dist', 'vendor', 'models')
    : path.join(__dirname, '..', 'public', 'vendor', 'models');
  // Transformers appends `<modelId>/<file>`; a trailing separator keeps the
  // join correct on all platforms.
  return base + path.sep;
}

/** Load (once) and return the ASR pipeline. Concurrent callers share one load. */
async function ensurePipeline(modelId: string): Promise<WhisperPipeline> {
  if (transcriber) return transcriber;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const t0 = Date.now();
    // Dynamic, externalized import → resolves transformers.node + onnxruntime-node.
    const { pipeline, env } = (await import('@huggingface/transformers')) as unknown as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pipeline: (task: string, model: string, opts?: any) => Promise<any>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env: any;
    };

    // Read the vendored model from disk; never reach the network (it's bundled).
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.localModelPath = resolveModelsDir();

    console.info(`[whisperService] loading ${modelId} from ${env.localModelPath}`);
    const asr = (await pipeline('automatic-speech-recognition', modelId, {
      dtype: 'q8',
    })) as unknown as WhisperPipeline;
    console.info(`[whisperService] model ready in ${Date.now() - t0}ms`);

    transcriber = asr;
    return asr;
  })();

  try {
    return await loadPromise;
  } catch (err) {
    // Reset so a later attempt can retry rather than being stuck on a rejected
    // promise.
    loadPromise = null;
    throw err;
  }
}

/** Pre-warm the model (called when the user toggles system audio on). */
export async function preloadWhisper(modelId: string = DEFAULT_MODEL_ID): Promise<void> {
  await ensurePipeline(modelId);
}

/**
 * Transcribe one chunk of 16 kHz mono Float32 PCM. Calls are serialized so the
 * native session is never re-entered concurrently. Returns the trimmed text
 * ('' for silence).
 */
export async function transcribePcm(
  pcm: Float32Array,
  opts: { language?: string; modelId?: string } = {},
): Promise<string> {
  const asr = await ensurePipeline(opts.modelId ?? DEFAULT_MODEL_ID);

  const run = inferenceChain.then(async () => {
    // NOTE: do NOT pass `language`/`task` for the English-only `*.en` model —
    // transformers throws "Cannot specify task or language for an English-only
    // model". (A multilingual model would accept them.)
    const result = await asr(pcm);
    return (result?.text ?? '').trim();
  });

  // Keep the chain alive even if this run throws, so the next call still runs.
  inferenceChain = run.catch(() => undefined);
  return run;
}

/** Release the model/session (called when the user toggles system audio off). */
export function releaseWhisper(): void {
  transcriber = null;
  loadPromise = null;
  inferenceChain = Promise.resolve();
}
