# Upgrade Path: Re-enable Semantic Search (Embedding Pipeline)

## Current State (June 2026)

The embedding pipeline (`@xenova/transformers@2.17.2` → `onnxruntime-web@1.14.0`) is **disabled** in the renderer because `onnxruntime-web@1.14.0` segfaults (Windows ACCESS_VIOLATION `0xC0000005`) under Electron 42's V8 when instantiating the WASM module.

**What's in place today:**
- `@xenova/transformers` is aliased to a no-op stub (`src/brain/transformers-stub.ts`) in `vite.electron.config.ts`.
- Document uploads in `Settings.tsx` store text-only chunks (empty `vector: []`). Keyword search works; semantic similarity search does not.
- The self-hosted model files remain in `public/vendor/models/Xenova/all-MiniLM-L6-v2/` (ready to use once the runtime is fixed).
- The ONNX WASM files remain in `public/vendor/onnx/` (copied by `scripts/copy-vendor.mjs` when `onnxruntime-web/dist` exists).
- CSP in `index.html` includes `'wasm-unsafe-eval'` in `script-src` and HuggingFace domains in `connect-src` as a fallback.

## Root Cause

`onnxruntime-web@1.14.0` (January 2023) ships WASM binaries compiled against an older V8 ABI. Electron 42 bundles a much newer V8 (Chromium 132+). The mismatch causes a native memory access violation inside the WASM linear memory when the ONNX session is created — this is a hard crash (segfault), not a catchable JS exception.

## Option A: Upgrade `@xenova/transformers` to v3 (Recommended)

`@xenova/transformers` v3 (now published as `@huggingface/transformers`) ships `onnxruntime-web@1.19+` which is built against a modern V8 ABI and works with Electron 40+.

**Steps:**
1. `npm uninstall @xenova/transformers`
2. `npm install @huggingface/transformers` (check the latest version on npm)
3. Update imports in `src/brain/vectorStore.ts`:
   ```ts
   // Before:
   import { pipeline, env } from '@xenova/transformers';
   // After:
   import { pipeline, env } from '@huggingface/transformers';
   ```
4. Remove the stub alias in `vite.electron.config.ts`:
   - Delete the `find: /^@xenova\/transformers$/` alias entry
   - Delete the `find: /^onnxruntime-web/` alias entry
   - Delete `'@xenova/transformers'` and `'onnxruntime-web'` from `optimizeDeps.exclude`
5. Delete `src/brain/transformers-stub.ts`
6. Update the `onnxruntime-web` alias (if still needed) to point at the new package's dist:
   - Check if the new `@huggingface/transformers` ships its own ONNX or relies on a peer dep
7. Re-run `scripts/copy-vendor.mjs` to mirror the new ONNX WASM files into `public/vendor/onnx/`
8. In `Settings.tsx`, restore the embedding loop:
   ```ts
   const { vectorStore } = await import('../brain/vectorStore');
   for (const chunk of chunks) {
     const vector = await vectorStore.generateEmbedding(chunk);
     chunksWithVectors.push({ text: chunk, vector });
   }
   ```
9. Test: upload a document → verify no crash, vectors are generated, semantic search returns results.
10. Re-download the model if the model ID changed:
    ```
    node scripts/fetch-models.mjs
    ```

## Option B: Move Embedding to the Main Process (Node.js)

Use `onnxruntime-node` (native binary, no WASM) in the Electron main process. The renderer sends text chunks via IPC and gets vectors back.

**Steps:**
1. `npm install onnxruntime-node`
2. Create `electron/embeddingWorker.ts` that loads the model using `onnxruntime-node` and exposes an `embed(text: string): number[]` function.
3. Register an IPC handler in `electron/main.ts`:
   ```ts
   ipcMain.handle('generate-embedding', async (_event, text: string) => {
     return embeddingWorker.embed(text);
   });
   ```
4. Expose in `electron/preload.ts`:
   ```ts
   generateEmbedding: (text: string): Promise<number[]> =>
     ipcRenderer.invoke('generate-embedding', text),
   ```
5. In `Settings.tsx`, call the IPC instead of importing vectorStore:
   ```ts
   const vector = await window.electronAPI.generateEmbedding(chunk);
   ```
6. The renderer never loads ONNX WASM — no crash risk.
7. Remove the stub alias and `optimizeDeps.exclude` entries from the Vite config.

**Tradeoff:** adds IPC serialization overhead per chunk (~1-2ms) but the main process has full native Node.js access with no WASM compatibility issues.

## Files to Touch

| File | What to change |
|------|----------------|
| `vite.electron.config.ts` | Remove `@xenova/transformers` and `onnxruntime-web` aliases + exclude entries |
| `src/brain/transformers-stub.ts` | Delete entirely |
| `src/brain/vectorStore.ts` | Update import from `@xenova/transformers` to `@huggingface/transformers` (Option A) |
| `src/components/Settings.tsx` | Restore the embedding loop in `handleAddDocument` |
| `scripts/copy-vendor.mjs` | Verify the new ONNX dist path matches |
| `scripts/fetch-models.mjs` | Update model ID if it changed in v3 |
| `package.json` | Swap dep; add `overrides` if needed |

## How to Verify

1. Upload a PDF/DOCX in Settings → Knowledge Base
2. Confirm no renderer crash (DevTools stays connected)
3. Confirm the document shows chunks with non-empty vectors in IndexedDB
4. Search for a concept from the document → semantic results returned

## Notes

- The `vectorStore.test.ts` mocks `@xenova/transformers` via `vi.mock` — those tests will continue to pass regardless of the runtime because they never instantiate real ONNX.
- The `env.backends.onnx.wasm.numThreads = 1` and `simd = false` settings in `vectorStore.ts` can be removed once `onnxruntime-web@1.19+` is confirmed stable under Electron 42+.
- The self-hosted model in `public/vendor/models/` and the HuggingFace CSP fallback should be preserved regardless of which option you choose — they're orthogonal to the runtime fix.
