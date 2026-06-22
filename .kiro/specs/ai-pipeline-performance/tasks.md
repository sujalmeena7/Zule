# Implementation Plan: AI Pipeline Performance

## Overview

This plan delivers the three bundled performance improvements defined in the
design — batched embedding IPC, an HNSW Vector_Index in the main process, and a
VAD-gated transcription pipeline — as a sequence of incremental TypeScript
tasks. Each top-level task builds on the previous ones: shared types and
telemetry come first; then each performance improvement is implemented in its
own track (main-process service → renderer integration → tests); finally the
three tracks are integrated and the performance benchmarks are wired in.

Convert the feature design into a series of prompts for a code-generation LLM
that will implement each step with incremental progress. Make sure that each
prompt builds on the previous prompts, and ends with wiring things together.
There should be no hanging or orphaned code that isn't integrated into a
previous step. Focus ONLY on tasks that involve writing, modifying, or
testing code.

## Tasks

- [x] 1. Establish shared types, telemetry, and IPC bridges
  - [x] 1.1 Extend `MetricEvent` in `src/brain/telemetry.ts` with the three new variants `embed.batch`, `vectorIndex.query`, and `vad.skipped`
    - Add only numeric and fixed-string-literal fields (no free-form payload), so the existing structural Property 51 keeps holding for the new variants
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [x] 1.2 Extend `ZuleError` in `src/types/errors.ts` with the three new variants `vector-index.query-invalid`, `vector-index.snapshot-corrupt`, and `transcription.vad-failed`
    - Use the discriminated-union shapes specified in the Error Handling section of the design
    - _Requirements: 2.7, 3.4, 5.5_

  - [x] 1.3 Define the shared Vector_Index data types in a new module `src/types/vectorIndex.ts`
    - Export `IndexedItem`, `QueryHit`, and `VectorIndexManifest` matching the schema in the Data Models section of the design
    - _Requirements: 2.1, 3.3, 3.4_

  - [x] 1.4 Bridge the new IPC channels in `electron/preload.ts` and update the `window.electronAPI` typings
    - Expose `embed:generateBatch`, `vectorIndex:rebuild`, `vectorIndex:addBatch`, `vectorIndex:remove`, `vectorIndex:query`, and `vectorIndex:flush` through `contextBridge.exposeInMainWorld`
    - _Requirements: 1.1, 2.1, 2.5, 2.6, 3.1, 3.3_

- [x] 2. Implement the batched embedding service in the main process
  - [x] 2.1 Implement `generateEmbeddingBatch` in `electron/embeddingService.ts`
    - Define and export `EMBED_BATCH_SIZE = 32`
    - Pre-classify each input as `'whitespace'` (returns `[]` at that index) or `'real'`, preserving original positions on the output
    - Reuse the existing extractor (mean-pool + L2-normalise + `dtype: 'q8'`) and run all calls inside the existing module-level `chain` so the native session is never re-entered concurrently
    - Return `[]` synchronously when the input array is empty without touching the pipeline
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 2.2 Register the `embed:generateBatch` IPC handler in `electron/main.ts`
    - Wire the handler to `generateEmbeddingBatch` and return `{ vectors }`
    - _Requirements: 1.1_

  - [x]* 2.3 Property test for batched embedding ordering and whitespace handling in `src/brain/embeddingBatch.test.ts` (use `stubExtractor` double — no real ONNX load)
    - **Property 1: Batched embedding preserves order, length, and whitespace gaps**
    - **Validates: Requirements 1.1, 1.3**

  - [ ]* 2.4 Property test for batched/single equivalence in `src/brain/embeddingBatch.test.ts`
    - **Property 2: Batched-call vector matches single-call vector**
    - **Validates: Requirements 1.4**

  - [ ]* 2.5 Example test for empty-array short-circuit in `src/brain/embeddingBatch.test.ts`
    - Assert `generateEmbeddingBatch([])` returns `[]` and the stub extractor is never invoked
    - _Requirements: 1.2_

