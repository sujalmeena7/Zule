// ============================================
// Zule AI — Local Vector Embeddings (Transformers.js)
// ============================================
//
// Wraps the `@xenova/transformers` `feature-extraction` pipeline and
// implements the Vector_Index v2 contract from design.md §7.
//
// Defects fixed by task 5.1:
//   * (Requirement 6.1) Initialization no longer passes an async function
//     as the executor of `new Promise`. The pipeline-loading work runs in a
//     separate async method that resolves/rejects a deferred-promise — so
//     synchronous errors thrown by the executor cannot escape the Promise
//     contract, and the lint-style "no-async-promise-executor" footgun is
//     gone.
//   * (Requirement 6.2) When init fails we no longer fail-fast forever.
//     Each `generateEmbedding` call after a failure retries init with
//     exponential backoff (250 ms, 500 ms, 1 000 ms) up to a total of
//     `MAX_INIT_ATTEMPTS` attempts. After the cap, every subsequent
//     `initialize` / `generateEmbedding` call rejects synchronously with a
//     typed `VectorIndexInitError` whose `kind` matches the
//     `'vector-index.init-failed'` variant of `ZuleError`.
//
// Behaviours added by task 5.2:
//   * (Requirement 6.3) A session-scoped 256-entry LRU caches the
//     embedding for the most-recent distinct query strings. Hits avoid
//     a tokenize + transformer pass entirely and are observable through
//     `getCacheStats()`. The cache is invalidated automatically when the
//     embedding model id changes (e.g. the user switches model in
//     Settings) and can be cleared manually via `invalidateQueryCache()`
//     — the entry point used by Knowledge_Base deletion (task 5.3,
//     Requirement 6.7).
//   * (Requirement 6.4) `quantizeForStorage(vector, currentStoredCount)`
//     returns either the original vector or the int8-quantized form
//     depending on whether the existing stored-chunk count is at or
//     above the `QUANTIZATION_THRESHOLD` (default 1 000). The helper is
//     pure and is consumed by `database.addDocument` to bound on-disk
//     storage growth at a 4× compression ratio relative to the
//     Float32Array baseline.
//
// Out of scope for task 5.2 (left for follow-up tasks 5.3 / 5.4 / 5.5):
//   * Configurable retrieval threshold / `maxResults` (Requirement 6.5)
//   * Knowledge_Base retention cap (Requirement 6.6)
//
// The public API surface used by the existing app
// (`subscribeProgress`, `initialize`, `generateEmbedding`,
// `calculateCosineSimilarity`) is preserved exactly so that current
// consumers (`database.ts`, `summaryEngine.ts`, `Settings.tsx`,
// `ModelLoader.tsx`) compile without changes.

import { pipeline, env } from '@xenova/transformers';
import type { ZuleError } from '../types/errors';
import { modelDownloadRegistry } from './modelDownloadRegistry';
import {
  quantize,
  dequantize,
  type QuantizedVector,
} from './vectorMath';

// Embedding-model resolution strategy (privacy / stealth / offline):
//   - Prefer the self-hosted model mirrored into `public/vendor/models/`
//     by `scripts/fetch-models.mjs` (served from the application origin at
//     `/vendor/models/`). This means no network call to huggingface.co on
//     the common path.
//   - Keep `allowRemoteModels = true` as a fallback so that if the local
//     copy is ever missing (e.g. the mirror step was skipped), the runtime
//     still degrades to the remote HuggingFace fetch. The HF CSP
//     `connect-src` entries in index.html exist for exactly this fallback.
//   - `useBrowserCache = true` so even the fallback path is fetched at most
//     once and then served from IndexedDB.
env.allowLocalModels = true;
env.allowRemoteModels = true;
env.useBrowserCache = true;
// Path is relative to the application origin; Transformers.js appends
// `<modelId>/<file>` to it (e.g. `/vendor/models/Xenova/all-MiniLM-L6-v2/
// onnx/model_quantized.onnx`).
env.localModelPath = '/vendor/models/';

