// ============================================================================
// Zule AI — Main-Process Vector_Index Service (hnswlib-node)
// ============================================================================
//
// Approximate-nearest-neighbour search over Knowledge_Base chunk embeddings
// using `hnswlib-node`. Wraps the native HNSW graph and owns the bidirectional
// string-id ↔ uint32-label mapping that the renderer relies on.
//
// Why this lives in the main process:
//   `hnswlib-node` is a native CJS addon (.node binary) and the renderer runs
//   with `contextIsolation: true` + `nodeIntegration: false` — it cannot
//   `require` native modules. The index is also colocated with the embedding
//   service that produces the vectors, so upload-time inserts don't pay an
//   extra IPC trip back to the renderer.
//
// Why dynamic import for the package:
//   Same pattern as electron/whisperService.ts and electron/embeddingService.ts:
//   the package is externalised at bundle time (see vite.electron.config.ts)
//   so the .node binary is loaded from node_modules at runtime, not from the
//   bundled chunk. A dynamic import keeps the addon out of the cold-start path
//   for users who never query the Knowledge_Base.
//
// Persistence (snapshot to <userData>/vector-index.bin + vector-index.json),
// preloadVectorIndex, and the `vector-index.snapshot-corrupt` recovery path
// are implemented in task 5.2 (this file). The IPC handlers and telemetry
// wiring land in task 5.3. The in-memory core (HNSW + add/remove/rebuild/
// query + debounced flush scheduler) was implemented in task 5.1.

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  HierarchicalNSW as HierarchicalNSWClass,
  SearchResult,
} from 'hnswlib-node';
import type {
  IndexedItem,
  QueryHit,
  VectorIndexManifest,
} from '../src/types/vectorIndex';

const require = createRequire(import.meta.url);

// ── Configuration (per design.md §"Vector_Index Service") ───────────────────

/** MiniLM-L6 output dimension. */
export const VECTOR_INDEX_DIM = 384;

/** Initial `maxElements` for the HNSW graph; resized at 90 % occupancy. */
export const VECTOR_INDEX_MAX_ELEMENTS = 100_000;

/** Resize trigger as a fraction of `maxElements`. */
const VECTOR_INDEX_RESIZE_AT = 0.9;

/** Resize multiplier applied when the live count crosses the threshold. */
const VECTOR_INDEX_RESIZE_FACTOR = 2;

/** HNSW build-time graph fan-out. */
const VECTOR_INDEX_M = 16;

/** Build-time accuracy/speed knob. */
const VECTOR_INDEX_EF_CONSTRUCTION = 200;

/** Query-time accuracy/speed knob; tuned for ≥ 0.95 recall at k=10. */
const VECTOR_INDEX_EF_SEARCH = 64;

/** Tail debounce for the flush scheduler shared by all mutators. */
const FLUSH_DEBOUNCE_MS = 1_000;

// ── Snapshot persistence ────────────────────────────────────────────────────

/** Embedding model id the persisted snapshot was built against. */
const DEFAULT_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

/** Filename of the binary HNSW graph under `<userData>`. */
const SNAPSHOT_BIN_FILENAME = 'vector-index.bin';

/** Filename of the JSON `VectorIndexManifest` companion under `<userData>`. */
const SNAPSHOT_MANIFEST_FILENAME = 'vector-index.json';

/** Manifest schema version this build understands; bumped on incompatible changes. */
const MANIFEST_VERSION = 1 as const;

// ── Module state ────────────────────────────────────────────────────────────
//
// All mutating operations and queries run on a single HierarchicalNSW
// instance. Concurrent re-entry from multiple IPC handlers is serialised via
// `chain` (mirrors the embedding service's approach). The label maps are
// kept in lockstep with `index.addPoint` calls, never reordered, and are
// serialised by task 5.2 alongside the binary graph.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let HierarchicalNSWCtor: { new (space: 'cosine' | 'l2' | 'ip', dim: number): HierarchicalNSWClass } | null = null;

