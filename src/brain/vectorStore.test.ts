// Unit tests for the deferred-promise initialization and retry-with-backoff
// behaviour added in task 5.1.
//
// These tests cover the constructive guarantees behind:
//   - Requirement 6.1 — `new Promise(async ...)` anti-pattern is removed
//   - Requirement 6.2 — init retries with exponential backoff (250 ms,
//     500 ms, 1 000 ms) up to `MAX_INIT_ATTEMPTS` attempts and then
//     fails subsequent calls with a typed `VectorIndexInitError`.
//
// The `@huggingface/transformers` `pipeline` factory is mocked so the test
// suite can deterministically simulate transient and persistent
// failures without loading a real model.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Hoisted-safe mock: declare the spy via `vi.hoisted` so the factory in
// `vi.mock` can reach it.
const pipelineMock = vi.hoisted(() => vi.fn());

vi.mock('@huggingface/transformers', () => ({
  env: {
    allowLocalModels: false,
    allowRemoteModels: true,
    useBrowserCache: true,
    localModelPath: '',
    backends: { onnx: { wasm: {} } },
  },
  pipeline: pipelineMock,
}));

import {
  VectorStore,
  VectorIndexInitError,
  MAX_INIT_ATTEMPTS,
  INIT_BACKOFF_MS,
} from './vectorStore';

// ---- helpers ---------------------------------------------------------

/**
 * Builds a fake "extractor" callable that mimics the Transformers.js
 * pipeline output shape: `(text, opts) => Promise<{ data: ArrayLike }>`.
 */
function makeFakeExtractor(values: number[] = [0.1, 0.2, 0.3]) {
  return vi.fn(async () => ({ data: new Float32Array(values) }));
}

// Resolve the path to vectorStore.ts for the regex regression test.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const vectorStoreSourcePath = resolve(__dirname, 'vectorStore.ts');

// ---- 6.1: deferred-promise pattern ----------------------------------

