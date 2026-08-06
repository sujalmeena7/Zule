// ============================================
// Zule AI — Response_Cache v2 (Cosine + LRU + IndexedDB)
// ============================================
//
// Replaces the Jaccard-based in-memory-only cache with:
//   * Cosine-similarity matching via Vector_Index embeddings (Req 7.1)
//   * Least-recently-used eviction bounded at `maxEntries` (Req 7.2)
//   * IndexedDB persistence to `STORE_RESPONSE_CACHE` (Req 7.3)
//   * Rejection of invalid responses: isSimulated, empty text, non-2xx (Req 7.4)
//   * `fromCache: true` annotation and `cache.hit` telemetry (Req 7.5)
//
// Design reference: design.md §8. Response_Cache v2

import { cosineSimilarity } from './vectorMath';
import { hammingDistance } from '../utils/phash';
import { STORE_RESPONSE_CACHE } from '../data/database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The response shape stored in and returned from the cache.
 * Compatible with the legacy `AIResponse` from `aiProvider.ts` and with
 * the new `ProviderResponse` (which has `status` and `isSimulated`).
 */
export interface AIResponse {
  text: string;
  isSimulated: boolean;
  status: number;
  fromCache?: boolean;
  providerId?: string;
  modelId?: string;
}

/** Internal cache entry stored in memory and persisted to IndexedDB. */
export interface CacheEntry {
  id: string;
  query: string;
  embedding: number[];
  response: AIResponse;
  lastUsedAt: number;
  /** Perceptual hash of the frame used for screen-context entries (null for non-screen entries). */
  frameHash: Uint8Array | null;
}

/**
 * Cache key for screen-context lookups that include both query text
 * and the perceptual hash of the frame.
 */
export interface ScreenCacheKey {
  query: string;
  frameHash: Uint8Array | null;
}

export interface ResponseCacheOptions {
  /** Cosine-similarity threshold for cache hits (default 0.85). */
  similarityThreshold?: number;
  /** Maximum entries before LRU eviction (default 256). */
  maxEntries?: number;
  /** Whether to persist entries to IndexedDB (default true). */
  persist?: boolean;
  /**
   * Hamming distance threshold for frame-hash cache hits (default 10).
   * A lookup is a hit only when the Hamming distance between the stored
   * frame hash and the query frame hash is ≤ this value (out of 64 bits).
   */
  hashDistanceThreshold?: number;
  /**
   * Injected embedding function. Defaults to a dynamic import of
   * vectorStore.generateEmbedding to avoid circular dependencies.
   */
  generateEmbedding?: (text: string) => Promise<number[]>;
  /**
   * Injected telemetry emit function. Placeholder for wiring to
   * TelemetryModule in a later task.
   */
  emitTelemetry?: (event: { kind: string; similarity?: number }) => void;
}

// ---------------------------------------------------------------------------
// ResponseCache class
// ---------------------------------------------------------------------------

export class ResponseCache {
  private readonly similarityThreshold: number;
  private readonly hashDistanceThreshold: number;
  private readonly maxEntries: number;
  private readonly persistEnabled: boolean;
  private readonly generateEmbedding: (text: string) => Promise<number[]>;
  private readonly emitTelemetry: (event: { kind: string; similarity?: number }) => void;

  /**
   * In-memory LRU cache. Ordered by insertion/access — the *first*
   * entry is the least-recently-used (Map preserves insertion order;
   * hits are promoted by delete + re-set).
   */
  private entries: Map<string, CacheEntry> = new Map();

  private loaded = false;

  constructor(opts: ResponseCacheOptions = {}) {
    this.similarityThreshold = opts.similarityThreshold ?? 0.85;
    this.hashDistanceThreshold = opts.hashDistanceThreshold ?? 10;
    this.maxEntries = opts.maxEntries ?? 256;
    this.persistEnabled = opts.persist ?? true;
    this.generateEmbedding = opts.generateEmbedding ?? defaultGenerateEmbedding;
    this.emitTelemetry = opts.emitTelemetry ?? (() => {});
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Look up a cached response for `query` by cosine similarity.
   * Returns the best match above `similarityThreshold` or `null`.
   */
  async get(query: string): Promise<{ hit: AIResponse | null; similarity: number }> {
    await this.ensureLoaded();

    if (this.entries.size === 0) {
      return { hit: null, similarity: 0 };
    }

    const queryEmbedding = await this.generateEmbedding(query);
    const queryVec = new Float32Array(queryEmbedding);

    let bestEntry: CacheEntry | null = null;
    let bestSimilarity = 0;

    for (const entry of this.entries.values()) {
      const entryVec = new Float32Array(entry.embedding);
      const sim = cosineSimilarity(queryVec, entryVec);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestEntry = entry;
      }
    }

    if (bestEntry && bestSimilarity >= this.similarityThreshold) {
      // Promote to MRU
      this.entries.delete(bestEntry.id);
      bestEntry.lastUsedAt = Date.now();
      this.entries.set(bestEntry.id, bestEntry);

      // Persist the updated lastUsedAt
      if (this.persistEnabled) {
        void this.persistEntry(bestEntry);
      }

      // Annotate served response with fromCache: true (Req 7.5)
      const served: AIResponse = { ...bestEntry.response, fromCache: true };

      // Emit telemetry (Req 7.5)
      this.emitTelemetry({ kind: 'cache.hit', similarity: bestSimilarity });

      return { hit: served, similarity: bestSimilarity };
    }

    return { hit: null, similarity: bestSimilarity };
  }