- [x] 3. Migrate the document upload path to batched embedding
  - [x] 3.1 Add a `chunkArray` helper and rewire `Settings.handleAddDocument` in `src/components/Settings.tsx` to issue one `embed:generateBatch` call per `EMBED_BATCH_SIZE = 32` window, with per-batch try/catch fallback to per-chunk `embed:generate` for any batch that throws, and emit one `embed.batch` telemetry event per resolved batch carrying `batchSize` and `durationMs`
    - _Requirements: 1.5, 1.6, 1.7, 10.1_

  - [ ]* 3.2 Property test for upload IPC count bound in `src/brain/embeddingBatch.test.ts`
    - **Property 3: Document upload IPC count is bounded by ceil(N / EMBED_BATCH_SIZE)**
    - **Validates: Requirements 1.5**

  - [ ]* 3.3 Property test for batch failure fallback in `src/brain/embeddingBatch.test.ts`
    - **Property 4: Batch failure falls back to per-chunk and every text persists**
    - **Validates: Requirements 1.7**

  - [ ]* 3.4 Property test for embed.batch telemetry emission in `src/brain/embeddingBatch.test.ts`
    - **Property 19: Batched embedding emits exactly one telemetry event per call**
    - **Validates: Requirements 10.1**

- [x] 4. Checkpoint — batched embedding is wired end-to-end
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Build the Vector_Index service in the main process
  - [x] 5.1 Implement the core of `electron/vectorIndexService.ts`
    - Add `hnswlib-node` as a runtime dependency and configure `HierarchicalNSW` with `space='cosine'`, `numDimensions=384`, `maxElements=100000` (resize at 90 percent), `M=16`, `efConstruction=200`, `efSearch=64`
    - Implement `queryIndex(vector, k)` returning at most `min(k, n)` `QueryHit`s in non-increasing score order, returning `[]` and emitting `vector-index.query-invalid` when `k <= 0` or `vector.length !== dim`
    - Implement `addBatchToIndex` with monotonically-increasing uint32 label assignment via a `Map<string, number>` and inverse map
    - Implement `removeFromIndex` via `markDelete(label)` and exclude marked labels from query results
    - Implement `rebuildVectorIndex(items, dim)` that resets the index and the label maps
    - Implement a debounced flush scheduler (`1 s` tail) shared by add/remove/rebuild
    - _Requirements: 2.1, 2.2, 2.5, 2.6, 2.7_

  - [x] 5.2 Implement snapshot persistence in `electron/vectorIndexService.ts`
    - Implement `flushIndex` that serialises via `writeIndexSync` to `<userData>/vector-index.bin` and writes the `VectorIndexManifest` JSON to `<userData>/vector-index.json`
    - Implement `preloadVectorIndex` that loads both files, validates `version === 1`, `modelId === currentModelId`, and `dim`/`count` match the runtime, and on any mismatch or read error deletes both files and emits `vector-index.snapshot-corrupt` with the appropriate reason
    - Wire a synchronous `flushIndex` into the existing `app.on('before-quit')` handler in `electron/main.ts`
    - _Requirements: 3.1, 3.3, 3.4_

  - [x] 5.3 Register `vectorIndex:*` IPC handlers in `electron/main.ts`
    - Wire `vectorIndex:rebuild`, `vectorIndex:addBatch`, `vectorIndex:remove`, `vectorIndex:query`, and `vectorIndex:flush` to the service; emit one `vectorIndex.query` telemetry event per resolved query through `ipc-sync-message` carrying `k`, `resultCount`, and `durationMs`
    - _Requirements: 2.1, 2.5, 2.6, 3.3, 10.2_

  - [x]* 5.4 Property test for query well-formedness in `src/brain/vectorIndexClient.test.ts`
    - **Property 5: Vector_Index query is well-formed**
    - **Validates: Requirements 2.1, 2.2**

  - [x]* 5.5 Property test for add/remove visibility round-trip in `src/brain/vectorIndexClient.test.ts`
    - **Property 6: Visibility round-trip — add then remove**
    - **Validates: Requirements 2.5, 2.6**

  - [x]* 5.6 Property test for malformed query inputs in `src/brain/vectorIndexClient.test.ts`
    - **Property 7: Malformed query inputs yield an empty result and a typed error**
    - **Validates: Requirements 2.7**

  - [ ]* 5.7 Property test for snapshot persistence round-trip in `src/electron-tests/vectorIndexService.test.ts` (drives the main-process service against a temp-dir snapshot)
    - **Property 8: Vector_Index persistence round-trip preserves the live id-set**
    - **Validates: Requirements 3.3**

  - [ ]* 5.8 Property test for snapshot corruption recovery in `src/electron-tests/vectorIndexService.test.ts`
    - **Property 9: Snapshot load failure triggers rebuild**
    - **Validates: Requirements 3.4**

  - [ ]* 5.9 Property test for vectorIndex.query telemetry emission in `src/brain/vectorIndexClient.test.ts`
    - **Property 20: Vector_Index query emits exactly one telemetry event per call**
    - **Validates: Requirements 10.2**

