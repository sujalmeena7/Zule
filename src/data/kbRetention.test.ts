// ============================================
// Zule AI — Knowledge_Base retention helper tests
// ============================================
//
// Unit + property coverage for `applyKBRetention` / `enforceKBRetention`.
// The pure helper is exercised via small example inputs first; Property
// 19 then validates the algebra over arbitrary inputs (Requirement 6.6).

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { IDBFactory } from 'fake-indexeddb';

import {
  applyKBRetention,
  diffKBRetention,
  totalChunkCount,
  DEFAULT_KB_RETENTION_CAP,
  KB_AUTO_EVICTABLE_TYPES,
} from './kbRetention';
import {
  database,
  __resetDatabaseForTests,
  type KBChunk,
  type KBDocument,
} from './database';

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

const ALL_TYPES = [
  'resume',
  'project',
  'job-description',
  'notes',
  'sales-script',
  'custom',
] as const satisfies readonly KBDocument['type'][];

function makeChunks(count: number): KBChunk[] {
  return Array.from({ length: count }, (_, i) => ({
    text: `chunk-${i}`,
    vector: [0.1 * (i + 1)],
  }));
}

function makeDoc(
  id: string,
  type: KBDocument['type'],
  chunkCount: number,
  createdAt: number,
): KBDocument {
  return {
    id,
    title: id,
    content: `${id}-content`,
    type,
    chunks: makeChunks(chunkCount),
    createdAt,
  };
}

function resetIndexedDB(): void {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  __resetDatabaseForTests();
}

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

