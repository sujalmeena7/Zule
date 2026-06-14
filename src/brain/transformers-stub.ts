// ============================================================================
// Stub for @xenova/transformers
// ============================================================================
//
// The ONNX WASM backend (onnxruntime-web@1.14.0 pinned by
// @xenova/transformers@2.17) segfaults (ACCESS_VIOLATION 0xC0000005) under
// Electron 42's V8 when instantiating the WASM module. Until onnxruntime-web
// is upgraded to a compatible version (or the embedding pipeline is moved to
// the Node.js main process via onnxruntime-node), this stub replaces the
// actual @xenova/transformers module in the renderer build.
//
// The stub exports the same `env` object shape vectorStore.ts configures at
// module-evaluation time, plus a `pipeline` function that always rejects with
// a descriptive error — so any code path that accidentally reaches it gets a
// clear message instead of a renderer crash.

export const env: Record<string, unknown> = {
  allowLocalModels: true,
  allowRemoteModels: true,
  useBrowserCache: true,
  localModelPath: '/vendor/models/',
  backends: {
    onnx: {
      wasm: {
        wasmPaths: '/vendor/onnx/',
        numThreads: 1,
        simd: false,
        proxy: false,
      },
    },
  },
};

export async function pipeline(): Promise<never> {
  throw new Error(
    '[transformers-stub] Embedding is disabled in this Electron build. ' +
      'onnxruntime-web@1.14.0 is binary-incompatible with Electron 42 (segfaults on WASM instantiation). ' +
      'Documents are stored with text-only chunks. Semantic search will be available once ' +
      'onnxruntime-web is upgraded or the embedding pipeline is moved to the main process.',
  );
}