  /**
   * Store a response in the cache.
   * Refuses to store when:
   *   - response.isSimulated === true (Req 4.9, 7.4)
   *   - response.text.trim() === '' (Req 7.4)
   *   - response.status < 200 || response.status >= 300 (Req 7.4)
   */
  async set(query: string, response: AIResponse): Promise<void> {
    // Gate: refuse invalid entries
    if (response.isSimulated) return;
    if (!response.text || response.text.trim() === '') return;
    if (response.status < 200 || response.status >= 300) return;

    await this.ensureLoaded();

    const embedding = await this.generateEmbedding(query);
    const id = generateCacheId();
    const now = Date.now();

    const entry: CacheEntry = {
      id,
      query,
      embedding,
      response,
      lastUsedAt: now,
      frameHash: null,
    };

    // Evict LRU entries if at capacity
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
        if (this.persistEnabled) {
          void this.deletePersistedEntry(oldest);
        }
      } else {
        break;
      }
    }

    this.entries.set(id, entry);

    if (this.persistEnabled) {
      void this.persistEntry(entry);
    }
  }

  /**
   * Look up a cached response using both query similarity AND frame hash
   * Hamming distance. Returns a hit only when both thresholds are met.
   *
   * Returns a miss when:
   * - No Frame_Hash is available in the lookup key (Req 6.4)
   * - The best-matching entry was stored without a Frame_Hash (Req 6.5)
   * - The query similarity is below the configured threshold
   * - The Hamming distance exceeds the configured hash threshold (Req 6.3)
   */
  async getWithFrame(key: ScreenCacheKey): Promise<{
    hit: AIResponse | null;
    similarity: number;
    hashDistance: number;
  }> {
    await this.ensureLoaded();

    // Req 6.4: Miss when no Frame_Hash available for request
    if (!key.frameHash) {
      return { hit: null, similarity: 0, hashDistance: 64 };
    }

    if (this.entries.size === 0) {
      return { hit: null, similarity: 0, hashDistance: 64 };
    }

    const queryEmbedding = await this.generateEmbedding(key.query);
    const queryVec = new Float32Array(queryEmbedding);

    let bestEntry: CacheEntry | null = null;
    let bestSimilarity = 0;
    let bestHashDistance = 64;

    for (const entry of this.entries.values()) {
      // Req 6.5: Skip entries stored without a Frame_Hash
      if (!entry.frameHash) {
        continue;
      }

      const entryVec = new Float32Array(entry.embedding);
      const sim = cosineSimilarity(queryVec, entryVec);

      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestEntry = entry;
        bestHashDistance = hammingDistance(key.frameHash, entry.frameHash);
      }
    }

    // Both thresholds must be met for a hit (Req 6.1, 6.2)
    if (
      bestEntry &&
      bestSimilarity >= this.similarityThreshold &&
      bestHashDistance <= this.hashDistanceThreshold
    ) {
      // Promote to MRU
      this.entries.delete(bestEntry.id);
      bestEntry.lastUsedAt = Date.now();
      this.entries.set(bestEntry.id, bestEntry);

      if (this.persistEnabled) {
        void this.persistEntry(bestEntry);
      }

      const served: AIResponse = { ...bestEntry.response, fromCache: true };
      this.emitTelemetry({ kind: 'cache.hit', similarity: bestSimilarity });

      return { hit: served, similarity: bestSimilarity, hashDistance: bestHashDistance };
    }

    return { hit: null, similarity: bestSimilarity, hashDistance: bestHashDistance };
  }

  /**
   * Store a response keyed to both query embedding and frame hash.
   * Applies the same validation rules as `set` (rejects simulated,
   * empty text, non-2xx responses).
   */
  async setWithFrame(key: ScreenCacheKey, response: AIResponse): Promise<void> {
    // Gate: refuse invalid entries (same rules as `set`)
    if (response.isSimulated) return;
    if (!response.text || response.text.trim() === '') return;
    if (response.status < 200 || response.status >= 300) return;

    await this.ensureLoaded();

    const embedding = await this.generateEmbedding(key.query);
    const id = generateCacheId();
    const now = Date.now();

    const entry: CacheEntry = {
      id,
      query: key.query,
      embedding,
      response,
      lastUsedAt: now,
      frameHash: key.frameHash,
    };

    // Evict LRU entries if at capacity
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
        if (this.persistEnabled) {
          void this.deletePersistedEntry(oldest);
        }
      } else {
        break;
      }
    }

    this.entries.set(id, entry);

    if (this.persistEnabled) {
      void this.persistEntry(entry);
    }
  }

  /**
   * Clear all cache entries from memory and IndexedDB.
   */
  async clear(): Promise<void> {
    this.entries.clear();
    if (this.persistEnabled) {
      await this.clearPersistedEntries();
    }
  }

  /**
   * Drop in-memory entries. IndexedDB entries become stale;
   * next load filters them.
   */
  invalidateAll(): void {
    this.entries.clear();
    this.loaded = false;
  }

  /** Current number of in-memory entries. Useful for testing. */
  get size(): number {
    return this.entries.size;
  }

  // -------------------------------------------------------------------------
  // Persistence (IndexedDB)
  // -------------------------------------------------------------------------

  private async ensureLoaded(): Promise<void> {
    if (this.loaded || !this.persistEnabled) {
      this.loaded = true;
      return;
    }
    try {
      const db = await openCacheDB();
      const entries = await getAllCacheEntries(db);
      db.close();

      // Sort by lastUsedAt ascending so Map insertion order matches LRU order
      entries.sort((a, b) => a.lastUsedAt - b.lastUsedAt);

      // Only load up to maxEntries (take the most recent)
      const toLoad = entries.slice(-this.maxEntries);
      for (const entry of toLoad) {
        this.entries.set(entry.id, entry);
      }
    } catch {
      // If persistence fails, operate in memory-only mode
    }
    this.loaded = true;
  }

  private async persistEntry(entry: CacheEntry): Promise<void> {
    try {
      const db = await openCacheDB();
      await putCacheEntry(db, entry);
      db.close();
    } catch {
      // Non-fatal: the cache degrades to in-memory only
    }
  }

  private async deletePersistedEntry(id: string): Promise<void> {
    try {
      const db = await openCacheDB();
      await deleteCacheEntry(db, id);
      db.close();
    } catch {
      // Non-fatal
    }
  }

  private async clearPersistedEntries(): Promise<void> {
    try {
      const db = await openCacheDB();
      await clearCacheStore(db);
      db.close();
    } catch {
      // Non-fatal
    }
  }
}