- [x] 6. Integrate the Vector_Index from the renderer
  - [x] 6.1 Add a `dequantizeFromStorage(chunk)` export in `src/brain/vectorStore.ts` that returns a Float32 `number[]` for both raw and `vectorQ`-stored chunks
    - This is the renderer-side wrapper consumed by `database.ts` whenever it needs to ship a chunk vector across the `vectorIndex:addBatch` boundary
    - _Requirements: 4.1_

  - [x] 6.2 Rewire `database.search` in `src/data/database.ts` and hydrate the index on app boot
    - Embed the query via the existing `embed:generate` channel, then route to `vectorIndex:query` when the chunk count is at or above `QUANTIZATION_THRESHOLD`, falling through to the legacy linear scan in `kbSearch.searchChunks` otherwise (keep `kbSearch.ts` and its tests untouched)
    - On `whenReady`, after `embedPreload` and before the Knowledge_Base UI signals ready, call `vectorIndex:rebuild` with every chunk shipped from IndexedDB whenever the main process reports a corrupt-or-missing snapshot
    - _Requirements: 2.1, 2.2, 3.1, 3.2, 4.2, 4.4_

  - [x] 6.3 Wire `Settings.handleAddDocument` to call `vectorIndex:addBatch` after `knowledgeBase.addDocument` resolves, dequantising each chunk via `dequantizeFromStorage` so the IPC payload is always Float32 `number[]`
    - _Requirements: 2.5, 4.1_

  - [x] 6.4 Wire chunk-removal paths to `vectorIndex:remove` in `src/data/database.ts` and `src/data/kbRetention.ts`
    - Ensure every code path that deletes a chunk row also notifies the index
    - _Requirements: 2.6_

  - [ ]* 6.5 Property test for quantized-storage compatibility in `src/brain/vectorIndexClient.test.ts`
    - **Property 10: Quantized chunks are dequantised before insert**
    - **Validates: Requirements 4.1**

  - [x]* 6.6 Property test for above-threshold ANN/linear-scan agreement in `src/brain/vectorIndexClient.test.ts`
    - **Property 11: Above-threshold ANN top-1 matches linear-scan top-1 for a clearly-distinct match**
    - **Validates: Requirements 4.2**

  - [ ]* 6.7 Property test for below-threshold path purity in `src/brain/vectorIndexClient.test.ts`
    - **Property 12: Below-threshold path never invokes the dequantizer**
    - **Validates: Requirements 4.4**

- [x] 7. Checkpoint — Vector_Index is hydrated, queried, and persisted
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement the VAD module and sensitivity bus
  - [x] 8.1 Implement `scoreChunk` and `mapSensitivityToThreshold` in `src/brain/transcription/vad.ts`
    - Pure module, no React, no IPC. Reject `pcm.length === 0` and any sample outside `[-2, 2]` (catches NaN/Infinity); compute per-frame RMS over disjoint 30-ms frames at 16 kHz; normalise to `clamp(median(rms_frames) / SPEECH_FLOOR, 0, 1)` with `SPEECH_FLOOR = 0.02`
    - Export `VADConfig`, `VADResult`, and a `mapSensitivityToThreshold` table with `low=0.20`, `medium=0.35`, `high=0.55` so `medium` matches the documented default
    - Add a `VAD_DISABLE_FOR_TEST` config flag honoured by `scoreChunk` callers
    - _Requirements: 5.1, 5.2, 5.3, 6.1, 6.2, 7.3, 7.6_

  - [x] 8.2 Implement the renderer-internal `vadSensitivityBus` in `src/brain/transcription/vadSensitivityBus.ts`
    - Singleton `EventTarget` exposing `subscribe(listener)`/`publish({ type: 'change', value })` so live pipelines can recompute the threshold without restarting capture
    - _Requirements: 7.4_

  - [x]* 8.3 Property test for VAD gate semantics in `src/brain/transcription/vad.test.ts` (uses `stubVAD` double — no real audio)
    - **Property 13: VAD gate semantics (parameterised over pipeline)**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.6, 6.1, 6.2**

  - [ ]* 8.4 Property test for silence-heavy IPC reduction in `src/brain/transcription/vad.test.ts`
    - **Property 14: Silence-heavy recording reduces transcribe IPC by at least 40 percent**
    - **Validates: Requirements 5.4**

  - [x]* 8.5 Property test for VAD failure fall-through in `src/brain/transcription/vad.test.ts`
    - **Property 15: VAD failure forwards the chunk and logs a typed error**
    - **Validates: Requirements 5.5**

  - [ ]* 8.6 Property test for vad.skipped telemetry counting in `src/brain/transcription/vad.test.ts`
    - **Property 21: VAD gate skip emits exactly one vad.skipped event per skipped chunk**
    - **Validates: Requirements 10.3**