describe('kbRetention — exported constants', () => {
  it('exposes the canonical 2 000-chunk cap from Requirement 6.6', () => {
    expect(DEFAULT_KB_RETENTION_CAP).toBe(2000);
  });

  it('lists `notes` and `sales-script` as auto-evictable types', () => {
    expect(KB_AUTO_EVICTABLE_TYPES.has('notes')).toBe(true);
    expect(KB_AUTO_EVICTABLE_TYPES.has('sales-script')).toBe(true);
    expect(KB_AUTO_EVICTABLE_TYPES.has('resume')).toBe(false);
    expect(KB_AUTO_EVICTABLE_TYPES.has('project')).toBe(false);
    expect(KB_AUTO_EVICTABLE_TYPES.has('job-description')).toBe(false);
    expect(KB_AUTO_EVICTABLE_TYPES.has('custom')).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Unit — applyKBRetention
// ---------------------------------------------------------------------

describe('applyKBRetention', () => {
  it('returns the input unchanged when total chunks <= cap', () => {
    const docs = [
      makeDoc('a', 'resume', 3, 100),
      makeDoc('b', 'notes', 2, 200),
    ];
    const out = applyKBRetention(docs, 10);
    expect(out).toEqual(docs);
    expect(totalChunkCount(out)).toBe(5);
  });

  it('evicts oldest auto-evictable docs first (notes / sales-script)', () => {
    const docs = [
      makeDoc('resume-1', 'resume', 3, 100),
      makeDoc('notes-old', 'notes', 4, 200),
      makeDoc('script-old', 'sales-script', 2, 300),
      makeDoc('notes-new', 'notes', 4, 400),
      makeDoc('project', 'project', 2, 500),
    ];

    // Total = 15, cap = 10 → must evict ≥ 5 chunks. The oldest
    // auto-evictable doc has 4 chunks (notes-old at t=200), still 1
    // short of the budget — the next oldest auto-evictable is
    // `script-old` (2 chunks). Evicting both yields 9 chunks ≤ 10.
    const out = applyKBRetention(docs, 10);
    expect(out.map((d) => d.id)).toEqual([
      'resume-1',
      'notes-new',
      'project',
    ]);
    expect(totalChunkCount(out)).toBeLessThanOrEqual(10);
  });

  it('falls back to evicting protected docs by createdAt asc when auto-evictable is exhausted', () => {
    const docs = [
      makeDoc('resume-old', 'resume', 5, 100),
      makeDoc('project-mid', 'project', 5, 200),
      makeDoc('custom-new', 'custom', 5, 300),
    ];
    // Total = 15, cap = 7. No auto-evictable docs at all, so the
    // function must evict the oldest protected docs in order:
    // `resume-old` (5 chunks → 10 left) then `project-mid`
    // (5 chunks → 5 left). After both, cap is satisfied.
    const out = applyKBRetention(docs, 7);
    expect(out.map((d) => d.id)).toEqual(['custom-new']);
    expect(totalChunkCount(out)).toBeLessThanOrEqual(7);
  });

  it('combines both passes when auto-evictable cannot reach the cap alone', () => {
    const docs = [
      makeDoc('notes-old', 'notes', 2, 100),
      makeDoc('resume-mid', 'resume', 8, 200),
      makeDoc('project-new', 'project', 5, 300),
    ];
    // Total = 15, cap = 4. Auto-evictable contributes 2 chunks
    // (notes-old). Still 9 over cap → evict resume-mid (8 chunks),
    // total now 5. Still 1 over → evict project-new (5 chunks),
    // total 0. Result is empty.
    const out = applyKBRetention(docs, 4);
    expect(out).toEqual([]);
  });

  it('preserves the original document order in the output', () => {
    const docs = [
      makeDoc('a', 'resume', 1, 100),
      makeDoc('b', 'notes', 5, 200),
      makeDoc('c', 'resume', 1, 300),
      makeDoc('d', 'notes', 5, 400),
      makeDoc('e', 'project', 1, 500),
    ];
    // Total = 13, cap = 5. Auto-evictable: b (5) and d (5), oldest
    // first. Evicting b brings total to 8, still over cap. Evicting d
    // too brings total to 3 ≤ 5. The remaining order is [a, c, e],
    // which mirrors the input's relative positions.
    const out = applyKBRetention(docs, 5);
    expect(out.map((d) => d.id)).toEqual(['a', 'c', 'e']);
  });

  it('handles cap = 0 by evicting every document', () => {
    const docs = [
      makeDoc('a', 'resume', 1, 100),
      makeDoc('b', 'notes', 1, 200),
    ];
    expect(applyKBRetention(docs, 0)).toEqual([]);
  });

  it('treats non-finite or negative caps as 0', () => {
    const docs = [makeDoc('a', 'resume', 1, 100)];
    expect(applyKBRetention(docs, -5)).toEqual([]);
    expect(applyKBRetention(docs, NaN)).toEqual([]);
    expect(applyKBRetention(docs, Infinity)).toEqual(docs);
  });

  it('does not mutate the input array or its document objects', () => {
    const docs = [
      makeDoc('a', 'notes', 5, 100),
      makeDoc('b', 'resume', 5, 200),
    ];
    const snapshotIds = docs.map((d) => d.id);
    const snapshotChunks = docs.map((d) => d.chunks.length);

    applyKBRetention(docs, 1);

    expect(docs.map((d) => d.id)).toEqual(snapshotIds);
    expect(docs.map((d) => d.chunks.length)).toEqual(snapshotChunks);
  });

  it('returns a new array instance even on the no-eviction fast path', () => {
    const docs = [makeDoc('a', 'resume', 1, 100)];
    const out = applyKBRetention(docs, 100);
    expect(out).not.toBe(docs);
    expect(out).toEqual(docs);
  });
});

// ---------------------------------------------------------------------
// Unit — diffKBRetention
// ---------------------------------------------------------------------

describe('diffKBRetention', () => {
  it('lists every id present in `before` but absent from `after`', () => {
    const before = [
      makeDoc('a', 'notes', 1, 100),
      makeDoc('b', 'resume', 1, 200),
      makeDoc('c', 'notes', 1, 300),
    ];
    const after = [before[1]];
    expect(diffKBRetention(before, after).evictedIds.sort()).toEqual([
      'a',
      'c',
    ]);
  });

  it('returns an empty list when before === after', () => {
    const before = [makeDoc('a', 'notes', 1, 100)];
    expect(diffKBRetention(before, before).evictedIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// Property 19 — Knowledge_Base retention cap is preserved under insertion
// Validates: Requirements 6.6
// ---------------------------------------------------------------------
//
// Statement: For arbitrary documents and an arbitrary cap, the result
// of `applyKBRetention` satisfies:
//
//   1. If the input total chunk count is `≤ cap`, the result equals
//      the input (modulo array identity).
//   2. Otherwise, the result's total chunk count is `≤ cap`, *unless*
//      the input is exhausted (every document was evicted, total = 0).
//   3. Among all evicted documents, every auto-evictable document
//      that is older than every retained auto-evictable document was
//      removed before any protected document. Equivalently: if any
//      protected document is in the eviction set, then every
//      auto-evictable document with a `createdAt` strictly less than
//      the protected document's `createdAt` is also evicted.
//   4. Document order in the output matches the input's relative
//      positions for retained documents.

describe('applyKBRetention — Property 19: retention cap and eviction order', () => {
  it(
    'respects the cap, evicts auto-evictable docs first, and preserves order',
    () => {
      const arbDoc: fc.Arbitrary<KBDocument> = fc
        .record({
          id: fc.uuid(),
          type: fc.constantFrom(...ALL_TYPES),
          chunkCount: fc.integer({ min: 0, max: 8 }),
          createdAt: fc.integer({ min: 0, max: 10_000 }),
        })
        .map(({ id, type, chunkCount, createdAt }) =>
          makeDoc(id, type, chunkCount, createdAt),
        );

      const arbDocs = fc.uniqueArray(arbDoc, {
        maxLength: 12,
        selector: (d) => d.id,
      });

      const arbCap = fc.integer({ min: 0, max: 60 });

      fc.assert(
        fc.property(arbDocs, arbCap, (docs, cap) => {
          const out = applyKBRetention(docs, cap);
          const totalIn = totalChunkCount(docs);
          const totalOut = totalChunkCount(out);

          // (1) No eviction needed → input passes through.
          if (totalIn <= cap) {
            expect(out.map((d) => d.id)).toEqual(docs.map((d) => d.id));
            return;
          }

          // (2) After eviction the cap holds, unless the helper had to
          // evict every document. With cap ≥ 0 and chunk counts ≥ 0
          // the result chunk count never exceeds the cap because the
          // algorithm continues evicting whole documents until it fits
          // or runs out of documents.
          if (out.length > 0) {
            expect(totalOut).toBeLessThanOrEqual(cap);
          }

          // (4) Preserves input order.
          const inputIndexById = new Map<string, number>();
          docs.forEach((d, i) => inputIndexById.set(d.id, i));
          const outIndices = out.map((d) => inputIndexById.get(d.id)!);
          for (let i = 1; i < outIndices.length; i++) {
            expect(outIndices[i - 1]).toBeLessThan(outIndices[i]);
          }

          // (3) Eviction-order invariant.
          const keptIds = new Set(out.map((d) => d.id));
          const evicted = docs.filter((d) => !keptIds.has(d.id));
          const evictedAutoEvictable = evicted.filter((d) =>
            KB_AUTO_EVICTABLE_TYPES.has(d.type),
          );
          const evictedProtected = evicted.filter(
            (d) => !KB_AUTO_EVICTABLE_TYPES.has(d.type),
          );
          const remainingAutoEvictable = out.filter((d) =>
            KB_AUTO_EVICTABLE_TYPES.has(d.type),
          );

          // Cross-cohort invariant. The implementation only enters its
          // second eviction pass once the auto-evictable cohort is
          // exhausted; therefore if *any* protected document was
          // evicted, *every* auto-evictable document must also have
          // been evicted. This is the strongest expression of
          // "auto-evictable goes first" the algorithm makes.
          if (evictedProtected.length > 0) {
            expect(remainingAutoEvictable.length).toBe(0);
          }

          // Auto-evictable cohort eviction order: the algorithm walks
          // auto-evictable docs in (createdAt, id) ascending order and
          // evicts a prefix of that sequence. Equivalently: once a
          // retained auto-evictable doc is seen, no subsequent
          // (younger) auto-evictable doc may be evicted.
          const autoEvictableInput = docs.filter((d) =>
            KB_AUTO_EVICTABLE_TYPES.has(d.type),
          );
          const sortByAge = (a: KBDocument, b: KBDocument): number => {
            if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
          };
          const sortedAE = [...autoEvictableInput].sort(sortByAge);
          let sawRetainedAE = false;
          for (const ae of sortedAE) {
            if (keptIds.has(ae.id)) {
              sawRetainedAE = true;
            } else if (sawRetainedAE) {
              throw new Error(
                `auto-evictable ${ae.id} (t=${ae.createdAt}) was evicted after a younger auto-evictable was retained`,
              );
            }
          }

          // Sanity: count partitions add up.
          expect(
            evictedAutoEvictable.length + evictedProtected.length,
          ).toBe(evicted.length);
        }),
        { numRuns: 200 },
      );
    },
  );
});

// ---------------------------------------------------------------------
// `database.enforceKBRetention` end-to-end
// ---------------------------------------------------------------------

// The end-to-end path exercises IndexedDB through fake-indexeddb and
// also confirms that the query cache is invalidated post-eviction
// (Requirement 6.7 wiring).

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

function makeFakeExtractor(values: number[]) {
  return vi.fn(async () => ({ data: new Float32Array(values) }));
}

describe('database.enforceKBRetention — end-to-end', () => {
  beforeEach(() => {
    resetIndexedDB();
    pipelineMock.mockReset();
  });

  afterEach(() => {
    pipelineMock.mockReset();
  });

  it('returns zero counts when the KB is below the cap', async () => {
    await database.addDocument('a', 'a', 'resume', [
      { text: 't', vector: [1] },
    ]);
    const out = await database.enforceKBRetention(100);
    expect(out).toEqual({ evictedDocuments: 0, evictedChunks: 0 });
    expect((await database.getAllDocuments()).map((d) => d.id).length).toBe(1);
  });

  it('evicts oldest notes / sales-script docs first when over cap', async () => {
    // Insert documents with controlled createdAt by sleeping briefly
    // between calls — `addDocument` stamps `createdAt = Date.now()`.
    const a = await database.addDocument('keep-1', 'a', 'resume', [
      { text: 'r1', vector: [1] },
      { text: 'r2', vector: [1] },
    ]);
    await new Promise((r) => setTimeout(r, 1));
    const b = await database.addDocument('drop-1', 'b', 'notes', [
      { text: 'n1', vector: [1] },
      { text: 'n2', vector: [1] },
      { text: 'n3', vector: [1] },
    ]);
    await new Promise((r) => setTimeout(r, 1));
    const c = await database.addDocument('keep-2', 'c', 'project', [
      { text: 'p1', vector: [1] },
    ]);

    // Sanity: make sure at least one millisecond elapsed between the
    // first and last writes — otherwise the test below depends on the
    // tie-break which would still hold but the test would be confusing.
    expect(a.createdAt).toBeLessThanOrEqual(b.createdAt);
    expect(b.createdAt).toBeLessThanOrEqual(c.createdAt);

    // Total = 6, cap = 4. The notes doc (3 chunks) must be evicted
    // before any of the protected docs.
    const out = await database.enforceKBRetention(4);
    expect(out.evictedDocuments).toBe(1);
    expect(out.evictedChunks).toBe(3);

    const remaining = (await database.getAllDocuments()).map((d) => d.id).sort();
    expect(remaining).toEqual([a.id, c.id].sort());
  });

  it('invalidates the query cache after eviction (Requirement 6.7)', async () => {
    pipelineMock.mockResolvedValue(makeFakeExtractor([1, 0, 0]));

    await database.addDocument('drop', 'a', 'notes', [
      { text: 'n', vector: [1, 0, 0] },
      { text: 'n2', vector: [1, 0, 0] },
      { text: 'n3', vector: [1, 0, 0] },
    ]);

    // Populate the LRU.
    await database.search('q1');
    await database.search('q2');
    const { vectorStore } = await import('../brain/vectorStore');
    expect(vectorStore.getCacheStats().size).toBeGreaterThan(0);

    // Cap = 1 forces eviction of the only document we added.
    const out = await database.enforceKBRetention(1);
    expect(out.evictedDocuments).toBe(1);
    expect(vectorStore.getCacheStats().size).toBe(0);
  });
});