let index: HierarchicalNSWClass | null = null;
let dim: number = VECTOR_INDEX_DIM;
let nextLabel: number = 0;
const idToLabel = new Map<string, number>();
const labelToId = new Map<number, string>();

/**
 * Embedding model id the live in-memory index was populated against. Used
 * by `preloadVectorIndex` to invalidate snapshots produced by a different
 * model id (Requirement 3.4 — "modelId-mismatch" snapshot-corrupt reason).
 *
 * Intentionally a `let` and not a constant so a future model swap can
 * mutate it through a setter; for now it tracks `DEFAULT_MODEL_ID`.
 */
let currentModelId: string = DEFAULT_MODEL_ID;

/**
 * Test-only override for the snapshot directory. When non-null it short-
 * circuits the `app.getPath('userData')` lookup so property tests
 * (5.7 / 5.8) can drive the service against a temp dir without bringing up
 * a full Electron environment. Cleared by `__resetVectorIndexForTests`.
 */
let snapshotDirOverride: string | null = null;

/** Serialise mutating operations and queries on the native session. */
let chain: Promise<unknown> = Promise.resolve();

/** Pending debounced flush handle. */
let flushTimer: ReturnType<typeof setTimeout> | null = null;

// ── Lazy package load ───────────────────────────────────────────────────────

/**
 * Resolve the `HierarchicalNSW` constructor lazily. Same dynamic-import
 * rationale as the other native services in this directory: the package is
 * externalised by the electron Vite build, so the actual `.node` addon is
 * loaded from `node_modules/` on first use rather than baked into the chunk.
 */
function loadHnsw(): typeof HierarchicalNSWCtor extends null
  ? never
  : { new (space: 'cosine' | 'l2' | 'ip', dim: number): HierarchicalNSWClass } {
  if (HierarchicalNSWCtor) return HierarchicalNSWCtor;
  // `require` (CJS) keeps the import synchronous and avoids any top-level
  // `await` propagation into the IPC handlers (which expect a thenable
  // shape). The package itself is CJS so a dynamic ESM import would just
  // wrap the same default export.
  const mod = require('hnswlib-node') as typeof import('hnswlib-node');
  HierarchicalNSWCtor = mod.HierarchicalNSW as unknown as {
    new (space: 'cosine' | 'l2' | 'ip', dim: number): HierarchicalNSWClass;
  };
  return HierarchicalNSWCtor;
}

/**
 * Build a fresh `HierarchicalNSW` configured with the project defaults.
 * Resets the label maps and `nextLabel` counter to zero.
 */
function createIndex(numDimensions: number): HierarchicalNSWClass {
  const Ctor = loadHnsw();
  const idx = new Ctor('cosine', numDimensions);
  idx.initIndex(VECTOR_INDEX_MAX_ELEMENTS, VECTOR_INDEX_M, VECTOR_INDEX_EF_CONSTRUCTION);
  idx.setEf(VECTOR_INDEX_EF_SEARCH);
  return idx;
}

/**
 * Ensure `index.getMaxElements()` has headroom for `additional` more inserts
 * before they touch the threshold. Resizes by `VECTOR_INDEX_RESIZE_FACTOR`
 * when the projected occupancy crosses `VECTOR_INDEX_RESIZE_AT`.
 */
function ensureCapacity(additional: number): void {
  if (!index) return;
  const max = index.getMaxElements();
  const projected = nextLabel + additional;
  if (projected >= max * VECTOR_INDEX_RESIZE_AT) {
    const newMax = Math.max(
      Math.ceil(max * VECTOR_INDEX_RESIZE_FACTOR),
      projected + 1,
    );
    index.resizeIndex(newMax);
  }
}

// ── Telemetry / error sink (placeholder until task 5.3) ─────────────────────

