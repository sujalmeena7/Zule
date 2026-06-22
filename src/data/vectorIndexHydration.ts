// ============================================
// Zule AI — Vector_Index renderer-side boot hydration
// ============================================
//
// Renderer-side cold-start hydration for the main-process Vector_Index
// (Requirements 3.1, 3.2). Called from the app's `whenReady` boot path
// after `embedPreload` and before the Knowledge_Base UI signals ready,
// the helper pre-warms the embedding model and asks the main process to
// load the persisted snapshot. If the snapshot was missing or corrupt
// the main process reports a `count` of `0` from `vectorIndex:hydrate`,
// and we recover by enumerating every chunk in IndexedDB and shipping
// them back through `vectorIndex:rebuild`.
//
// The legacy linear scan in `kbSearch.searchChunks` keeps serving below
// `QUANTIZATION_THRESHOLD`, so a hydration failure here only degrades
// large-Knowledge_Base ANN search — small KBs continue to work unchanged
// (Requirement 4.4).

import { database, type KBChunk, type KBDocument } from './database';
import { dequantizeFromStorage } from '../brain/vectorStore';
import type { IndexedItem } from '../types/vectorIndex';

/**
 * MiniLM-L6 output dimension declared to the main-process index. Mirrored
 * here to avoid pulling the main-process module into the renderer bundle.
 * Stays in sync with `electron/vectorIndexService.ts::VECTOR_INDEX_DIM`.
 */
const VECTOR_INDEX_DIM = 384;

/**
 * Construct the stable Vector_Index id for a chunk. The persisted
 * `KBChunk` schema has no first-class `id` field, so we derive a stable,
 * collision-free identifier from the parent document id and the chunk's
 * positional index within `doc.chunks`. Both upload-time inserts
 * (`Settings.handleAddDocument`, task 6.3) and removal paths
 * (`database.removeDocument` / `kbRetention`, task 6.4) use the same
 * convention so add / remove / query all agree on the canonical id
 * shape.
 */
export function chunkIndexId(docId: string, chunkIndex: number): string {
  return `${docId}#${chunkIndex}`;
}

/**
 * Materialise every Knowledge_Base chunk into the `IndexedItem[]` shape
 * the main-process Vector_Index expects. Each chunk vector is decoded
 * via {@link dequantizeFromStorage} so the IPC payload is always a
 * Float32 `number[]` (Requirement 4.1). Chunks that are missing both
 * `vector` and `vectorQ`, or whose decoded vector dimension does not
 * match the runtime `VECTOR_INDEX_DIM`, are skipped — they cannot be
 * inserted into a 384-d HNSW graph and an attempt would crash the
 * native addon.
 */
export function buildIndexedItemsFromDocuments(
  documents: readonly KBDocument[],
): IndexedItem[] {
  const items: IndexedItem[] = [];
  for (const doc of documents) {
    for (let i = 0; i < doc.chunks.length; i++) {
      const chunk: KBChunk = doc.chunks[i];
      const vector = dequantizeFromStorage(chunk);
      if (vector.length !== VECTOR_INDEX_DIM) continue;
      items.push({ id: chunkIndexId(doc.id, i), vector });
    }
  }
  return items;
}

/**
 * Boot-time Vector_Index hydration.
 *
 * Order of operations:
 *
 *   1. Best-effort `embed:preload` — pre-warms the main-process
 *      embedding model so the user's first query is fast. Failures here
 *      do not block hydration (the search path retries on demand).
 *   2. `vectorIndex:hydrate` — drives `preloadVectorIndex` on the main
 *      side, returning the live in-memory `count`.
 *   3. If the index is empty AND IndexedDB carries chunks, enumerate the
 *      Knowledge_Base, dequantise each chunk, and call
 *      `vectorIndex:rebuild` so the next `database.search` finds the
 *      ANN graph populated.
 *
 * Idempotent: callers can fire this once per boot and the function
 * short-circuits when there is nothing to do (no Electron bridge, empty
 * KB, or already-hydrated index). Errors are swallowed and logged so a
 * hydration glitch can never block the rest of the app boot — the
 * legacy linear-scan path remains a correct fallback below
 * `QUANTIZATION_THRESHOLD`, and even above it `database.search` already
 * defends against an unavailable bridge.
 */
export async function hydrateVectorIndexOnBoot(): Promise<void> {
  if (typeof window === 'undefined') return;
  const api = window.electronAPI;
  if (!api) return;

  // 1. Pre-warm the embedding model. Failures are not fatal — the search
  //    path triggers a lazy load if needed.
  if (typeof api.embedPreload === 'function') {
    try {
      await api.embedPreload();
    } catch (err) {
      console.warn('[vectorIndexHydration] embedPreload failed:', err);
    }
  }

  // 2. Ask the main process to load the persisted snapshot and report
  //    its live count. Bail out cleanly when the bridge is unavailable
  //    (e.g. running in a non-Electron host).
  if (typeof api.vectorIndexHydrate !== 'function') return;

  let status: { count: number; dim: number };
  try {
    status = await api.vectorIndexHydrate();
  } catch (err) {
    console.warn('[vectorIndexHydration] vectorIndex:hydrate failed:', err);
    return;
  }

  // 3. Decide whether a rebuild is required. The main process reports
  //    `count === 0` for both "snapshot missing/corrupt" and "live
  //    Knowledge_Base is empty". We only rebuild when there are chunks
  //    in IndexedDB to populate the index from.
  if (status.count > 0) return;
  if (typeof api.vectorIndexRebuild !== 'function') return;

  let documents: KBDocument[];
  try {
    documents = await database.getAllDocuments();
  } catch (err) {
    console.warn(
      '[vectorIndexHydration] failed to read Knowledge_Base for rebuild:',
      err,
    );
    return;
  }

  const items = buildIndexedItemsFromDocuments(documents);
  if (items.length === 0) return;

  try {
    await api.vectorIndexRebuild(items, VECTOR_INDEX_DIM);
  } catch (err) {
    console.warn('[vectorIndexHydration] vectorIndex:rebuild failed:', err);
  }
}