describe('VectorStore — deferred-promise initialization (Requirement 6.1)', () => {
  beforeEach(() => {
    pipelineMock.mockReset();
  });

  it('source code does not pass an async function to `new Promise`', () => {
    // Static regression guard: any future change that re-introduces the
    // `new Promise(async ...)` anti-pattern fails this test.
    const source = readFileSync(vectorStoreSourcePath, 'utf-8');
    expect(source).not.toMatch(/new\s+Promise\s*\(\s*async\b/);
  });

  it('initialize resolves once the pipeline loads', async () => {
    pipelineMock.mockResolvedValueOnce(makeFakeExtractor());
    const store = new VectorStore();
    await expect(store.initialize()).resolves.toBeUndefined();
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it('returns the same in-flight promise to concurrent callers', async () => {
    let resolveLoader!: (value: unknown) => void;
    pipelineMock.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveLoader = res;
        }),
    );
    const store = new VectorStore();
    const p1 = store.initialize();
    const p2 = store.initialize();
    expect(p1).toBe(p2);
    resolveLoader(makeFakeExtractor());
    await expect(p1).resolves.toBeUndefined();
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it('returns an immediately-resolved promise once init has succeeded', async () => {
    pipelineMock.mockResolvedValueOnce(makeFakeExtractor());
    const store = new VectorStore();
    await store.initialize();
    pipelineMock.mockClear();
    await expect(store.initialize()).resolves.toBeUndefined();
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it('rejects the deferred with the underlying error on first failure', async () => {
    pipelineMock.mockRejectedValueOnce(new Error('boom'));
    const store = new VectorStore();
    await expect(store.initialize()).rejects.toThrow(/boom/);
  });
});

// ---- 6.2: retry with exponential backoff -----------------------------

describe('VectorStore — init retry with exponential backoff (Requirement 6.2)', () => {
  beforeEach(() => {
    pipelineMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries up to MAX_INIT_ATTEMPTS via the next generateEmbedding call', async () => {
    pipelineMock
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockRejectedValueOnce(new Error('fail-2'))
      .mockResolvedValueOnce(makeFakeExtractor([1, 2, 3]));

    const store = new VectorStore();
    const promise = store.generateEmbedding('hello');

    // Drain timers and microtasks until the embedding settles.
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual([1, 2, 3]);
    expect(pipelineMock).toHaveBeenCalledTimes(MAX_INIT_ATTEMPTS);
  });

  it('throws VectorIndexInitError after every attempt fails', async () => {
    pipelineMock.mockRejectedValue(new Error('persistent'));
    const store = new VectorStore();

    const promise = store.generateEmbedding('hello').catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const error = await promise;

    expect(error).toBeInstanceOf(VectorIndexInitError);
    const initError = error as VectorIndexInitError;
    expect(initError.kind).toBe('vector-index.init-failed');
    expect(initError.attempts).toBe(MAX_INIT_ATTEMPTS);
    expect(initError.cause).toBeInstanceOf(Error);
    expect(pipelineMock).toHaveBeenCalledTimes(MAX_INIT_ATTEMPTS);
  });

  it('subsequent generateEmbedding calls fail fast after exhaustion', async () => {
    pipelineMock.mockRejectedValue(new Error('persistent'));
    const store = new VectorStore();

    const first = store.generateEmbedding('a').catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await first).toBeInstanceOf(VectorIndexInitError);

    pipelineMock.mockClear();

    const second = store.generateEmbedding('b').catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await second).toBeInstanceOf(VectorIndexInitError);
    // Critically: no further pipeline-load attempts are made.
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it('initialize rejects synchronously after exhaustion', async () => {
    pipelineMock.mockRejectedValue(new Error('persistent'));
    const store = new VectorStore();

    const ex = store.generateEmbedding('a').catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await ex).toBeInstanceOf(VectorIndexInitError);

    pipelineMock.mockClear();
    await expect(store.initialize()).rejects.toBeInstanceOf(
      VectorIndexInitError,
    );
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it('observes the 250 ms backoff between attempt 1 and attempt 2', async () => {
    pipelineMock
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockResolvedValueOnce(makeFakeExtractor());

    const store = new VectorStore();
    const promise = store.generateEmbedding('x');

    // Resolve the first attempt's microtasks but stay below the
    // 250 ms threshold — the second attempt must not have fired yet.
    await vi.advanceTimersByTimeAsync(0);
    expect(pipelineMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(249);
    expect(pipelineMock).toHaveBeenCalledTimes(1);

    // Cross the 250 ms threshold — the second attempt fires.
    await vi.advanceTimersByTimeAsync(2);
    await promise;
    expect(pipelineMock).toHaveBeenCalledTimes(2);
  });

  it('observes the 500 ms backoff between attempt 2 and attempt 3', async () => {
    pipelineMock
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockRejectedValueOnce(new Error('fail-2'))
      .mockResolvedValueOnce(makeFakeExtractor());

    const store = new VectorStore();
    const promise = store.generateEmbedding('x');

    // Drive past the first backoff to land at the start of attempt 3's
    // backoff window. After this, only attempts 1 and 2 have run.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(pipelineMock).toHaveBeenCalledTimes(2);

    // Stay just below 500 ms — attempt 3 must not have fired yet.
    await vi.advanceTimersByTimeAsync(499);
    expect(pipelineMock).toHaveBeenCalledTimes(2);

    // Cross 500 ms — attempt 3 fires.
    await vi.advanceTimersByTimeAsync(2);
    await promise;
    expect(pipelineMock).toHaveBeenCalledTimes(3);
  });

  it('exposes the (250, 500, 1000) ms canonical backoff series', () => {
    expect(INIT_BACKOFF_MS).toEqual([250, 500, 1000]);
  });

  it('recovers cleanly when a transient failure precedes a success', async () => {
    pipelineMock
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(makeFakeExtractor([7, 8, 9]));

    const store = new VectorStore();
    // Trigger init eagerly first; it should fail.
    await expect(store.initialize()).rejects.toThrow(/transient/);

    // Next generateEmbedding triggers retry attempt 2 with 250 ms backoff.
    const result = store.generateEmbedding('hello');
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual([7, 8, 9]);
  });

  it('does not retry when init has already succeeded', async () => {
    pipelineMock.mockResolvedValueOnce(makeFakeExtractor([1]));
    const store = new VectorStore();
    await store.initialize();

    pipelineMock.mockClear();
    const a = store.generateEmbedding('a');
    const b = store.generateEmbedding('b');
    await vi.runAllTimersAsync();
    await Promise.all([a, b]);
    // The pipeline loader is the `pipeline()` factory; once init is
    // complete, the loader is not invoked again, even across many
    // generateEmbedding calls.
    expect(pipelineMock).not.toHaveBeenCalled();
  });
});

// ---- VectorIndexInitError surface ------------------------------------

describe('VectorIndexInitError', () => {
  it('carries the canonical `vector-index.init-failed` discriminator', () => {
    const err = new VectorIndexInitError(3, new Error('underlying'));
    expect(err.kind).toBe('vector-index.init-failed');
    expect(err.attempts).toBe(3);
    expect(err.cause).toBeInstanceOf(Error);
    expect(err.toZuleError()).toEqual({
      kind: 'vector-index.init-failed',
      attempts: 3,
    });
  });

  it('produces a singular message for a single attempt and plural otherwise', () => {
    expect(new VectorIndexInitError(1).message).toMatch(/1 attempt$/);
    expect(new VectorIndexInitError(3).message).toMatch(/3 attempts$/);
  });

  it('omits the optional cause when not supplied', () => {
    const err = new VectorIndexInitError(3);
    expect(err.cause).toBeUndefined();
  });
});


// ====================================================================
// 6.3: session-scoped query-embedding LRU (task 5.2)
// ====================================================================

import {
  DEFAULT_EMBEDDING_MODEL,
  QUERY_CACHE_CAPACITY,
  QUANTIZATION_THRESHOLD,
} from './vectorStore';
import { dequantize } from './vectorMath';

describe('VectorStore — query-embedding LRU (Requirement 6.3)', () => {
  beforeEach(() => {
    pipelineMock.mockReset();
  });

  it('exposes the canonical 256-entry LRU capacity', () => {
    expect(QUERY_CACHE_CAPACITY).toBe(256);
  });

  it('caches the embedding for a previously-seen query string', async () => {
    const extractor = makeFakeExtractor([0.5, 0.5, 0.5]);
    pipelineMock.mockResolvedValueOnce(extractor);

    const store = new VectorStore();
    const a = await store.generateEmbedding('hello');
    const b = await store.generateEmbedding('hello');

    expect(a).toEqual([0.5, 0.5, 0.5]);
    expect(b).toEqual([0.5, 0.5, 0.5]);
    // Hit short-circuits the transformer entirely.
    expect(extractor).toHaveBeenCalledTimes(1);
    const stats = store.getCacheStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.size).toBe(1);
  });

  it('returns a defensive copy so callers cannot mutate the cached vector', async () => {
    const extractor = makeFakeExtractor([1, 2, 3]);
    pipelineMock.mockResolvedValueOnce(extractor);

    const store = new VectorStore();
    const first = await store.generateEmbedding('hello');
    first[0] = 999; // mutate the returned array

    const second = await store.generateEmbedding('hello');
    expect(second).toEqual([1, 2, 3]); // cache is intact
  });

  it('evicts the least-recently-used entry when capacity is exceeded', async () => {
    pipelineMock.mockResolvedValue(makeFakeExtractor([0.1]));

    const store = new VectorStore({ queryCacheCapacity: 3 });
    await store.generateEmbedding('a');
    await store.generateEmbedding('b');
    await store.generateEmbedding('c');

    expect(store.getCacheStats().size).toBe(3);

    // Insert a 4th entry — 'a' is the oldest and must be evicted.
    await store.generateEmbedding('d');
    expect(store.getCacheStats().size).toBe(3);

    // Hits stay hits; the evicted key is recomputed.
    pipelineMock.mockClear();
    await store.generateEmbedding('b');
    await store.generateEmbedding('c');
    await store.generateEmbedding('d');
    // 'a' must miss and be regenerated.
    await store.generateEmbedding('a');

    // The hit / miss counters tell the story without poking inside the
    // mocked transformer: 'b', 'c', 'd' served from cache (3 hits),
    // 'a' regenerated (one extra miss on top of the original 4).
    const stats = store.getCacheStats();
    expect(stats.hits).toBe(3);
    expect(stats.misses).toBe(5);
  });

  it('promotes a hit to MRU so it survives subsequent evictions', async () => {
    pipelineMock.mockResolvedValue(makeFakeExtractor([0.1]));

    const store = new VectorStore({ queryCacheCapacity: 3 });
    await store.generateEmbedding('a');
    await store.generateEmbedding('b');
    await store.generateEmbedding('c');

    // Touch 'a' → moves it to MRU. Now LRU order is b → c → a.
    await store.generateEmbedding('a');

    // Add 'd' — 'b' should evict, not 'a'.
    await store.generateEmbedding('d');

    pipelineMock.mockClear();
    // 'a' must still be a hit.
    const before = store.getCacheStats().hits;
    await store.generateEmbedding('a');
    expect(store.getCacheStats().hits).toBe(before + 1);

    // 'b' must have been evicted.
    const beforeMiss = store.getCacheStats().misses;
    await store.generateEmbedding('b');
    expect(store.getCacheStats().misses).toBe(beforeMiss + 1);
  });

  it('invalidateQueryCache drops every entry without affecting init', async () => {
    pipelineMock.mockResolvedValue(makeFakeExtractor([0.1]));

    const store = new VectorStore({ queryCacheCapacity: 5 });
    await store.generateEmbedding('a');
    await store.generateEmbedding('b');
    expect(store.getCacheStats().size).toBe(2);

    store.invalidateQueryCache();
    expect(store.getCacheStats().size).toBe(0);

    // The pipeline does not need to reload — only the LRU resets.
    pipelineMock.mockClear();
    await store.generateEmbedding('a');
    expect(pipelineMock).not.toHaveBeenCalled();
    expect(store.getCacheStats().misses).toBe(3);
  });

  it('setModelId invalidates the cache and forces a pipeline reload', async () => {
    // Use values that survive a Float32Array round-trip exactly so the
    // assertion below does not need toBeCloseTo.
    pipelineMock
      .mockResolvedValueOnce(makeFakeExtractor([0.25, 0.25, 0.25]))
      .mockResolvedValueOnce(makeFakeExtractor([0.5, 0.5, 0.5]));

    const store = new VectorStore({ queryCacheCapacity: 5 });
    await store.generateEmbedding('hello');
    expect(store.getModelId()).toBe(DEFAULT_EMBEDDING_MODEL);

    store.setModelId('Xenova/bge-small-en-v1.5');
    expect(store.getModelId()).toBe('Xenova/bge-small-en-v1.5');
    expect(store.getCacheStats().size).toBe(0);

    // Next call must reload the pipeline with the new id.
    const next = await store.generateEmbedding('hello');
    expect(next).toEqual([0.5, 0.5, 0.5]);
    expect(pipelineMock).toHaveBeenCalledTimes(2);
    expect(pipelineMock).toHaveBeenLastCalledWith(
      'feature-extraction',
      'Xenova/bge-small-en-v1.5',
      expect.anything(),
    );
  });

  it('setModelId is a no-op when the id is unchanged', async () => {
    pipelineMock.mockResolvedValueOnce(makeFakeExtractor([0.1]));

    const store = new VectorStore({ queryCacheCapacity: 5 });
    await store.generateEmbedding('hello');
    const before = store.getCacheStats().size;

    store.setModelId(DEFAULT_EMBEDDING_MODEL);
    expect(store.getCacheStats().size).toBe(before);
  });
});

// ====================================================================
// 6.4: storage-side quantization (task 5.2)
// ====================================================================

describe('VectorStore — quantizeForStorage / dequantizeFromStorage (Requirement 6.4)', () => {
  it('exposes a 1 000-chunk quantization threshold', () => {
    expect(QUANTIZATION_THRESHOLD).toBe(1000);
  });

  it('returns raw form when the existing stored count is below the threshold', () => {
    const store = new VectorStore();
    const result = store.quantizeForStorage([0.1, 0.2, 0.3], 999);
    expect(result.kind).toBe('raw');
    if (result.kind === 'raw') {
      expect(result.vector).toEqual([0.1, 0.2, 0.3]);
    }
  });

  it('quantizes once the existing stored count reaches the threshold', () => {
    const store = new VectorStore();
    const vector = [0.1, 0.4, -0.2, 0.7];
    const result = store.quantizeForStorage(vector, 1000);

    expect(result.kind).toBe('quantized');
    if (result.kind === 'quantized') {
      expect(result.vectorQ.data).toBeInstanceOf(Int8Array);
      expect(result.vectorQ.data.length).toBe(vector.length);
      // 4× storage shrink: 1 byte/component vs 4 bytes/component.
      expect(result.vectorQ.data.byteLength * 4).toBe(vector.length * 4);
    }
  });

  it('round-trips raw chunks through dequantizeFromStorage', () => {
    const store = new VectorStore();
    const vector = [0.1, -0.7, 0.4];
    const decoded = store.dequantizeFromStorage({
      kind: 'raw',
      vector,
    });
    expect(decoded).toEqual(vector);
  });

  it('round-trips quantized chunks within the per-component error bound', () => {
    const store = new VectorStore();
    const original = [0.123, -0.456, 0.789, 0.0, -0.001, 0.999];
    const stored = store.quantizeForStorage(original, 1500);
    expect(stored.kind).toBe('quantized');
    if (stored.kind !== 'quantized') return;

    const decoded = store.dequantizeFromStorage(stored);
    const min = Math.min(...original);
    const max = Math.max(...original);
    const tol = (max - min) / 254;
    expect(decoded.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(Math.abs(decoded[i] - original[i])).toBeLessThanOrEqual(tol);
    }
  });

  it('threshold is configurable for tests / Settings injection', () => {
    const store = new VectorStore({ quantizationThreshold: 4 });

    // Below threshold → raw.
    expect(store.quantizeForStorage([1, 2, 3], 3).kind).toBe('raw');
    // At or above threshold → quantized.
    expect(store.quantizeForStorage([1, 2, 3], 4).kind).toBe('quantized');
    expect(store.quantizeForStorage([1, 2, 3], 100).kind).toBe('quantized');
  });

  it('quantized output is interchangeable with vectorMath.dequantize directly', () => {
    const store = new VectorStore();
    const original = [0.1, -0.5, 0.25, 0.75];
    const stored = store.quantizeForStorage(original, 1000);
    if (stored.kind !== 'quantized') throw new Error('expected quantized');

    const viaStore = store.dequantizeFromStorage(stored);
    const viaMath = Array.from(dequantize(stored.vectorQ));
    expect(viaStore).toEqual(viaMath);
  });
});
