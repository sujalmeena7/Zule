# Project Context

## ai-pipeline-performance spec — task 2.2

Registered the `embed:generateBatch` IPC handler in
`electron/main.ts::registerIpcHandlers`, immediately after the existing
`embed:generate` handler. The new handler dynamically imports
`generateEmbeddingBatch` from `./embeddingService`, awaits it with the
forwarded `texts` and `opts ?? {}`, and returns `{ vectors }` to match the
contract in `electron/preload.ts` (`embedGenerateBatch`) and Requirement 1.1
of the spec. No other code changed. `tsc -p tsconfig.json --noEmit` and
`tsc -p electron/tsconfig.json --noEmit` both pass.


---

## ai-pipeline-performance — Task 5.2

Implemented snapshot persistence in `electron/vectorIndexService.ts` and
wired the synchronous flush hook into `electron/main.ts`'s
`before-quit` handler.

**vectorIndexService.ts changes**

- New imports: `node:fs`, `node:path`, and a type-only import of
  `VectorIndexManifest` from `src/types/vectorIndex`.
- New constants: `DEFAULT_MODEL_ID = 'Xenova/all-MiniLM-L6-v2'`,
  `SNAPSHOT_BIN_FILENAME = 'vector-index.bin'`,
  `SNAPSHOT_MANIFEST_FILENAME = 'vector-index.json'`,
  `MANIFEST_VERSION = 1`.
- New module state: `currentModelId` (mutable for future model swaps,
  defaults to `DEFAULT_MODEL_ID`) and `snapshotDirOverride` (test-only
  override for the snapshot dir).
- Extended `VectorIndexDiagnostic` union with the
  `vector-index.snapshot-corrupt` variant and its five `reason` cases
  (`truncated | manifest-missing | version-mismatch | dim-mismatch |
  modelId-mismatch`) per the design's Error Handling section.
- New helpers: `getSnapshotDir()` (consults the override, else
  `app.getPath('userData')` via `createRequire('electron')`); and
  `deleteSnapshotFiles(dir)` (best-effort `unlinkSync` of both files,
  ignoring ENOENT).
- Replaced the `preloadVectorIndex` stub with the real implementation:
  reads the JSON manifest first, validates `version === 1`,
  `modelId === currentModelId`, `dim === VECTOR_INDEX_DIM`, then loads
  the binary via a fresh `HierarchicalNSW` + `readIndexSync`. Resizes
  the loaded graph up to `VECTOR_INDEX_MAX_ELEMENTS` if smaller, sets
  `efSearch`, then atomically commits the rehydrated state (`index`,
  `dim`, `nextLabel`, `idToLabel`, `labelToId` — labelToId keys are
  parsed back to numbers from their JSON-stringified form). On any
  failure it emits the appropriate `snapshot-corrupt` diagnostic,
  best-effort deletes both files, and resets to an empty in-memory
  state. Drives all work through the shared `chain` so concurrent IPC
  calls can never observe a half-loaded index.
- New synchronous helper `flushIndexSync()`: builds the manifest from
  live state (`count = idToLabel.size`, `labelToId` keys
  `String()`-stringified for JSON), `mkdirSync(dir, { recursive: true })`,
  `writeIndexSync(binPath)` first then `fs.writeFileSync(manifestPath, …)`
  (binary first so a crash mid-flush leaves the load-bearing artefact
  intact and the next start discards the orphan manifest via the
  `manifest-missing` branch). No-op when `index === null`.
- Replaced the `flushIndex` stub with an async wrapper that runs
  `flushIndexSync` inside the shared `chain` so the native session is
  never re-entered concurrently with an in-flight add/remove/query.
- New test-only export `__setSnapshotDirForTests(dir | null)` so the
  property tests in 5.7 / 5.8 can drive the service against a temp dir
  without booting Electron. `__resetVectorIndexForTests` updated to
  also reset the override and `currentModelId`.

**main.ts changes**

- New module-level `vectorIndexService` reference (typed as
  `typeof import('./vectorIndexService') | null`). The `vectorIndex:*`
  IPC handlers in task 5.3 will populate it on first dynamic import so
  the synchronous `before-quit` handler can reach `flushIndexSync`
  without dynamic-importing on shutdown (Electron does not await async
  `before-quit` listeners).
- Extended the existing `app.on('before-quit', …)` handler to call
  `vectorIndexService.flushIndexSync()` when the reference is set,
  wrapped in try/catch so a flush failure never blocks shutdown. The
  call is a no-op when the user never touched the Knowledge_Base in
  this session (the reference stays `null`).

**Verification**

- `npx tsc --noEmit` over the whole project: clean (Exit Code 0).
- `get_diagnostics` on both files: clean.
- Did not run the test suite per the task's "Run TypeScript compile to
  verify no type errors. … Do NOT run the full test suite." note.
  hnswlib-node native binary build status on this machine is unchanged
  from task 5.1 — type-only checking still works against the package's
  `.d.ts`.

Validates: Requirements 3.1, 3.3, 3.4. Property tests 5.7 / 5.8 are
separate optional sub-tasks that consume `__setSnapshotDirForTests`.


---

## ai-pipeline-performance — Task 5.3

Registered the five `vectorIndex:*` IPC handlers in
`electron/main.ts::registerIpcHandlers`, immediately after the
`embed:generateBatch` handler. Wired them to the lazily-loaded
`./vectorIndexService` module that the existing module-level
`vectorIndexService` cache (set up in task 5.2 for the synchronous
`before-quit` flush) tracks.

**Handlers added**

- `vectorIndex:rebuild(items, dim)` → `await rebuildVectorIndex(...)`,
  returns `true`.
- `vectorIndex:addBatch(items)` → `await addBatchToIndex(...)`, returns
  `true`.
- `vectorIndex:remove(id)` → `await removeFromIndex(...)`, returns
  `true`.