// Self-host the ONNX runtime WASM (Transformers.js inference backend) so
// it loads from the application origin rather than a third-party CDN
// (Requirement 15.7, 21.5). The dist files from `onnxruntime-web` are
// mirrored into `public/vendor/onnx/` by `scripts/copy-vendor.mjs`,
// which is invoked from the `zule:copy-vendor` Vite plugin on
// dev-server start and at `buildStart` of every production build.
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
  envBackends.onnx.wasm.wasmPaths = '/vendor/onnx/';
  // Force the SINGLE-THREADED WASM backend. The multi-threaded backend
  // (`ort-wasm-threaded`) requires SharedArrayBuffer, which is only
  // available when the page is cross-origin isolated (COOP: same-origin
  // + COEP: require-corp). The Vite dev server and the Electron file://
  // load do not set those headers, so the threaded backend's worker
  // spin-up hard-crashes the renderer process. numThreads = 1 selects the
  // non-threaded `ort-wasm` build, which has no SharedArrayBuffer
  // dependency and runs fine in a non-isolated context.
  envBackends.onnx.wasm.numThreads = 1;
  // Run inference on the main thread rather than an ONNX proxy worker —
  // the embedding model is small and the proxy worker path is another
  // place that can fail without SharedArrayBuffer.
  envBackends.onnx.wasm.proxy = false;
  // Disable the SIMD WASM build. onnxruntime-web@1.14.0 (pinned by
  // @xenova/transformers@2.17) ships a SIMD kernel that segfaults
  // (Windows ACCESS_VIOLATION, exit 0xC0000005) under the very new
  // Electron 42 / V8 build. The plain `ort-wasm.wasm` kernel is slower
  // but stable. If onnxruntime-web is later upgraded this can be removed.
  envBackends.onnx.wasm.simd = false;
}

export type ProgressCallback = (progress: {
  status: string;
  name: string;
  file: string;
  progress: number;
  loaded: number;
  total: number;
}) => void;

/**
 * Maximum number of init attempts before subsequent calls fail fast with
 * a typed error. Matches the design's "Vector_Index init: 3 attempts"
 * bound (Requirement 6.2, design.md §"Bounded fault recovery").
 */
export const MAX_INIT_ATTEMPTS = 3;

/**
 * Exponential backoff series applied between init attempts, in ms. The
 * N-th attempt (1-indexed, N >= 2) waits `INIT_BACKOFF_MS[N - 2]` ms
 * before invoking the pipeline loader. With `MAX_INIT_ATTEMPTS === 3`
 * this means:
 *
 *   - attempt 1 → no delay
 *   - attempt 2 → 250 ms backoff
 *   - attempt 3 → 500 ms backoff
 *
 * The 1 000 ms term is documented as the next term in the canonical
 * exponential sequence so the constant matches Requirement 6.2's stated
 * `(250ms, 500ms, 1000ms)` series. It is unused while
 * `MAX_INIT_ATTEMPTS === 3` and would only fire if the cap is ever
 * raised.
 */
export const INIT_BACKOFF_MS = [250, 500, 1000] as const;

/**
 * The default embedding model id. Encodes the canonical
 * Transformers.js MiniLM model used by `Xenova/all-MiniLM-L6-v2`.
 * Stored explicitly so the query-embedding LRU can be invalidated
 * automatically the moment the model id changes.
 */
export const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2' as const;

/**
 * Maximum number of distinct query strings cached by the session-scoped
 * query-embedding LRU. Sized per design.md §7 (Requirement 6.3).
 *
 * Exported so unit tests can assert the bound without relying on a
 * hard-coded magic number duplicated across files.
 */
export const QUERY_CACHE_CAPACITY = 256;

