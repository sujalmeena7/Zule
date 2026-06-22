// ============================================================================
// Stub for onnxruntime-node (renderer build)
// ============================================================================
//
// `@huggingface/transformers`'s ONNX backend statically imports BOTH
// `onnxruntime-node` and `onnxruntime-web` at module-evaluation time
// (see node_modules/@huggingface/transformers/src/backends/onnx.js:23):
//
//     import * as ONNX_NODE from 'onnxruntime-node';
//
// The import is unconditional — the library only *uses* it when running under
// Node (`apis.IS_NODE_ENV`), but the import is still resolved by the bundler.
// `onnxruntime-node` is a CommonJS package with a native `.node` binding and no
// browser entry point, so following it in our sandboxed (contextIsolation,
// no nodeIntegration) renderer build would break Vite resolution / crash at
// runtime. We alias it to this empty module in `vite.electron.config.ts`.
//
// IMPORTANT: unlike `transformers-stub.ts`, this must NOT throw — it is
// evaluated eagerly at import time. The web backend (`onnxruntime-web`,
// WebGPU/WASM) is what actually runs inference in the renderer.

export default {};