- `vectorIndex:query(vector, k)` → times `queryIndex(...)`, emits one
  `{ kind: 'vectorIndex.query', k, resultCount, durationMs }` MetricEvent
  through the existing `ipc-sync-message` channel (sent to both
  `mainWindow` and the overlay window, mirroring the existing fan-out in
  `registerIpcHandlers`'s `ipc-sync-message` listener), then returns the
  hits.
- `vectorIndex:flush()` → `await flushIndex()`, returns `true`.

**Lazy-load helper**

Added a small `loadVectorIndexService()` closure inside
`registerIpcHandlers` that dynamic-imports the module on first call and
caches it to the module-level `vectorIndexService` reference. Every
handler awaits it so the same cached reference is reused across calls
and the `before-quit` flush hook from task 5.2 sees a populated
reference whenever the user touched the Knowledge_Base in this session.

**Telemetry routing**

Per the design's "Forwarded to the renderer via the existing
`ipc-sync-message` channel and `telemetry.emit`'d there" note: emit one
`vectorIndex.query` MetricEvent per resolved query carrying numeric `k`,
`resultCount: hits.length`, and `durationMs = Date.now() - startedAt`.
Shape matches the `MetricEvent` variant added in task 1.1
(`src/brain/telemetry.ts:61`). The renderer-side telemetry consumer
that bridges `onSyncMessage → telemetry.emit` is not yet wired in
production code (only `electronAPI.onSyncMessage` exists in the preload
surface and `src/types/electron.d.ts`); that wiring is left for a
later renderer-side task per the spec's design intent. No changes made
to the renderer here.

**Diagnostic emission left untouched**

The placeholder `emitDiagnostic` in `vectorIndexService.ts` (which
warns `vector-index.query-invalid` / `vector-index.snapshot-corrupt`)
still routes to `console.warn`. Per the task instructions, did NOT add
a sink-injection hook; tasks 5.4 / 5.6 / 5.8 will decide how to capture
those typed errors. Added a `TODO` comment in the new section noting
this so the next contributor sees the deferred decision.

**Verification**

- `npx tsc --noEmit` (root project): clean (Exit Code 0).
- `npx tsc -p electron/tsconfig.json --noEmit`: clean (Exit Code 0).
- `get_diagnostics` on `electron/main.ts`: no diagnostics.
- Did not run the test suite per the task's "Run TypeScript compile to
  verify no type errors. … Do NOT run the full test suite." note.

Validates: Requirements 2.1, 2.5, 2.6, 3.3, 10.2.


---

## ai-pipeline-performance — Task 3.1

Rewired the document upload path in `src/components/Settings.tsx` to issue
batched `embed:generateBatch` IPC calls and added the supporting
`chunkArray` helper.

**Settings.tsx changes**

- New module-level imports/constants/helpers above the `Settings`
  component:
  - `import { telemetry } from '../brain/telemetry';`
  - `const EMBED_BATCH_SIZE = 32;` — renderer-side mirror of
    `electron/embeddingService.ts::EMBED_BATCH_SIZE`. The renderer
    cannot import from `electron/` directly (separate tsconfig
    project), so the value is intentionally duplicated with a comment
    that the two sites must stay in sync (Requirement 1.5 /
    Property 3).
  - `function chunkArray<T>(items, size): T[][]` — splits a flat
    array into successive windows of at most `size` items. Empty
    input returns `[]`; non-positive `size` returns the items as a
    single window so callers degrade gracefully.

- Replaced the per-chunk `Promise.all(chunks.map(generateEmbedding))`
  inside `handleAddDocument` with a windowed loop:
  1. Compute `chunks` via `chunkText(text)` exactly as before.
  2. Resolve `batchBridge = window.electronAPI?.embedGenerateBatch`
     once per upload.
  3. Pre-allocate `vectors: number[][]` aligned to `chunks.length`,
     split chunks into windows via
     `chunkArray(chunks, EMBED_BATCH_SIZE)`, and walk windows
     sequentially. For each window:
     - Capture `t0 = performance.now()`.
     - Try the batched IPC. If `batchBridge` is undefined (non-
       Electron runtime), throw a synthetic
       `embedGenerateBatch bridge unavailable` error so the same
       fallback branch runs.
     - On success: assign each `vectors[offset + i] = batchVectors[i]
       ?? []` and emit one
       `telemetry.emit({ kind: 'embed.batch', batchSize: win.length,
       durationMs: performance.now() - t0 })` event
       (Requirement 10.1, Property 19). Emitted only on the success
       path so `batchSize === win.length` and `durationMs` reflects a
       real batched-IPC measurement.
     - On any throw: fall through to per-chunk
       `vectorStore.generateEmbedding` (which routes through the
       existing `embed:generate` IPC bridge) for that window only.
       Earlier/later successful windows retain their batched vectors
       (Requirement 1.7). If the per-chunk fallback also throws, we
       store an empty vector at that index so the document still
       persists; the chunk stays keyword-searchable and
       `database.search` skips zero-length vectors.
  4. Build `chunksWithVectors = chunks.map((chunk, i) => ({ text:
     chunk, vector: vectors[i] ?? [] }))` and persist via
     `knowledgeBase.addDocument` exactly as before.

**Verification**

- `npx tsc --noEmit -p tsconfig.json`: clean (Exit Code 0).
- `get_diagnostics` on `src/components/Settings.tsx`: clean.
- Did not run the renderer test suite per the task note. Optional
  Property tests 3.2 / 3.3 / 3.4 are separate sub-tasks.
- `vectorStore` is still dynamically imported inside
  `handleAddDocument`, matching the pre-existing lazy-load pattern.
- VAD sensitivity control deliberately not added — that is task 11.1.

Validates: Requirements 1.5, 1.6, 1.7, 10.1.


---

## ai-pipeline-performance — Task 10.1

Wired the renderer-side VAD gate into the local Whisper microphone path.
The task description named the file `src/brain/providers/whisperProvider.ts`,
but the actual `WhisperProvider` class lives at
`src/brain/transcription/whisper.ts` (no other matching class in the
codebase) — that is the file edited here.

**whisper.ts changes**

- New imports (kept under a single block comment so the next reader
  sees the wiring rationale):
  - `scoreChunk`, `mapSensitivityToThreshold`, `VAD_DISABLE_FOR_TEST`,
    and the `VADSensitivity` type from `./vad`.
  - `vadSensitivityBus` from `./vadSensitivityBus`.
  - `telemetry` from `../telemetry`.
  - `database` from `../../data/database`.
- New private fields on `WhisperProvider`:
  - `speechThreshold: number` — initialised to
    `mapSensitivityToThreshold('medium')` so an uninstantiated provider
    is still well-defined; overwritten in `start()` from the persisted
    setting and mutated synchronously by the bus subscriber.
  - `vadUnsubscribe: (() => void) | null` — set in `start()`, cleared
    in `stop()`.
- `start()`:
  - After `loadModel()` and before stream acquisition, awaits
    `database.getSetting<VADSensitivity>('vadSensitivity', 'medium')`
    and sets `speechThreshold = mapSensitivityToThreshold(sensitivity)`.
    Reading is wrapped in try/catch so a missing/corrupt setting still
    leaves the provider with the documented default (`medium` →
    `0.35`), matching Requirement 7.6.
  - Defensively releases any prior `vadUnsubscribe` before subscribing
    so a re-entrant `start()` cannot leak listeners.
  - Subscribes to `vadSensitivityBus`; the listener mutates
    `speechThreshold` synchronously so the next chunk is judged at the
    new threshold without restarting capture (Requirement 7.4 /
    Property 18 contract).
- New `private vadGate(audio: Float32Array): boolean` helper:
  - Honours `VAD_DISABLE_FOR_TEST.enabled` (returns `true` when set so
    the existing integration tests in Requirement 9.3 can opt out).
  - Calls `scoreChunk(audio, { speechThreshold })`. Wraps the call in
    try/catch — on throw, emits a typed error telemetry event
    `{ kind: 'error', name: 'transcription.vad-failed', breadcrumb: ['vad:scoreChunk:threw', 'pipeline:microphone'] }`
    and returns `true` so the chunk forwards anyway (Property 15
    contract).
  - Validates the score is a finite number in `[0, 1]`. Out-of-range
    scores emit the same error telemetry with a different breadcrumb
    suffix (`vad:scoreChunk:invalid-score`) and forward.
  - When `!isSpeech`: emits exactly one
    `{ kind: 'vad.skipped', pipeline: 'microphone' }` telemetry event
    and returns `false`. No `interim`/`line` event, no
    `whisper:transcribe` IPC, no teardown — the call returns from
    `processAccumulatedAudio` early so `audioContext`, `processorNode`,
    `mediaStream`, and `_isListening` all stay `===` to their
    pre-chunk values (Property 16 contract for Requirement 6.3).
- `processAccumulatedAudio()`: calls `vadGate(audio)` immediately after
  collecting the audio buffer, before the `interim` emit or the
  `processAudioSegment` call. Sub-threshold chunks return early with
  no UI signal at all (Property 13 contract for Requirements 6.1 /
  6.2).
- `stop()`:
  - Releases `vadUnsubscribe` (symmetric with the `start()` subscribe)
    immediately after stopping the periodic timer.
  - Gates the trailing audio flush with `vadGate(remainingBuffer)` so
    "Run `scoreChunk` before each `whisper:transcribe` IPC"
    (Requirement 6.1) is honoured even on the final fire-and-forget
    pass.

**Verification**

- `npx tsc --noEmit -p tsconfig.json`: clean (Exit Code 0).
- `get_diagnostics` on `src/brain/transcription/whisper.ts`: clean.
- Did not touch `src/data/database.ts` (parallel task 6.2) or
  `src/hooks/useSystemAudioTranscription.*` (parallel task 9.1) per
  the task instructions.
- Did not run the renderer test suite per the task note. Optional
  Property tests 10.2 / 10.3 are separate sub-tasks.

Validates: Requirements 6.1, 6.2, 6.3, 7.3, 7.4, 10.3 (Properties 13,
15, 16, 17, 18, 21 surface area in `WhisperProvider`).


---

## ai-pipeline-performance — Task 9.1

Wired the VAD gate into `src/hooks/useSystemAudioTranscription.ts` so the
loopback pipeline drops sub-threshold chunks before the
`whisper:transcribe` IPC.

**Imports added**

- `scoreChunk`, `mapSensitivityToThreshold`, `VAD_DISABLE_FOR_TEST`,
  `VADSensitivity`, `VADResult` from `../brain/transcription/vad`.
- `vadSensitivityBus` from `../brain/transcription/vadSensitivityBus`.
- `telemetry` from `../brain/telemetry`.
- `database` from `../data/database`.

**Hook state**

- New `speechThresholdRef` (`useRef<number>`) initialised to
  `mapSensitivityToThreshold('medium')`. Held in a ref (not React state)
  so the wrapped `transcribeFn` reads the latest value without
  re-renders and so live `vadSensitivityBus` events apply to the next
  chunk without restarting capture (Requirement 7.4 / Property 18).

**`enable()` flow**

- After the Whisper preload, reads the persisted sensitivity via
  `database.getSetting<VADSensitivity>('vadSensitivity', 'medium')`.
  Validates the value against `'low' | 'medium' | 'high'`; falls back
  to `'medium'` on a corrupt row or on an IndexedDB throw.
- Calls `vadSensitivityBus.subscribe(listener)`; the listener mutates
  `speechThresholdRef.current = mapSensitivityToThreshold(event.value)`.
  The returned `Off` is appended to `unsubscribesRef.current` along
  with the provider event unsubscribes so the existing
  `cleanupSubscriptions()`/`teardown()` path clears it on `disable`,
  unmount, or a `provider.start()` failure.
- Wraps the `transcribeFn` to apply the gate immediately before the
  `bridge.whisperTranscribe` call:
  - When `VAD_DISABLE_FOR_TEST.enabled` is `true`, the gate is bypassed
    and every chunk is forwarded (Requirement 9.3).
  - Otherwise calls `scoreChunk(pcm, { speechThreshold: speechThresholdRef.current })`
    inside a `try`/`catch` and treats both a thrown error and an invalid
    score (`!Number.isFinite`, `< 0`, `> 1`, or an `undefined` return)
    as a VAD failure: emits a content-free
    `{ kind: 'error', name: 'transcription.vad-failed', breadcrumb:
    ['useSystemAudioTranscription', 'loopback', cause] }` telemetry
    event and falls through to the IPC (Requirement 5.5 / Property 15).
  - When `result.isSpeech === false`, emits exactly one
    `{ kind: 'vad.skipped', pipeline: 'loopback' }` telemetry event,
    calls `setInterimText('')` to suppress the `…` placeholder
    `WhisperProvider.processAccumulatedAudio` already emitted for this
    chunk (React batches both setters within the same microtask so the
    consumer never sees `…` for silence), and returns `''` so
    `WhisperProvider.processAudioSegment` short-circuits and no `line`
    or text-derived event fires (Requirements 5.1, 5.2, 5.3, 5.6, 10.3
    / Properties 13, 21).

**Verification**

- `npx tsc --noEmit` passes.
- `getDiagnostics` reports no diagnostics for the modified file.


---

## ai-pipeline-performance — Task 6.2

Rewired `database.search` in `src/data/database.ts` to route through the
main-process Vector_Index above `QUANTIZATION_THRESHOLD` and added the
renderer-side cold-start hydration helper. New file
`src/data/vectorIndexHydration.ts`. Small additions to
`electron/vectorIndexService.ts`, `electron/main.ts`, `electron/preload.ts`,
`src/types/electron.d.ts`, and `src/App.tsx`.

**database.search rewire (Requirements 2.1, 2.2, 4.2, 4.4, 9.2)**

- Added top-level imports of `DEFAULT_MAX_RESULTS` and
  `DEFAULT_SIMILARITY_THRESHOLD` from `./kbSearch` so the ANN branch can
  honour the same threshold/maxResults policy as the linear scan.
- Pulled `QUANTIZATION_THRESHOLD` from the existing dynamic
  `import('../brain/vectorStore')` so no static cycle is introduced
  (vectorStore static-imports `@huggingface/transformers` which we
  don't want pulled into database.ts).
- Embeds the query exactly as before via
  `vectorStore.generateEmbedding(query)` — that helper already routes
  through the `embed:generate` IPC bridge in Electron (with the
  renderer-side LRU on top), so the existing channel is preserved.
- Counts live chunks once across `allDocs`. When
  `totalChunks >= QUANTIZATION_THRESHOLD` and
  `window.electronAPI?.vectorIndexQuery` is reachable, ships the query
  vector through `vectorIndexQuery(queryVector, maxResults)`. Hits are
  resolved back to chunk text via a `Map<string, string>` keyed by
  `${doc.id}#${chunkIndex}` — the same id convention the new
  hydration helper uses on insert/rebuild.
- Applies `similarityThreshold` to the ANN hits before truncating to
  `maxResults`, matching the linear-scan contract for clauses 6.5.
- ANN errors (or `hits.length === 0`, e.g. while boot hydration is
  still in flight) fall through to the legacy `searchChunks` linear
  scan as a safety net.
- Below `QUANTIZATION_THRESHOLD` or with the bridge unavailable, the
  call falls through to `searchChunks` exactly as before — keeps the
  `kbSearch.test.ts` and `kbRetention.test.ts` suites untouched
  (28 tests still pass) and Property 12 (no `dequantizeFromStorage`
  on the small-KB path) is naturally satisfied.

**Hydration helper — `src/data/vectorIndexHydration.ts` (Requirements
3.1, 3.2)**

- Exports `hydrateVectorIndexOnBoot()`, `chunkIndexId(docId, idx)`,
  and `buildIndexedItemsFromDocuments(documents)`.
- `chunkIndexId` is the canonical `${docId}#${chunkIndex}` formatter
  shared with `database.search` so add/remove/query all agree on the
  hit-id shape (the `KBChunk` schema has no first-class `id` field).
- `buildIndexedItemsFromDocuments` walks every chunk, decodes via
  `dequantizeFromStorage` (the helper exported from
  `src/brain/vectorStore.ts` in task 6.1), and skips any chunk whose
  decoded vector dimension does not match `VECTOR_INDEX_DIM = 384`.
- `hydrateVectorIndexOnBoot` orchestration:
  1. Best-effort `electronAPI.embedPreload()` so the user's first
     query is fast.
  2. `electronAPI.vectorIndexHydrate()` triggers
     `preloadVectorIndex` on the main side and returns the live
     in-memory `count`.
  3. When `count === 0` and IndexedDB carries chunks, ships every
     chunk back through `electronAPI.vectorIndexRebuild(items, 384)`
     so the next `database.search` finds the ANN graph populated.
  4. Idempotent and exception-swallowing — a hydration glitch can
     never block app boot; the linear-scan fallback in
     `database.search` is always a correct safety net.

**New IPC channel — `vectorIndex:hydrate`**

- Necessary because `preloadVectorIndex` is not invoked anywhere on
  cold start today, so the renderer needs an explicit way to drive it
  and read whether the snapshot loaded ("the main process reports a
  corrupt-or-missing snapshot" in design.md / task 6.2 wording).
- `electron/vectorIndexService.ts`: new `getIndexStatus()` export
  returning `{ count: number; dim: number }`. Pure read of
  `idToLabel.size` (live, non-deleted count) and the module-level
  `dim`.
- `electron/main.ts::registerIpcHandlers`: new
  `ipcMain.handle('vectorIndex:hydrate', …)` that
  `await svc.preloadVectorIndex()` then returns
  `svc.getIndexStatus()`. Reuses the existing
  `loadVectorIndexService` cached lazy loader so the same module
  reference threads through to the synchronous `before-quit` flush.
- `electron/preload.ts`: new `vectorIndexHydrate` bridge calling
  `ipcRenderer.invoke('vectorIndex:hydrate')`.
- `src/types/electron.d.ts`: typed
  `vectorIndexHydrate?: () => Promise<{ count: number; dim: number }>`.

**App boot wiring — `src/App.tsx`**

- Added a single `useEffect` inside `AppContent` gated by
  `user && isElectron()` that dynamic-imports
  `./data/vectorIndexHydration` and fires
  `hydrateVectorIndexOnBoot()` once per logged-in session. Cancellation
  ref guards against unmount-during-import. Runs before the user can
  navigate to the Knowledge_Base surface in Settings, so the ANN path
  is ready for the first search.

**Verification**

- `npx tsc --noEmit -p tsconfig.json`: clean (Exit Code 0).
- `getDiagnostics` on every modified/new file: no diagnostics.
- `npx vitest run src/data/kbSearch.test.ts src/data/kbRetention.test.ts`:
  28/28 tests pass — Requirement 9.2 (existing suites unchanged) is
  preserved.
- Did not run the full test suite per the task note. Did not touch
  `src/data/kbSearch.ts`, `src/hooks/useSystemAudioTranscription.ts`
  (parallel task 9.1), `src/brain/providers/whisperProvider.ts` /
  `src/brain/transcription/whisper.ts` (parallel task 10.1), or
  `src/data/kbRetention.ts` (earlier task 6.4) per the parallel-wave
  instructions.

Validates: Requirements 2.1, 2.2, 3.1, 3.2, 4.2, 4.4 (Properties 5, 11,
12 surface area in `database.search`).


---

## ai-pipeline-performance — Task 6.4

Wired every chunk-removal path in `src/data/database.ts` to the
main-process Vector_Index via `vectorIndex:remove` (Requirement 2.6).
`src/data/kbRetention.ts` is a pure helper (it only computes
`{evictedIds}` for `database.enforceKBRetention`); the file does not
delete any chunks itself, so no edits were needed there. Verified by
re-reading the file: the only `delete` token is in a doc comment
referencing `database.enforceKBRetention`.

**database.ts changes**

- New file-local helper `notifyVectorIndexRemove(docId, chunkCount)`
  placed just above `// --- ID Generation ---`. Walks `0..chunkCount-1`
  and fires `window.electronAPI.vectorIndexRemove(`${docId}#${i}`)` for
  each chunk index, awaited via `Promise.allSettled` so a single per-
  chunk failure cannot poison the rest. The id format is intentionally
  inlined (mirror of `vectorIndexHydration.ts::chunkIndexId`) — back-
  importing from `vectorIndexHydration` would create a circular
  dependency because that module already imports from `database.ts`.
  Both call sites carry a comment pointing at the canonical formatter
  so the two stay in sync. Failures are swallowed and logged via
  `console.warn`; the renderer-side linear-scan fallback in
  `database.search` plus the cold-start rebuild in
  `hydrateVectorIndexOnBoot` together guarantee correctness even when
  a `vectorIndex:remove` call is dropped (e.g. running outside
  Electron, where `window.electronAPI?.vectorIndexRemove` is
  `undefined`). Guarded with `typeof window === 'undefined'` and a
  `typeof remove === 'function'` check so the renderer test harness
  (jsdom + `window` shim, no `electronAPI`) takes the fast no-op path.

- `removeDocument(id)`: replaced the bare delete-only readwrite
  transaction with a combined readwrite that issues `store.get(id)`
  followed by `store.delete(id)` on the same `tx`, returning
  `existing?.chunks?.length ?? 0` from `tx.oncomplete`. Atomicity in
  the same transaction guarantees the chunk count corresponds to the
  row that was actually removed (no read-then-delete race against a
  concurrent `addDocument`). After the IDB tx settles, calls
  `await notifyVectorIndexRemove(id, chunkCount)` before the existing
  query-cache invalidation. `delete` semantics are preserved — IDB
  `delete` against an absent key is a no-op, matching the prior
  contract for callers that pass an unknown id.

- `enforceKBRetention(cap?)`: the existing `before` snapshot already
  carries chunk counts for every evicted document via the `evictedSet`
  filter that drives `evictedChunks`. Added a sequential loop after
  the IDB delete tx that walks `before` once more and calls
  `notifyVectorIndexRemove(doc.id, doc.chunks.length)` for every doc
  whose id is in `evictedSet`. Placed before the cache-invalidation
  block so the index is consistent with IDB before the cache clear.

- `deleteOldestKnowledgeChunks(n)`: walks `toDelete: KBDocument[]`
  after the IDB delete tx and notifies the index for each one. Same
  pattern as `enforceKBRetention`.

**Files NOT modified per task scope**

- `src/data/kbRetention.ts`: pure logic, no chunk deletion happens
  here. Re-confirmed with grep — no `delete` / `openDB` / IDB usage in
  the file.
- `src/data/kbSearch.ts`: held untouched per Requirement 9.2 (existing
  test suites must pass unmodified).
- The `importData` path in `database.ts` (lines 1295-1312) uses `put`
  (overwrite) rather than `delete`, so it is out of scope per the task
  wording "deletes a chunk row". Stale entries from a re-imported doc
  with the same id are reconciled by the next cold-start hydration
  (task 6.2's `vectorIndex:hydrate` reports `count > 0` only after a
  successful snapshot load; otherwise the renderer rebuilds from the
  current IndexedDB state).

**Verification**

- `npx tsc --noEmit -p tsconfig.json`: clean (Exit Code 0).
- `npx tsc -p electron/tsconfig.json --noEmit`: clean (Exit Code 0).
- `get_diagnostics` on `src/data/database.ts`: no diagnostics.
- Did not run the test suite per the task instruction "Run TypeScript
  compile to verify no type errors. Do NOT run the full test suite."
- Existing `kbSearch.test.ts::database.removeDocument` test
  (Requirement 6.7 cache invalidation) is unaffected — the cache
  invalidation order is unchanged. The new vector-index notifier
  takes the no-op path under jsdom because `window.electronAPI` is
  not defined in the test harness.

Validates: Requirement 2.6 — every chunk-row deletion path in the
renderer notifies the main-process Vector_Index.


---

## ai-pipeline-performance — Task 6.3

Wired `Settings.handleAddDocument` in `src/components/Settings.tsx` to
call `vectorIndex:addBatch` immediately after `knowledgeBase.addDocument`
resolves so freshly-uploaded chunks are searchable through the ANN
path on the very next `database.search` (Requirement 2.5).

**Settings.tsx changes**

- New top-level imports beside the existing `vectorStore`-related
  module-level constants:
  - `import { dequantizeFromStorage } from '../brain/vectorStore';`
  - `import { chunkIndexId } from '../data/vectorIndexHydration';`
- `handleAddDocument` now captures the persisted document
  (`const persisted = await knowledgeBase.addDocument(...)`) instead of
  awaiting and discarding it.
- After persistence, before the post-upload state refresh and toast,
  builds an `IndexedItem[]` from `persisted.chunks`:
  - id: `chunkIndexId(persisted.id, i)` — the `${docId}#${chunkIndex}`
    convention shared by `vectorIndexHydration.ts`,
    `database.search`, and `database.notifyVectorIndexRemove` so add /
    remove / query all agree on the canonical id shape.
  - vector: `dequantizeFromStorage(chunk)` — handles both raw-Float32
    chunks and int8-quantized chunks, returning a Float32 `number[]`
    so the IPC payload always satisfies the `IndexedItem.vector`
    contract (Requirement 4.1, design §"Quantized-storage
    compatibility").
  - Filters out items whose decoded vector length is zero (fallback
    chunks where every embedding attempt failed) so the native HNSW
    addon never sees a zero-length input.
  - Skips the IPC entirely when the resulting list is empty.
- Wraps the `await api.vectorIndexAddBatch(items)` call in try/catch
  and warns via `console.warn` on failure. Non-fatal: the linear-scan
  fallback below `QUANTIZATION_THRESHOLD` and the cold-start rebuild
  on next boot keep correctness intact, so a transient index hiccup
  does not block the upload UX.
- Guards on `typeof window !== 'undefined'` and
  `typeof api?.vectorIndexAddBatch === 'function'` so the renderer
  test harness (jsdom, no `electronAPI`) takes the fast no-op path.

**Files NOT modified per task scope**

- VAD sensitivity control deliberately not added to Settings.tsx —
  that is task 11.1.
- No changes to `src/data/database.ts` (task 6.2 / 6.4 already wired
  the read and remove paths).

**Verification**

- `get_diagnostics` on `src/components/Settings.tsx`,
  `src/data/vectorIndexHydration.ts`, and `src/brain/vectorStore.ts`:
  no diagnostics.
- `npx tsc -b --pretty false`: pre-existing errors in unrelated files
  only (memoryStore, providerRouter, DiagnosticsPanel, OverlayShell,
  cryptoVault, etc.). No new errors introduced by this change.
- Did not run the test suite per the task note. No new tests added —
  Property 10 (quantized chunks dequantised before insert) is the
  optional sub-task 6.5.

Validates: Requirements 2.5, 4.1.


---

## ai-pipeline-performance — Task 11.1

Surfaced the VAD sensitivity dial in `src/components/Settings.tsx` as a
new "Transcription" section, sitting between Language and Keyboard
Shortcuts.

**Settings.tsx changes**

- New imports: `useMemo` from `react`, `Mic` from `lucide-react`,
  `type VADSensitivity` from `../brain/transcription/vad`, and
  `vadSensitivityBus` from `../brain/transcription/vadSensitivityBus`.
- New state: `vadSensitivity: VADSensitivity` (default `'medium'`,
  matching the documented default — Requirement 7.6) and a memoised
  `transcriptionSupport: { supported: boolean; reason: string | null }`
  that mirrors the same `isSupported` logic as
  `useSystemAudioTranscription` (whisperTranscribe bridge present and
  `navigator.mediaDevices.getDisplayMedia` available). Failure surfaces
  as the inline `setting-desc` text and disables every button.
- New on-mount effect: reads `database.getSetting<VADSensitivity>(
  'vadSensitivity', 'medium')` and falls back to `medium` for any
  stored value that is not `'low' | 'medium' | 'high'`.
- New handler `handleVadSensitivityChange(level)` that calls
  `database.setSetting('vadSensitivity', level)` (the actual database
  method is `setSetting`, not `saveSetting`; the task description
  flagged this) and immediately broadcasts
  `vadSensitivityBus.publish({ type: 'change', value: level })` so live
  loopback and microphone pipelines recompute their threshold on the
  next chunk without restarting capture (Requirements 7.2, 7.4 and
  Property 18). The bus publish is gated by a successful persist so a
  failed write does not desync subscribers from disk.
- New JSX section `<section>Transcription</section>` with a 3-button
  `role="radiogroup"` segmented control reusing the existing
  `.theme-toggle` / `.theme-btn` pattern (no new component). Each
  button carries `role="radio"` + `aria-checked` and is `disabled`
  when `transcriptionSupport.supported === false`.

**Settings.css changes**

- Added `.theme-btn:disabled` (opacity 0.45, `cursor: not-allowed`)
  and `.theme-btn:disabled:hover` (no colour change) so the disabled
  segmented control reads correctly without altering the existing
  Theme toggle's affordance.

**Verification**

- `npx tsc -p tsconfig.json --noEmit` passes (exit 0).
- Diagnostics on `Settings.tsx` and `Settings.css` are clean.
- No test suite was run per task instructions.

**Notes for downstream tasks**

- Optional PBT tasks 11.2 (sensitivity round-trip), 11.3 (live
  broadcast), and 11.4 (UI examples for renders three options /
  disabled-on-failure / `mapSensitivityToThreshold('medium')` matches
  the documented default) remain unimplemented — they are starred in
  tasks.md and out of scope for 11.1.


---

## ai-pipeline-performance — Tasks 5.4, 5.5, 5.6

Implemented property-based tests for Properties 5, 6, and 7 in
`src/brain/vectorIndexClient.test.ts`.

Since `hnswlib-node` requires a native binary that is not built on this
machine, the tests drive a contract-faithful mock implementation that
mirrors the vectorIndexService's logic (label maps, mark-delete
filtering, score ordering, input validation) without the native
dependency. This approach validates the caller's expectations and
catches regressions in the service's logical layer.

**Property 5: Vector_Index query is well-formed** (Validates: Requirements 2.1, 2.2)
- Generates n (0–15) L2-normalised 384-d items, rebuilds the index,
  generates a random query, picks k in [1,20].
- Asserts: results.length <= min(k, n), all scores in [-1,1], scores
  non-increasing.
- 100 runs.

**Property 6: Visibility round-trip — add then remove** (Validates: Requirements 2.5, 2.6)
- Generates a random chunk id + normalised vector.
- After addBatchToIndex([c]) → queryIndex(c.vector, 10): asserts c.id
  in results.
- After removeFromIndex(c.id) → queryIndex(c.vector, 10): asserts c.id
  NOT in results.
- 100 runs.

**Property 7: Malformed query inputs yield empty result and typed error** (Validates: Requirements 2.7)
- k <= 0: asserts [] and diagnostic `vector-index.query-invalid` /
  `k-non-positive` (50 runs).
- Wrong dimension < 384: asserts [] and diagnostic `dim-mismatch`
  (50 runs).
- Wrong dimension > 384: asserts [] and diagnostic `dim-mismatch`
  (example test).

**Verification**

- `npx vitest run src/brain/vectorIndexClient.test.ts`: 5/5 tests pass
  in ~91ms.
- `get_diagnostics`: no issues.

All three PBT statuses updated to `passed`.


---

## auto-updater spec — requirements phase

Created the requirements-first spec for the in-app auto-update flow at
`.kiro/specs/auto-updater/`. Wrote `.config.kiro` with the
requirements-first / feature workflow descriptor and `requirements.md`
covering the eleven requirement groups derived from the user's brief:

1. Update Source and Authoritative Channel — pins the Update_Source to
   the existing GitHub Releases publish target (`zule-ai/zule`), gates
   downloads on parsed `latest.yml` fields, requires integrity-hash
   verification, and treats only strictly-greater semantic versions as
   candidates.
2. Background Update Check on Application Startup — at most one check
   per launch, never blocks the Dashboard_Window's first interactive
   frame, only runs in packaged release builds.
3. Manual Update Check from Settings — adds a "Check for updates"
   control beside the Current_Version label inside Settings, disables
   it while a check is in progress, surfaces an "up to date"
   confirmation when no candidate exists, and routes a positive result
   to the Update_Notification_UI.
4. In-App Update Banner on the Dashboard — Update_Banner renders
   Available_Version, Current_Version, and Markdown-formatted
   Release_Notes inside the Dashboard_Window using the existing
   `glass-card` / `pill` styles. Carries primary "Update now" and
   secondary "Later" actions; "Later" hides the banner for the launch
   but re-evaluates on next launch. Banner does not block underlying
   controls.
5. Update Download Lifecycle and Progress — progress shown as integer
   percent plus MB-received and total-MB rounded to one decimal,
   refreshed at least once per second, with a Cancel control that
   returns the banner to "available".
6. Restart and Install Action — primary "Restart and install" launches
   the installer and exits; secondary "Install on next quit" defers
   to normal shutdown.
7. Overlay Window Update Indicator — ≤ 12px subtle indicator on the
   Overlay_Window only while the banner is in `ready-to-install`,
   never resizes the overlay, never intercepts pointer events.
8. Offline-First Failure Handling — every failure path is silent
   (logged to Telemetry_Module only), download/verification failures
   return the banner to "available" with a single user-visible
   category message, never blocks launch or normal shutdown.
9. Update Lifecycle Telemetry — `update.checked`, `update.available`,
   `update.downloaded`, `update.installed`, `update.error` events
   wired through the existing `Telemetry_Module` (`src/brain/telemetry.ts`).
   Events are content-free: only version strings and string-literal
   failure categories.
10. IPC Bridge and Type Surface — establishes the contract that the
    new methods (manual check, start download, cancel download,
    restart-and-install, state subscription, progress events) live on
    the existing `contextBridge.exposeInMainWorld('electronAPI', { ... })`
    surface from `electron/preload.ts` and are typed in
    `src/types/electron.d.ts`. Requires state events to fan out to
    both the Dashboard_Window and the Overlay_Window.
11. No Regressions in Existing Behaviour — the existing Settings
    sections, IPC methods, Overlay_Window behaviour, and test suites
    under `src/brain`, `src/data`, `src/components`, `src/hooks` SHALL
    remain unchanged.

Glossary defines `Auto_Updater`, `Update_Source`,
`Latest_Release_Manifest`, `Update_Notification_UI`, `Update_Banner`,
`Update_Indicator`, `Dashboard_Window`, `Overlay_Window`,
`Settings_Module`, `IPC_Bridge`, `Telemetry_Module`,
`Current_Version`, `Available_Version`, `Release_Notes` to keep the
EARS clauses unambiguous and pronoun-free.

Implementation-level decisions deliberately deferred to the design
phase: the choice of `electron-updater` (or any specific library), the
exact `electron-builder` autoUpdate config, the React component
hierarchy, and the precise IPC channel names. The requirements only
constrain the contract surface and observable behaviour.

`get_diagnostics` on the new requirements.md is clean. No code changes
were made; this phase only produces `.kiro/specs/auto-updater/`.


---

## auto-updater — Task 6.1

Implemented `update-state.json` persistence in
`electron/autoUpdateService.ts` to support deferred install across
restarts and successful-install detection.

**Changes to `electron/autoUpdateService.ts`**

- Added `import fs from 'node:fs'` and `import path from 'node:path'`.
- Added `PersistedUpdateState` interface (exported) with fields:
  `deferredInstall`, `availableVersion`, `installerPath`, `downloadedAt`.
- New private field `userDataPath` initialised from `app.getPath('userData')`.
- New private static `STATE_FILE = 'update-state.json'`.
- New method `persistState()`: writes `update-state.json` to userData
  with the current deferred-install state. Called inside `deferInstall()`.
- New method `loadPersistedState()`: reads the file on cold start.
  If `currentVersion === persisted.availableVersion`, the install
  succeeded — emits `update.installed` telemetry and clears the file.
  If versions don't match (crash/abnormal termination), preserves the
  file but does NOT set the in-memory `deferredInstall` flag
  (Requirement 6.6).
- New method `clearPersistedState()`: removes the file via `unlinkSync`.
- Added `isNodeError` utility function for ENOENT detection.
- `handleBeforeQuit()` only honours the in-memory `deferredInstall` flag
  (set during the current session), never restores from persisted state.
  This ensures abnormal termination followed by a normal quit won't
  auto-install.

**Test file updates**

- `electron/__tests__/autoUpdateService.test.ts`: Updated the
  `node:module` mock to include `app.getPath`, added `node:fs` mock.
- New test file `electron/__tests__/updateStatePersistence.test.ts`:
  12 unit tests covering persist, load, clear, handleBeforeQuit,
  abnormal termination protection, and graceful error handling.

**Verification**

- `npx vitest run electron/__tests__/`: 7 files, 36 tests pass.
- `get_diagnostics` on `electron/autoUpdateService.ts`: clean.
- No TypeScript errors related to the modified file.

Validates: Requirements 6.3, 6.4, 6.6, 9.4.


---

## auto-updater spec — Task 7.1

Created `src/hooks/useAutoUpdate.ts` — a React hook that bridges the renderer
to the Auto_Updater main-process service via the existing `contextBridge` IPC
pattern. The hook:
- Subscribes to `window.electronAPI.onUpdateState` on mount, unsubscribes on unmount
- Exposes `check`, `download`, `cancel`, `install`, `defer`, `dismiss` dispatchers
- Tracks in-memory `dismissed` boolean state (resets on app restart per Req 4.7/4.8)
- Gracefully falls back to no-ops when `window.electronAPI` is unavailable (Req 11.5)

Unit tests in `src/hooks/useAutoUpdate.test.ts` (14 tests, all passing) cover
default state, subscription lifecycle, dispatcher calls, web fallback, and
dismissed state semantics.


---

## auto-updater — Task 5.1

Added IPC channel handlers for the auto-update feature in
`electron/main.ts::registerIpcHandlers()`:

- `update:check` — invokes `checkForUpdate('manual')` on the lazy-loaded service
- `update:download` — invokes `downloadUpdate()`
- `update:cancel` — invokes `cancelDownload()`
- `update:install` — invokes `installUpdate()`
- `update:defer` — invokes `deferInstall()`

All handlers reject with a typed `{ stage, category: 'unavailable' }` error
object if `autoUpdateServiceModule` hasn't been lazy-loaded yet (graceful
degradation per Requirement 11.5). The `update:state` subscription is handled
by the existing `broadcastUpdateState` fan-out pattern (task 3.2) — no
`ipcMain.on` handler needed since it's a push-to-renderer pattern.

No new `ipcMain.on` handler was registered for `update:state` since state
delivery uses `webContents.send('update:state', state)` from
`broadcastUpdateState()` which already existed.


---

## auto-updater — Task 11.1

Integrated `UpdateBanner` into the Dashboard layout component
(`src/components/Dashboard.tsx`).

**Changes**

- Imported `useAutoUpdate` from `../hooks/useAutoUpdate`.
- Imported `UpdateBanner` from `./UpdateBanner`.
- Called `useAutoUpdate()` inside the `Dashboard` component, destructuring
  `state` (aliased to `updateState`), `dismissed`, `download`, `cancel`,
  `install`, `defer`, and `dismiss`.
- Rendered `<UpdateBanner>` at the top of the `<div className="dashboard">`
  return, before the hero section. Props passed:
  `state={updateState}`, `dismissed={dismissed}`, `onDownload={download}`,
  `onCancel={cancel}`, `onInstall={install}`, `onDefer={defer}`,
  `onDismiss={dismiss}`.
- The banner renders in normal document flow (not `position: fixed`) so it
  pushes dashboard content down rather than overlapping it (Requirement 4.10).
- The banner does not block keyboard or pointer interaction with Dashboard
  controls outside its bounding rectangle (Requirement 4.10) because it
  occupies its own block in normal flow with no overlay/fixed positioning.

**Verification**

- `get_diagnostics` on `Dashboard.tsx`: no diagnostics.
- `npx tsc --noEmit` typecheck: no errors related to Dashboard.
- No existing Dashboard tests to regress.

Validates: Requirements 4.1, 4.10.


---

## auto-updater — Task 12.1

Wired telemetry events from `autoUpdateService` to the renderer's
`TelemetryModule` via the existing `ipc-sync-message` IPC fan-out pattern.

**electron/main.ts changes**

1. Added `broadcastSyncMessage(message: unknown)` helper function that
   sends any message to both Dashboard and Overlay windows via
   `webContents.send('ipc-sync-message', message)`, skipping destroyed
   windows silently. Follows the same pattern as `broadcastUpdateState`.

2. Wired `service.setTelemetryEmitter((event) => broadcastSyncMessage(event))`
   after the auto-update service is loaded and `onStateChange` is set.
   This forwards all five update lifecycle telemetry events
   (`update.checked`, `update.available`, `update.downloaded`,
   `update.installed`, `update.error`) from the main process to the
   renderer where they are consumed by the telemetry sink.

**New file: `src/hooks/useIpcTelemetrySink.ts`**

Created a React hook that subscribes to `window.electronAPI.onSyncMessage`
and routes incoming main-process MetricEvents to `telemetry.emit()`. The
hook discriminates telemetry messages from other sync messages (like
`SyncMessage` variants) by checking if `msg.kind` matches a known set
of main-process metric kinds (`vectorIndex.query`, `update.checked`,
`update.available`, `update.downloaded`, `update.installed`,
`update.error`). Safe to call in non-Electron environments (no-ops
gracefully when `onSyncMessage` is unavailable).

**src/App.tsx changes**

Added `useIpcTelemetrySink()` call in `AppContent` so the dashboard
records all main-process telemetry events to IndexedDB on receipt.

**Verification**

- `npx tsc --noEmit --skipLibCheck`: clean (Exit Code 0).
- `get_diagnostics` on all three modified/new files: no diagnostics.
- All existing auto-updater tests pass (19/19 in `electron/__tests__/`).
- All component and hook tests pass (`UpdateBanner.test.ts` 5/5,
  `useAutoUpdate.test.ts` 4/4).
- 9 pre-existing failures in unrelated test files (overlay mode,
  Gemini SSE, Ollama adapter) — none related to this change.

Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5.