/**
 * Stand-in emitter for typed errors / metric events.
 *
 * In the wired build (task 5.3) this routes through the renderer's
 * `telemetry.emit` over the `ipc-sync-message` channel. For now it just
 * `console.warn`s the structured payload — task 5.1's only job is to
 * preserve the typed shape so 5.3 can swap the sink without touching the
 * call sites here.
 */
type VectorIndexDiagnostic =
  | {
      kind: 'vector-index.query-invalid';
      reason: 'k-non-positive' | 'dim-mismatch';
    }
  | {
      kind: 'vector-index.snapshot-corrupt';
      reason:
        | 'truncated'
        | 'manifest-missing'
        | 'version-mismatch'
        | 'dim-mismatch'
        | 'modelId-mismatch';
    };

function emitDiagnostic(event: VectorIndexDiagnostic): void {
  // Task 5.3 will replace this stub with the actual IPC telemetry forward.
  console.warn(`[vectorIndexService] ${JSON.stringify(event)}`);
}

// ── Debounced flush scheduler ───────────────────────────────────────────────

/**
 * Schedule a debounced call to the (currently stub) `flushIndex` writer.
 *
 * Every mutating operation calls this. Repeated calls within
 * `FLUSH_DEBOUNCE_MS` collapse into a single trailing flush — the design's
 * "1 s tail" semantics. Task 5.2 implements the actual write to
 * `vector-index.bin` + `vector-index.json`; until then `flushIndex` is a
 * harmless no-op so the scheduler can be exercised end-to-end without
 * touching disk.
 */