/**
 * Total-stored-chunk threshold above which {@link quantizeForStorage}
 * begins emitting int8-quantized vectors. The threshold lives in this
 * module rather than in `database.ts` so the policy is colocated with
 * the embedding pipeline and so unit tests can pin the constant
 * directly (Requirement 6.4).
 */
export const QUANTIZATION_THRESHOLD = 1000;

/**
 * Discriminated-union return type of {@link quantizeForStorage}. The
 * caller ({@link addDocument}) inspects `kind` to decide which storage
 * shape to persist. Keeping the discriminator on the returned object
 * keeps the call-site exhaustive under `tsc --strict`.
 */
export type ChunkVectorForStorage =
  | { kind: 'raw'; vector: number[] }
  | { kind: 'quantized'; vectorQ: QuantizedVector };

/**
 * Typed error thrown after every init attempt has failed. The
 * `kind` discriminator matches the `vector-index.init-failed` variant
 * of `ZuleError`, so callers can either catch the class or pattern-match
 * on `.kind` like any other domain error.
 */
export class VectorIndexInitError extends Error {
  readonly kind = 'vector-index.init-failed' as const;
  readonly attempts: number;
  // Override Error.cause typing so it is statically known.
  override readonly cause?: unknown;

  constructor(attempts: number, cause?: unknown) {
    super(
      `Vector_Index initialization failed after ${attempts} attempt` +
        (attempts === 1 ? '' : 's'),
    );
    this.name = 'VectorIndexInitError';
    this.attempts = attempts;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }

  /** Project to the canonical `ZuleError` discriminated-union shape. */
  toZuleError(): Extract<ZuleError, { kind: 'vector-index.init-failed' }> {
    return { kind: 'vector-index.init-failed', attempts: this.attempts };
  }
}

/**
 * A simple deferred-promise helper. Constructs a Promise *without* an
 * async executor (Requirement 6.1) and returns the resolve / reject
 * handles so async work can settle the promise from elsewhere.
 */
interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  // The two refs are guaranteed to be assigned synchronously by the
  // executor before `new Promise` returns, so the non-null assertions
  // below are sound.
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Test-only injection point for the timer used between retry attempts.
 * Production code uses the global `setTimeout`. Tests pass a fake to
 * avoid waiting wall-clock seconds.
 */
export interface VectorStoreOptions {
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  /** Override the embedding model id surfaced by `getModelId()`. */
  modelId?: string;
  /** Override the LRU capacity (test-only; production uses 256). */
  queryCacheCapacity?: number;
  /** Override the storage quantization threshold (test-only). */
  quantizationThreshold?: number;
}

export class VectorStore {
  // The loaded `feature-extraction` pipeline; `null` until `initialize`
  // resolves successfully. Typed as `unknown` to avoid leaking
  // Transformers.js's loose `any`-shaped types into the rest of the
  // module.
  private extractor:
    | ((
        text: string,
        opts: { pooling: 'mean'; normalize: true },
      ) => Promise<{ data: ArrayLike<number> }>)
    | null = null;

  /** In-flight init promise (deduplicates concurrent callers). */
  private inFlightInit: Promise<void> | null = null;

  /**
   * Number of init attempts that have completed (success or failure).
   * Capped at `MAX_INIT_ATTEMPTS`. Once the cap is reached, subsequent
   * `initialize` / `generateEmbedding` calls fail synchronously with
   * `VectorIndexInitError`.
   */
  private initAttemptCount = 0;

  private progressListeners: Set<ProgressCallback> = new Set();

  private readonly setTimeoutFn: (cb: () => void, ms: number) => unknown;

  /**
   * Active embedding-model id. The query LRU is keyed by this id so a
   * model swap (e.g. user picks a different MiniLM in Settings) cannot
   * leak stale embeddings from the old model into the new model's
   * cosine search.
   */
  private modelId: string;

  /** Configurable LRU capacity (Requirement 6.3, default 256). */
  private readonly queryCacheCapacity: number;

  /** Configurable quantization threshold (Requirement 6.4, default 1 000). */
  private readonly quantizationThreshold: number;