- [x] 9. Insert the VAD gate into the loopback pipeline
  - [x] 9.1 Wire VAD into `src/hooks/useSystemAudioTranscription.ts`
    - Run `scoreChunk(pcm, cfg)` immediately before each `whisper:transcribe` IPC and skip the IPC when `score < cfg.speechThreshold`; never emit a `line`, `interim`, or text-derived event for a skipped chunk
    - On VAD throw or invalid score (NaN, value outside `[0, 1]`, or `undefined`), forward the chunk to `whisper:transcribe` and emit `transcription.vad-failed`
    - Emit one `vad.skipped` telemetry event with `pipeline: 'loopback'` per gated chunk
    - Subscribe to `vadSensitivityBus` on `start` and unsubscribe on teardown so live sensitivity changes apply to the next chunk without restarting capture
    - Honour `VAD_DISABLE_FOR_TEST` so the existing `useSystemAudioTranscription` integration tests in Requirement 9.3 keep their assertions
    - _Requirements: 5.1, 5.2, 5.3, 5.5, 5.6, 7.3, 7.4, 9.3, 10.3_

  - [ ]* 9.2 Property test for the loopback pipeline in `src/hooks/useSystemAudioTranscription.vad.test.ts`
    - **Property 13 (loopback parameterisation): VAD gate semantics**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.6**

- [x] 10. Insert the VAD gate into the microphone pipeline
  - [x] 10.1 Wire VAD into the local Whisper microphone path in `src/brain/providers/whisperProvider.ts`
    - Run `scoreChunk` before each `whisper:transcribe` IPC; skip the IPC and emit no transcription line when sub-threshold
    - On two consecutive sub-threshold chunks, the references `audioContext`, `processorNode`, and `mediaStream` MUST stay `===` to their pre-sequence values and `_isListening` MUST remain `true`
    - Subscribe to `vadSensitivityBus` on `start` and unsubscribe on teardown
    - Emit one `vad.skipped` telemetry event with `pipeline: 'microphone'` per gated chunk
    - _Requirements: 6.1, 6.2, 6.3, 7.3, 7.4, 10.3_

  - [ ]* 10.2 Property test for the microphone pipeline in `src/brain/providers/whisperProvider.vad.test.ts`
    - **Property 13 (microphone parameterisation): VAD gate semantics**
    - **Validates: Requirements 6.1, 6.2**

  - [ ]* 10.3 Property test for session-state preservation across silent chunks in `src/brain/providers/whisperProvider.vad.test.ts`
    - **Property 16: Two consecutive silent chunks preserve session state**
    - **Validates: Requirements 6.3**

- [x] 11. Surface the VAD sensitivity setting in the Settings page
  - [x] 11.1 Add a 3-button segmented control under the "Transcription" section of `src/components/Settings.tsx`
    - On mount, populate the control via `database.getSetting('vadSensitivity', 'medium')`
    - On change, persist via `database.saveSetting('vadSensitivity', value)` and `vadSensitivityBus.publish({ type: 'change', value })` so live pipelines recompute the threshold without restarting capture
    - When either pipeline reports a failed runtime state (`isSupported === false` or a `lastError`), render the control disabled with the failure reason inline
    - _Requirements: 7.1, 7.2, 7.4, 7.5, 7.6_

  - [ ]* 11.2 Property test for sensitivity round-trip in `src/components/Settings.vadSensitivity.test.tsx`
    - **Property 17: Sensitivity round-trip — persisted level configures pipeline threshold**
    - **Validates: Requirements 7.2, 7.3**

  - [ ]* 11.3 Property test for live sensitivity broadcast in `src/components/Settings.vadSensitivity.test.tsx`
    - **Property 18: Live sensitivity change is applied without restarting capture**
    - **Validates: Requirements 7.4**

  - [ ]* 11.4 Example tests for Settings UI behaviour in `src/components/Settings.vadSensitivity.test.tsx`
    - Settings renders three sensitivity options _Requirements: 7.1_
    - Settings disables the control when a pipeline is in a failed runtime state _Requirements: 7.5_
    - `mapSensitivityToThreshold('medium')` equals the documented default speech threshold _Requirements: 7.6_