function scheduleFlush(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    // Don't await — fire-and-forget; errors land in the (yet to be wired)
    // telemetry sink in task 5.2.
    void flushIndex().catch((err) => {
      console.warn(
        `[vectorIndexService] debounced flush failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }, FLUSH_DEBOUNCE_MS);
}

// ── Snapshot directory resolution ───────────────────────────────────────────

/**
 * Resolve the directory holding `vector-index.bin` and `vector-index.json`.
 *
 * In production the dir is `app.getPath('userData')` — the standard place
 * for per-user persistent state, alongside the existing `dist/vendor`
 * model cache. Tests inject a temp dir via `__setSnapshotDirForTests` so
 * they can drive the round-trip property tests (5.7 / 5.8) without a full
 * Electron environment.
 */
function getSnapshotDir(): string {
  if (snapshotDirOverride !== null) return snapshotDirOverride;
  // Same `createRequire` rationale as the hnswlib loader above: this module
  // is bundled as ESM but Electron exports `app` through a CJS module that
  // ESM named imports can't resolve cleanly.
  const electron = require('electron') as typeof import('electron');
  return electron.app.getPath('userData');
}

/** Best-effort delete of both snapshot files. Missing files are ignored. */
function deleteSnapshotFiles(dir: string): void {
  for (const filename of [SNAPSHOT_BIN_FILENAME, SNAPSHOT_MANIFEST_FILENAME]) {
    try {
      fs.unlinkSync(path.join(dir, filename));
    } catch {
      // ENOENT or permission issue — nothing actionable, continue.
    }
  }
}

// ── Public surface ──────────────────────────────────────────────────────────

/**
 * Cold-start path: load the persisted snapshot if present, validate it
 * against the current runtime (model id + dimension + manifest version),
 * and rehydrate the in-memory state. On any failure the service returns
 * to an empty in-memory state and emits a typed `vector-index.snapshot-
 * corrupt` diagnostic — the renderer's hydration path (task 6.2) reacts
 * by issuing a `vectorIndex:rebuild` from IndexedDB (Requirement 3.4).
 *
 * Failure modes (Requirement 3.4 / design.md §"Persisted Vector_Index
 * snapshot" — "any field missing, or version !== 1, or modelId !== current
 * ModelId, or any read error → discard both files and trigger rebuild"):
 *
 * 1. Manifest file missing or unreadable JSON  → `manifest-missing`
 * 2. `version !== 1`                           → `version-mismatch`
 * 3. `modelId !== currentModelId`              → `modelId-mismatch`
 * 4. `dim !== VECTOR_INDEX_DIM`                → `dim-mismatch`
 * 5. Binary file unreadable / hnswlib parse fails → `truncated`
 *
 * In every failure mode the snapshot files are best-effort deleted so the
 * next start sees a clean slate and does not re-trigger the same diagnostic.
 *
 * Drives all work through `chain` so a concurrent IPC call (e.g. during a
 * deferred startup task) can never observe a half-loaded index.
 */
export async function preloadVectorIndex(): Promise<void> {
  const run = chain.then(async () => {
    const dir = getSnapshotDir();
    const binPath = path.join(dir, SNAPSHOT_BIN_FILENAME);
    const manifestPath = path.join(dir, SNAPSHOT_MANIFEST_FILENAME);

    // 1. Manifest read + parse. ENOENT, EACCES, or malformed JSON all collapse
    //    to `manifest-missing` — the renderer reaction is identical
    //    (rebuild from IndexedDB) so distinguishing them buys nothing.
    let manifestRaw: string;
    try {
      manifestRaw = fs.readFileSync(manifestPath, 'utf8');
    } catch {
      emitDiagnostic({
        kind: 'vector-index.snapshot-corrupt',
        reason: 'manifest-missing',
      });
      deleteSnapshotFiles(dir);
      return;
    }

    let manifest: VectorIndexManifest;
    try {
      manifest = JSON.parse(manifestRaw) as VectorIndexManifest;
    } catch {
      emitDiagnostic({
        kind: 'vector-index.snapshot-corrupt',
        reason: 'manifest-missing',
      });
      deleteSnapshotFiles(dir);
      return;
    }

    // 2. Schema-version gate. Bumped on incompatible changes.
    if (manifest.version !== MANIFEST_VERSION) {
      emitDiagnostic({
        kind: 'vector-index.snapshot-corrupt',
        reason: 'version-mismatch',
      });
      deleteSnapshotFiles(dir);
      return;
    }

    // 3. Model-id gate. A snapshot built against a different embedding
    //    model is unsafe to query because the vector space is different.
    if (manifest.modelId !== currentModelId) {
      emitDiagnostic({
        kind: 'vector-index.snapshot-corrupt',
        reason: 'modelId-mismatch',
      });
      deleteSnapshotFiles(dir);
      return;
    }

    // 4. Dimension gate. Defends against an in-place model-id keep with a
    //    dimension change (e.g. swapping MiniLM for a larger model).
    if (manifest.dim !== VECTOR_INDEX_DIM) {
      emitDiagnostic({
        kind: 'vector-index.snapshot-corrupt',
        reason: 'dim-mismatch',
      });
      deleteSnapshotFiles(dir);
      return;
    }

    // 5. Binary read. hnswlib's `readIndexSync` overwrites all in-memory
    //    state from the file, including `maxElements` — we resize back up
    //    to `VECTOR_INDEX_MAX_ELEMENTS` if the saved snapshot was smaller
    //    so subsequent inserts have headroom without an immediate resize.
    try {
      const Ctor = loadHnsw();
      const fresh = new Ctor('cosine', manifest.dim);
      fresh.readIndexSync(binPath);
      if (fresh.getMaxElements() < VECTOR_INDEX_MAX_ELEMENTS) {
        fresh.resizeIndex(VECTOR_INDEX_MAX_ELEMENTS);
      }
      fresh.setEf(VECTOR_INDEX_EF_SEARCH);

      // Successful load — commit the rehydrated state atomically.
      index = fresh;
      dim = manifest.dim;
      nextLabel = manifest.nextLabel;

      idToLabel.clear();
      for (const [id, label] of Object.entries(manifest.idToLabel)) {
        idToLabel.set(id, label);
      }

      labelToId.clear();
      // The manifest stringifies uint32 keys for JSON; parse them back to
      // numbers so query-time `labelToId.get(label)` lookups (with a number
      // key from hnswlib) succeed.
      for (const [labelStr, id] of Object.entries(manifest.labelToId)) {
        labelToId.set(Number(labelStr), id);
      }
    } catch {
      // hnswlib throws on a truncated file, dimension mismatch baked into
      // the binary, or any I/O error. Reset to empty and surface so the
      // renderer can rebuild.
      emitDiagnostic({
        kind: 'vector-index.snapshot-corrupt',
        reason: 'truncated',
      });
      deleteSnapshotFiles(dir);
      index = null;
      idToLabel.clear();
      labelToId.clear();
      nextLabel = 0;
    }
  });
  chain = run.catch(() => undefined);
  await run;
}

/**
 * Reset the index and label maps, then bulk-insert every item. Used both for
 * the corrupt-snapshot recovery path (Requirement 3.4) and for the
 * `vectorIndex:rebuild` IPC the renderer issues after enumerating IndexedDB.
 *
 * `dim` parameter exists so the renderer can declare the runtime dimension
 * explicitly — even though MiniLM-L6 is fixed at 384 today, future model
 * swaps would change this value and the manifest's `dim` field would be
 * rebuilt to match.
 */
export async function rebuildVectorIndex(
  items: readonly IndexedItem[],
  numDimensions: number,
): Promise<void> {
  const run = chain.then(async () => {
    dim = numDimensions;
    idToLabel.clear();
    labelToId.clear();
    nextLabel = 0;
    index = createIndex(numDimensions);

    if (items.length > 0) {
      ensureCapacity(items.length);
      for (const item of items) {
        const label = nextLabel++;
        idToLabel.set(item.id, label);
        labelToId.set(label, item.id);
        index.addPoint(item.vector, label);
      }
    }
  });
  chain = run.catch(() => undefined);
  await run;
  scheduleFlush();
}

/**
 * Insert (or overwrite) a batch of items. Each new id is assigned the next
 * monotonically-increasing uint32 label; ids that already have a label are
 * re-`addPoint`ed under that same label so the value is updated in place.
 *
 * The native session is locked for the duration of the loop via `chain`, so
 * concurrent queries observe the batch as either fully-applied or
 * not-yet-applied — never half-applied.
 */
export async function addBatchToIndex(
  items: readonly IndexedItem[],
): Promise<void> {
  if (items.length === 0) return;

  const run = chain.then(async () => {
    if (!index) {
      index = createIndex(dim);
    }
    ensureCapacity(items.length);
    for (const item of items) {
      let label = idToLabel.get(item.id);
      if (label === undefined) {
        label = nextLabel++;
        idToLabel.set(item.id, label);
        labelToId.set(label, item.id);
      }
      index.addPoint(item.vector, label);
    }
  });
  chain = run.catch(() => undefined);
  await run;
  scheduleFlush();
}

/**
 * Mark an id's label as deleted in the HNSW graph and drop it from the live
 * `idToLabel` map so future queries can filter it out (the inverse
 * `labelToId` map is preserved so manifest persistence remains consistent —
 * design says "label reuse not supported cleanly", so the label is never
 * recycled).
 *
 * No-op when the id is not currently indexed.
 */
export async function removeFromIndex(id: string): Promise<void> {
  const run = chain.then(async () => {
    const label = idToLabel.get(id);
    if (label === undefined || !index) return;
    try {
      index.markDelete(label);
    } catch (err) {
      // hnswlib throws on double-delete; treat as idempotent.
      console.warn(
        `[vectorIndexService] markDelete(${label}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    idToLabel.delete(id);
  });
  chain = run.catch(() => undefined);
  await run;
  scheduleFlush();
}

/**
 * k-nearest-neighbour query.
 *
 * Returns `[]` synchronously when `k <= 0` or `vector.length !== dim`,
 * emitting a typed `vector-index.query-invalid` diagnostic in either case
 * (Requirement 2.7 / Property 7).
 *
 * Otherwise returns at most `min(k, n)` `QueryHit`s in non-increasing score
 * order. `score = 1 - distance` because hnswlib returns cosine distance
 * (`1 − sum(x_i*y_i) / (‖x‖·‖y‖)`); for L2-normalised vectors this is
 * identical to cosine similarity. Labels marked-deleted (i.e. dropped from
 * the live `idToLabel` map) are filtered post-search.
 */
export async function queryIndex(
  vector: number[],
  k: number,
): Promise<QueryHit[]> {
  if (k <= 0) {
    emitDiagnostic({ kind: 'vector-index.query-invalid', reason: 'k-non-positive' });
    return [];
  }
  if (vector.length !== dim) {
    emitDiagnostic({ kind: 'vector-index.query-invalid', reason: 'dim-mismatch' });
    return [];
  }
  if (!index) return [];

  const run = chain.then(async () => {
    const liveCount = idToLabel.size;
    if (liveCount === 0) return [] as QueryHit[];

    // hnswlib's `searchKnn` over-fetches above the deleted-label noise so a
    // run of recent deletes can't starve the result. We ask for `k` against
    // the current live set; markDelete'd labels are filtered by hnswlib
    // itself, but we additionally cross-reference `labelToId` and the live
    // `idToLabel` map so a label that was removed within the same chain
    // entry as the query can never leak through.
    const want = Math.min(k, liveCount);
    const numNeighbors = Math.min(want, index!.getCurrentCount());
    if (numNeighbors === 0) return [] as QueryHit[];

    const result: SearchResult = index!.searchKnn(vector, numNeighbors);
    const hits: QueryHit[] = [];
    for (let i = 0; i < result.neighbors.length; i++) {
      const label = result.neighbors[i];
      const id = labelToId.get(label);
      if (id === undefined) continue;
      // `idToLabel` is the live set; if the id is missing the label was
      // markDelete'd so skip it (defence-in-depth alongside hnswlib's own
      // filter).
      if (idToLabel.get(id) !== label) continue;
      hits.push({ id, score: 1 - result.distances[i] });
    }
    // hnswlib already returns ascending distance / descending score, but
    // the live-set filter above can drop entries — sort defensively so the
    // contract (Property 5: non-increasing `score`) holds even when some
    // hits were filtered out.
    hits.sort((a, b) => b.score - a.score);
    return hits;
  });
  chain = run.catch(() => undefined);
  return run;
}

/**
 * Status snapshot of the in-memory index, used by the renderer's boot
 * hydration path (Requirements 3.1, 3.2). After {@link preloadVectorIndex}
 * runs the renderer reads this report to decide whether to issue a
 * `vectorIndex:rebuild` from IndexedDB:
 *
 *   - `count > 0`  → snapshot loaded successfully, no rebuild needed.
 *   - `count === 0` → snapshot was missing or corrupt (or the live KB is
 *     empty); the renderer rebuilds from IndexedDB iff there are chunks
 *     to ship.
 *
 * Pure read — does not touch the chain or disk.
 */
export function getIndexStatus(): { count: number; dim: number } {
  return { count: idToLabel.size, dim };
}

/**
 * Synchronous core of `flushIndex`. Performs the disk writes inline so the
 * `app.on('before-quit')` handler in `electron/main.ts` can persist the
 * latest snapshot before shutdown — Electron does not await async
 * `before-quit` listeners, so an async-only flush would race the process
 * exit.
 *
 * Behaviour:
 *
 * - **No-op** when `index === null` — there is no in-memory state to
 *   persist (e.g. the user never opened the Knowledge_Base, or
 *   `preloadVectorIndex` failed and no rebuild has run yet). The on-disk
 *   files are left untouched in this case so a stale snapshot stays
 *   available for the next start.
 * - **Builds the manifest** from live module state: `count` is the live
 *   (non-deleted) item count taken from `idToLabel.size`, the inverse
 *   `labelToId` map is stringified for JSON, and `builtAt` records the
 *   write timestamp.
 * - **Writes the binary first**, then the manifest. The binary is the
 *   load-bearing artefact; if a crash interleaves the two writes the
 *   manifest is what gets discarded on the next start (per the
 *   `manifest-missing` branch of `preloadVectorIndex`), preserving the
 *   on-disk graph.
 * - **Creates the destination dir** if it doesn't exist
 *   (`fs.mkdirSync({ recursive: true })`); first-run on a fresh user
 *   profile would otherwise fail with ENOENT.
 *
 * Errors are propagated to the caller. The async wrapper `flushIndex`
 * catches and surfaces them through the chain; the `before-quit` handler
 * in `main.ts` wraps this call in its own try/catch so a flush failure
 * never blocks shutdown.
 */
export function flushIndexSync(): void {
  if (!index) return;

  const dir = getSnapshotDir();
  const binPath = path.join(dir, SNAPSHOT_BIN_FILENAME);
  const manifestPath = path.join(dir, SNAPSHOT_MANIFEST_FILENAME);

  // Live (non-deleted) item count is `idToLabel.size`. The `labelToId` map
  // intentionally retains entries for `markDelete`'d labels so the manifest
  // can be reconstructed identically on the next load — the live filter is
  // applied at query time via `idToLabel`.
  const manifest: VectorIndexManifest = {
    version: MANIFEST_VERSION,
    modelId: currentModelId,
    dim,
    count: idToLabel.size,
    nextLabel,
    idToLabel: Object.fromEntries(idToLabel),
    labelToId: Object.fromEntries(
      Array.from(labelToId.entries()).map(([k, v]) => [String(k), v]),
    ),
    builtAt: Date.now(),
  };

  fs.mkdirSync(dir, { recursive: true });
  index.writeIndexSync(binPath);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
}

/**
 * Asynchronous flush wrapper that runs `flushIndexSync` inside the shared
 * `chain` so the native session is never re-entered concurrently with an
 * in-flight add/remove/rebuild/query. This is the public surface used by
 * the IPC handler in task 5.3 and by the debounced flush scheduler.
 *
 * Errors are surfaced to the caller and recorded on the chain's catch
 * branch so subsequent operations can proceed.
 */
export async function flushIndex(): Promise<void> {
  const run = chain.then(async () => {
    flushIndexSync();
  });
  chain = run.catch(() => undefined);
  await run;
}

// ── Test-only helpers ───────────────────────────────────────────────────────
//
// Property tests (5.4–5.6) and snapshot round-trip tests (5.7–5.8) need a
// way to reset module state between cases. Exported under a discriminated
// name so it's clearly out-of-band and never imported by production code.
// Idempotent: cancels any in-flight debounced flush.
export function __resetVectorIndexForTests(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  index = null;
  idToLabel.clear();
  labelToId.clear();
  nextLabel = 0;
  dim = VECTOR_INDEX_DIM;
  currentModelId = DEFAULT_MODEL_ID;
  snapshotDirOverride = null;
  chain = Promise.resolve();
}

/**
 * Inject a snapshot directory for tests. Pass a temp dir (e.g. one created
 * with `os.tmpdir()` + `mkdtempSync`) before invoking `flushIndex` /
 * `preloadVectorIndex`; pass `null` to clear and fall back to
 * `app.getPath('userData')`.
 *
 * Property tests 5.7 (round-trip) and 5.8 (corruption recovery) drive the
 * service against a per-test temp dir through this hook so they don't
 * pollute the real user-data path and don't require booting Electron.
 */
export function __setSnapshotDirForTests(dir: string | null): void {
  snapshotDirOverride = dir;
}