  /**
   * Session-scoped query-embedding LRU.
   *
   * Implementation note: `Map` preserves insertion order, so the oldest
   * entry is always the first key returned by `keys()`. Hits are
   * promoted by `delete` + `set`, which moves the key to the end. This
   * gives O(1) hit, eviction, and promotion without an explicit linked
   * list.
   *
   * Stored values are plain `number[]` (matching the public
   * `generateEmbedding` return shape) so that callers can hand them
   * directly to `calculateCosineSimilarity` without copying.
   */
  private readonly queryCache: Map<string, number[]> = new Map();

  /**
   * Hit / miss counters surfaced by {@link getCacheStats}. Used by the
   * Telemetry_Module (`embedding.cache` event, design §12) to measure
   * cache effectiveness without exposing the cached strings.
   */
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(opts: VectorStoreOptions = {}) {
    this.setTimeoutFn = opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
    this.modelId = opts.modelId ?? DEFAULT_EMBEDDING_MODEL;
    this.queryCacheCapacity = opts.queryCacheCapacity ?? QUERY_CACHE_CAPACITY;
    this.quantizationThreshold =
      opts.quantizationThreshold ?? QUANTIZATION_THRESHOLD;
  }

  public subscribeProgress(cb: ProgressCallback): () => void {
    this.progressListeners.add(cb);
    return () => {
      this.progressListeners.delete(cb);
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private dispatchProgress(data: any): void {
    for (const listener of this.progressListeners) {
      listener(data);
    }

    // Feed the unified ModelLoader queue (Requirement 20.4)
    if (data.status === 'downloading' || data.status === 'progress') {
      modelDownloadRegistry.upsert({
        id: 'embedding-model',
        label: 'Embedding Model',
        status: 'downloading',
        progress: data.progress ?? 0,
        loaded: data.loaded ?? 0,
        total: data.total ?? 0,
      });
    } else if (data.status === 'done' || data.status === 'ready') {
      modelDownloadRegistry.upsert({
        id: 'embedding-model',
        label: 'Embedding Model',
        status: 'ready',
        progress: 100,
        loaded: data.total ?? 0,
        total: data.total ?? 0,
      });
    }
  }

  /**
   * Initialize the embedding pipeline.
   *
   * Uses the deferred-promise pattern: a Promise is constructed without
   * an async executor (Requirement 6.1), and the async loading work
   * runs in `runInitAttempt` which resolves / rejects the deferred when
   * it completes.
   *
   * On failure, the next call retries with backoff up to
   * `MAX_INIT_ATTEMPTS` total attempts (Requirement 6.2). Once the cap
   * is reached, this method returns a rejected promise carrying a typed
   * `VectorIndexInitError` and never invokes the pipeline loader again.
   */
  public initialize(): Promise<void> {
    if (this.extractor) return Promise.resolve();
    if (this.inFlightInit) return this.inFlightInit;
    if (this.initAttemptCount >= MAX_INIT_ATTEMPTS) {
      return Promise.reject(new VectorIndexInitError(this.initAttemptCount));
    }

    // ---- deferred-promise pattern (Requirement 6.1) ----
    // No `async` executor. The async work lives in a separate method
    // that calls `deferred.resolve` / `deferred.reject`.
    const deferred = createDeferred<void>();
    this.inFlightInit = deferred.promise;
    void this.runInitAttempt(deferred);
    return deferred.promise;
  }

  /**
   * One pass at loading the pipeline. Applies the appropriate backoff
   * delay if this is a retry, increments the attempt counter, and
   * settles the supplied deferred when done.
   */
  private async runInitAttempt(deferred: Deferred<void>): Promise<void> {
    // Number of *completed* attempts before this one. Used to look up
    // the backoff delay so retry #N (N >= 2) waits
    // `INIT_BACKOFF_MS[N - 2]` ms.
    const priorAttempts = this.initAttemptCount;

    if (priorAttempts > 0) {
      const idx = priorAttempts - 1;
      const delayMs =
        INIT_BACKOFF_MS[idx] ??
        INIT_BACKOFF_MS[INIT_BACKOFF_MS.length - 1];
      await this.sleep(delayMs);
    }

    this.initAttemptCount = priorAttempts + 1;

    try {
      this.extractor = (await pipeline(
        'feature-extraction',
        this.modelId,
        {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          progress_callback: (data: any) => this.dispatchProgress(data),
        },
      )) as typeof this.extractor;
      this.inFlightInit = null;
      deferred.resolve();
    } catch (error) {
      this.inFlightInit = null;
      // Surface a dev-time breadcrumb. The user-facing surface is the
      // typed rejection on the final attempt routed through
      // `useZuleError`.
      // eslint-disable-next-line no-console
      console.error('Failed to initialize Transformers.js pipeline:', error);

      if (this.initAttemptCount >= MAX_INIT_ATTEMPTS) {
        deferred.reject(new VectorIndexInitError(this.initAttemptCount, error));
      } else {
        // Intermediate failure: propagate the underlying cause so callers
        // that opt to log it see the original error. The retry loop in
        // `generateEmbedding` will trigger another attempt.
        deferred.reject(error);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.setTimeoutFn(() => resolve(), ms);
    });
  }

  /**
   * Generate an embedding for `text`. If the pipeline is not yet ready,
   * this triggers initialization and — per Requirement 6.2 — retries
   * with exponential backoff up to `MAX_INIT_ATTEMPTS` total attempts
   * before giving up with a typed `VectorIndexInitError`.
   *
   * Successful embeddings are cached in a session-scoped 256-entry LRU
   * (Requirement 6.3); subsequent calls with the same query string
   * return the cached vector and bump the entry to most-recently-used
   * without invoking the transformer.
   *
   * Subsequent calls after init exhaustion fail synchronously with the
   * same typed error and never re-invoke the pipeline loader.
   */
  public async generateEmbedding(text: string): Promise<number[]> {
    // Cache lookup happens before init: a hit short-circuits the
    // pipeline entirely, which is the whole point of the LRU.
    const cached = this.queryCache.get(text);
    if (cached !== undefined) {
      // Promote to MRU position. Map iteration order is insertion order,
      // so re-inserting moves the key to the tail.
      this.queryCache.delete(text);
      this.queryCache.set(text, cached);
      this.cacheHits += 1;
      // Return a defensive copy so a downstream `vector.fill()` cannot
      // mutate the cached array. The cost (one Float32-sized allocation)
      // is negligible compared to a transformer pass.
      return cached.slice();
    }
    this.cacheMisses += 1;

    while (!this.extractor) {
      if (this.initAttemptCount >= MAX_INIT_ATTEMPTS) {
        throw new VectorIndexInitError(this.initAttemptCount);
      }
      try {
        await this.initialize();
      } catch (error) {
        if (this.initAttemptCount >= MAX_INIT_ATTEMPTS) {
          // Surface a typed error on the final exhausted attempt. If
          // `initialize` already threw a `VectorIndexInitError`, rethrow
          // it; otherwise wrap.
          if (error instanceof VectorIndexInitError) throw error;
          throw new VectorIndexInitError(this.initAttemptCount, error);
        }
        // Otherwise loop: the next `initialize` call applies the next
        // backoff and tries again.
      }
    }

    // The pipeline returns a tensor; extract the array data and convert
    // to a plain `number[]` for backward-compatible API shape.
    const output = await this.extractor(text, {
      pooling: 'mean',
      normalize: true,
    });
    const vector = Array.from(output.data);

    // Store a defensive copy so a downstream `vector.fill()` on the
    // returned array cannot poison the cache. Returning the original
    // reference keeps the public contract (`Promise<number[]>`) cheap
    // for the common case where the caller only reads.
    this.cachePut(text, vector.slice());
    return vector;
  }

  public calculateCosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // ----- Query-embedding LRU (Requirement 6.3) -------------------------

  /**
   * Insert a freshly-computed embedding into the LRU, evicting the
   * least-recently-used entry if the cache is at capacity. Encapsulated
   * here (not inlined into `generateEmbedding`) so unit tests can
   * exercise the eviction policy without driving the transformer.
   */
  private cachePut(text: string, vector: number[]): void {
    if (this.queryCacheCapacity <= 0) return;

    if (this.queryCache.size >= this.queryCacheCapacity) {
      // `keys().next().value` is the oldest key by insertion order;
      // dropping it implements the LRU eviction.
      const oldest = this.queryCache.keys().next().value;
      if (oldest !== undefined) this.queryCache.delete(oldest);
    }

    this.queryCache.set(text, vector);
  }

  /**
   * Drop every cached query embedding. Called when:
   *   - The embedding model is switched (automatically by
   *     {@link setModelId}, Requirement 6.3).
   *   - A document is removed from the Knowledge_Base, since search
   *     results referencing that document are now stale
   *     (Requirement 6.7, wired up in task 5.3).
   */
  public invalidateQueryCache(): void {
    this.queryCache.clear();
  }

  /**
   * Switch the active embedding model. If the new id differs from the
   * previous one, the LRU is cleared and the loaded extractor is
   * discarded so the next `generateEmbedding` reloads against the new
   * model. The init counter is reset so the retry budget restarts
   * cleanly for the new model.
   */
  public setModelId(modelId: string): void {
    if (modelId === this.modelId) return;
    this.modelId = modelId;
    this.invalidateQueryCache();
    this.extractor = null;
    this.inFlightInit = null;
    this.initAttemptCount = 0;
  }

  /**
   * Return the active embedding model id. Useful for telemetry and for
   * downstream callers that need to record which model produced a
   * particular embedding.
   */
  public getModelId(): string {
    return this.modelId;
  }

  /**
   * Return current LRU statistics. The shape mirrors what
   * Telemetry_Module expects under the `embedding.cache` event family.
   */
  public getCacheStats(): {
    size: number;
    capacity: number;
    hits: number;
    misses: number;
  } {
    return {
      size: this.queryCache.size,
      capacity: this.queryCacheCapacity,
      hits: this.cacheHits,
      misses: this.cacheMisses,
    };
  }

  // ----- Storage-side quantization (Requirement 6.4) -------------------

  /**
   * Decide how to persist a chunk vector based on the existing stored
   * count. Returns the original `number[]` when below the threshold and
   * an int8-quantized form otherwise.
   *
   * Pure: no side effects, no module state read or written. The caller
   * (`database.addDocument`) supplies the current stored-chunk count.
   *
   * @param vector - the freshly-computed Float32 embedding for a chunk
   * @param currentStoredCount - total chunks already persisted in the
   *   Knowledge_Base across all documents (excluding `vector` itself)
   */
  public quantizeForStorage(
    vector: number[],
    currentStoredCount: number,
  ): ChunkVectorForStorage {
    if (currentStoredCount < this.quantizationThreshold) {
      return { kind: 'raw', vector };
    }
    const f32 = new Float32Array(vector);
    return { kind: 'quantized', vectorQ: quantize(f32) };
  }

  /**
   * Inverse of {@link quantizeForStorage} for the search path. Decodes
   * a stored chunk back to a `number[]` regardless of which form it was
   * persisted in. Defined here (rather than re-imported by every
   * consumer) so the search call-sites in `database.ts` stay
   * single-line and the encoding policy lives in one module.
   */
  public dequantizeFromStorage(stored: ChunkVectorForStorage): number[] {
    if (stored.kind === 'raw') return stored.vector;
    return Array.from(dequantize(stored.vectorQ));
  }
}

/** Singleton used across the app. */
export const vectorStore = new VectorStore();