- [x] 12. Wire the performance and offline benchmarks
  - [ ]* 12.1 Upload-batching wall-clock benchmark in `tests/integration/uploadBatching.bench.ts`
    - Upload a 100-chunk fixture document via the per-chunk path and the batched path on the reference machine; assert `batchedDuration / perChunkDuration <= 0.4`
    - _Requirements: 1.6_

  - [ ]* 12.2 Vector_Index latency benchmark in `tests/integration/vectorIndex.latency.bench.ts`
    - Build a 50 000-chunk index, run 1 000 random queries, assert P95 latency at `k=10` is at most 50 ms
    - _Requirements: 2.3_

  - [ ]* 12.3 Vector_Index recall benchmark in `tests/integration/vectorIndex.recall.bench.ts`
    - Compare ANN top-10 against an exact cosine top-10 over a 5 000-chunk benchmark KB across 100 random queries; assert mean recall at `k=10` is at least 0.95
    - _Requirements: 2.4_

  - [ ]* 12.4 Vector_Index cold-start benchmark in `tests/integration/vectorIndex.coldStart.bench.ts`
    - Pre-build and persist a 50 000-chunk snapshot, time `preloadVectorIndex()` from a fresh main-process boot; assert load time at most 2 s
    - _Requirements: 3.1_

  - [ ]* 12.5 Offline-egress smoke test in `tests/integration/offline.bench.ts`
    - Run a representative session (upload + search + 10 s of loopback transcription) with a `fetch` spy and the IPC bridge wrapped to detect any HTTP call; assert no non-localhost URL is contacted
    - _Requirements: 8.1_

- [x] 13. Final checkpoint — feature complete
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP. They cover property tests, example tests, and integration benchmarks.
- Each implementation task references granular acceptance-criteria clauses (e.g. `2.5`, `4.1`) for traceability back to requirements.md.
- Each property-test task references exactly one design property, annotated with its property number and the requirements clause it validates.
- Property tests use the `stubExtractor` and `stubVAD` doubles described in the design's Testing Strategy section; they do not load the real ONNX model.
- The legacy linear scan in `kbSearch.ts` and its existing test suite stay untouched (Requirement 9.2). The Vector_Index path is opt-in above `QUANTIZATION_THRESHOLD`.
- Checkpoint tasks are placed at three natural integration points: after batched embedding, after Vector_Index integration, and after the full feature is wired.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "2.1", "6.1", "8.1", "8.2"] },
    { "id": 1, "tasks": ["1.4", "5.1", "8.3"] },
    { "id": 2, "tasks": ["5.2", "2.2", "8.4"] },
    { "id": 3, "tasks": ["5.3", "5.7", "8.5"] },
    { "id": 4, "tasks": ["3.1", "6.2", "9.1", "10.1", "5.4", "5.8", "8.6"] },
    { "id": 5, "tasks": ["6.4", "9.2", "10.2", "5.5"] },
    { "id": 6, "tasks": ["6.3", "10.3", "5.6"] },
    { "id": 7, "tasks": ["11.1", "5.9", "2.3"] },
    { "id": 8, "tasks": ["11.2", "6.5", "2.4"] },
    { "id": 9, "tasks": ["11.3", "6.6", "2.5"] },
    { "id": 10, "tasks": ["11.4", "6.7", "3.2"] },
    { "id": 11, "tasks": ["3.3"] },
    { "id": 12, "tasks": ["3.4"] },
    { "id": 13, "tasks": ["12.1", "12.2", "12.3", "12.4", "12.5"] }
  ]
}
```