// ---------------------------------------------------------------------------
// IndexedDB helpers
// ---------------------------------------------------------------------------

const DB_NAME = 'zule-unified';
const DB_VERSION = 4;

function openCacheDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    // We don't handle onupgradeneeded here because the main database.ts
    // module handles schema creation. This just opens the existing DB.
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_RESPONSE_CACHE)) {
        const store = db.createObjectStore(STORE_RESPONSE_CACHE, { keyPath: 'id' });
        store.createIndex('lastUsedAt', 'lastUsedAt', { unique: false });
      }
    };
  });
}

function getAllCacheEntries(db: IDBDatabase): Promise<CacheEntry[]> {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(STORE_RESPONSE_CACHE)) {
      resolve([]);
      return;
    }
    const tx = db.transaction(STORE_RESPONSE_CACHE, 'readonly');
    const request = tx.objectStore(STORE_RESPONSE_CACHE).getAll();
    request.onsuccess = () => resolve(request.result as CacheEntry[]);
    request.onerror = () => reject(request.error);
  });
}

function putCacheEntry(db: IDBDatabase, entry: CacheEntry): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(STORE_RESPONSE_CACHE)) {
      resolve();
      return;
    }
    const tx = db.transaction(STORE_RESPONSE_CACHE, 'readwrite');
    tx.objectStore(STORE_RESPONSE_CACHE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function deleteCacheEntry(db: IDBDatabase, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(STORE_RESPONSE_CACHE)) {
      resolve();
      return;
    }
    const tx = db.transaction(STORE_RESPONSE_CACHE, 'readwrite');
    tx.objectStore(STORE_RESPONSE_CACHE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function clearCacheStore(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(STORE_RESPONSE_CACHE)) {
      resolve();
      return;
    }
    const tx = db.transaction(STORE_RESPONSE_CACHE, 'readwrite');
    tx.objectStore(STORE_RESPONSE_CACHE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateCacheId(): string {
  return `rc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Default embedding function that dynamically imports vectorStore to
 * avoid circular dependencies. Tests inject a mock via the constructor.
 */
async function defaultGenerateEmbedding(text: string): Promise<number[]> {
  const { vectorStore } = await import('./vectorStore');
  return vectorStore.generateEmbedding(text);
}

/**
 * Default shared singleton used by the FloatingCopilot.
 * (Historically the codebase referenced `semanticCache` as a module export.)
 */
export const semanticCache = new ResponseCache();
