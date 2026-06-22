// ============================================================================
// Zule AI — Shared Transformers.js environment configuration
// ============================================================================
//
// Centralises the one-time `env` setup for the local ML stack so EVERY entry
// point into Transformers.js (the embedding Vector_Index *and* the local
// Whisper transcription provider) gets identical, correct configuration —
// regardless of which one is imported first.
//
// Importing this module for its side effect (`import './transformersEnv'`) is
// idempotent: ES module evaluation runs exactly once and is shared across all
// importers, so the config is applied a single time no matter how many modules
// depend on it.
//
// Why this exists as its own module: previously the config lived only in
// `vectorStore.ts`, so loading Whisper without first touching the vector store
// left `localModelPath` / `wasmPaths` at their library defaults (a CDN / wrong
// path) and broke offline model loading. A shared module removes that ordering
// dependency.

import { env } from '@huggingface/transformers';

/**
 * Resolve `public/vendor/...` to an absolute URL that works in BOTH runtimes:
 *   - Dev / web: served over http(s):// — a leading-slash path resolves to the
 *     application origin, which is correct.
 *   - Packaged Electron: loaded over `file://` — a leading-slash path resolves
 *     to the FILESYSTEM ROOT, not the app directory, so ort/Transformers.js
 *     would 404 on the WASM + model files. Computing the path relative to the
 *     current document (`index.html`) instead yields the right location.
 *
 * onnxruntime-web and Transformers.js both accept an absolute URL ending in a
 * slash for `wasmPaths` / `localModelPath`.
 */
export function resolveVendorBase(subdir: 'onnx' | 'models'): string {
  // Fallback for non-DOM contexts (tests / SSR): keep the origin-relative path.
  if (typeof document === 'undefined' || !document.baseURI) {
    return `/vendor/${subdir}/`;
  }
  // `new URL` against the document base produces the correct absolute URL under
  // both http(s):// and file://.
  return new URL(`vendor/${subdir}/`, document.baseURI).href;
}

// Model-resolution strategy (privacy / stealth / offline):
//   - Prefer the self-hosted models mirrored into `public/vendor/models/` by
//     `scripts/fetch-models.mjs`. No network call to huggingface.co on the
//     common path.
//   - Keep `allowRemoteModels = true` as a fallback so that if a local copy is
//     missing the runtime degrades to the remote HuggingFace fetch (the HF CSP
//     `connect-src` entries in index.html exist for exactly this fallback).
//   - `useBrowserCache = true` so even the fallback path is fetched at most
//     once and then served from cache.
env.allowLocalModels = true;
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.localModelPath = resolveVendorBase('models');

// Self-host the ONNX runtime WASM (Transformers.js inference backend) so it
// loads from the application origin rather than a third-party CDN
// (Requirement 15.7, 21.5). The dist files are mirrored into
// `public/vendor/onnx/` by `scripts/copy-vendor.mjs`.
//
// Guarded against test mocks of the `env` object that omit the nested
// `backends` shape (see `vectorStore.test.ts`).
type OnnxWasmFlags = {
  wasmPaths?: string;
  numThreads?: number;
  simd?: boolean;
  proxy?: boolean;
};
type OnnxBackends = { onnx?: { wasm?: OnnxWasmFlags } };
const envBackends = (env as unknown as { backends?: OnnxBackends }).backends;
if (envBackends?.onnx?.wasm) {
  envBackends.onnx.wasm.wasmPaths = resolveVendorBase('onnx');
  // Force the SINGLE-THREADED WASM backend for the WASM *fallback* path. The
  // multi-threaded backend requires SharedArrayBuffer, which needs cross-origin
  // isolation (COOP: same-origin + COEP: require-corp). main.ts strips those
  // headers for Firebase auth, so the threaded worker would hard-crash the
  // renderer. numThreads = 1 runs the SIMD-threaded build with a single thread
  // and no SharedArrayBuffer dependency. (The primary inference path is
  // WebGPU — see the `device` option on the pipeline calls — which needs
  // neither SharedArrayBuffer nor cross-origin isolation.)
  envBackends.onnx.wasm.numThreads = 1;
  // Run inference on the main thread rather than an ONNX proxy worker — the
  // models are small and the proxy worker path is another place that can fail
  // without SharedArrayBuffer.
  envBackends.onnx.wasm.proxy = false;
  // NOTE: onnxruntime-web@1.22 ships ONLY a SIMD-threaded build — there is no
  // non-SIMD kernel to fall back to, so we must NOT set `simd = false` (doing
  // so would leave no valid kernel to load). The old segfault that forced
  // simd=false was specific to onnxruntime-web@1.14 under @xenova v2, which is
  // no longer in use.
}

export { env };
