// ============================================
// Zule AI — Vector_Index shared data types
// ============================================
//
// Shared type contracts for the main-process Vector_Index service
// (see design.md §Components and Interfaces > "Vector_Index Service")
// and the renderer-side IPC client. Both processes import from this
// module to keep the IPC payload shape canonical.
//
// The Vector_Index is an HNSW graph over MiniLM-L6 embeddings (384-d,
// L2-normalised) backed by `hnswlib-node`. It indexes by uint32 labels
// internally; the string ↔ label mapping is part of the persisted
// manifest below so it survives restart (see design.md §Data Models >
// "Persisted Vector_Index snapshot").

/**
 * A single embedded chunk inserted into the Vector_Index.
 *
 * `vector` is always a Float32 `number[]` (L2-normalised) — quantized
 * chunks are dequantised at the renderer-side call site via
 * `vectorStore.dequantizeFromStorage` before they are shipped over the
 * `vectorIndex:addBatch` IPC, so the service itself never needs to
 * know about the int8 storage policy.
 */
export interface IndexedItem {
  id: string;
  vector: number[];
}

/**
 * A single result row from a Vector_Index query.
 *
 * `score` is a cosine similarity in the closed interval `[-1, 1]`.
 * Results are returned in non-increasing order of `score`
 * (see Requirement 2.2).
 */
export interface QueryHit {
  id: string;
  score: number;
}

/**
 * On-disk manifest companion to `vector-index.bin`.
 *
 * Persisted as JSON to `<userData>/vector-index.json`. Loading rule:
 * any field missing, or `version !== 1`, or `modelId !== currentModelId`,
 * or any read error → discard both files and trigger rebuild
 * (Requirement 3.4).
 */
export interface VectorIndexManifest {
  /** Bumped on incompatible changes. */
  version: 1;
  /** Embedding model id, e.g. 'Xenova/all-MiniLM-L6-v2'. */
  modelId: string;
  /** Embedding dimension, e.g. 384 for MiniLM-L6. */
  dim: number;
  /** Live (non-deleted) item count. */
  count: number;
  /** Monotonic label counter; never reused on delete. */
  nextLabel: number;
  /** Mapping from string id to uint32 label. */
  idToLabel: Record<string, number>;
  /** Inverse mapping from uint32 label (stringified for JSON) to id. */
  labelToId: Record<string, string>;
  /** `Date.now()` at the time the snapshot was written. */
  builtAt: number;
}
