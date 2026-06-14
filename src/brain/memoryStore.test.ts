// ============================================
// Zule AI — Memory_Store Tests
// ============================================
//
// Unit tests and property-based tests for MemoryStore.
//
// Property 30: After adding N facts where some are semantically similar
//   (cosine > 0.92), no two stored facts have cosine similarity > 0.92.
//   The deduplication retains the longer text.
//   **Validates: Requirements 10.6**
//
// Property 31: Every fact stored via applyRedactionAndSave has
//   `source.meetingIds` containing the originating meetingId, and the
//   text field has been passed through redaction.
//   **Validates: Requirements 10.5**

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import {
  MemoryStore,
  DEFAULT_DEDUP_THRESHOLD,
  type MemoryFact,
  type MemorySource,
} from './memoryStore';
import type { RedactionRule } from '../types/redaction';
import { cosineSimilarity } from './vectorMath';

// --- Deterministic embedding helpers ---

/**
 * A deterministic embedding function that converts text into a
 * predictable vector. Uses a simple hash-based approach so that
 * similar texts produce similar embeddings for dedup testing.
 *
 * For dedup tests, we use a scheme where the embedding is derived from
 * the character codes of the text, normalized to unit length.
 */
function deterministicEmbedding(text: string): Float32Array {
  const dim = 8;
  const vec = new Float32Array(dim);
  for (let i = 0; i < text.length; i++) {
    vec[i % dim] += text.charCodeAt(i);
  }
  // Normalize to unit length
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      vec[i] /= norm;
    }
  }
  return vec;
}

/**
 * A controllable embedding function that maps specific text patterns to
 * specific vectors, allowing precise control over similarity.
 *
 * Texts starting with "group-X-" will get nearly identical embeddings
 * (cosine > 0.92) within the same group.
 *
 * Texts starting with "unique-X-" use a seeded, high-dimensional spread
 * so that distinct indices produce vectors far apart in cosine space.
 */
let uniqueCounter = 0;
const uniqueEmbeddingCache = new Map<string, Float32Array>();

function groupEmbedding(text: string): Float32Array {
  // Return cached value for consistency across repeated calls
  const cached = uniqueEmbeddingCache.get(text);
  if (cached) return new Float32Array(cached);

  const dim = 32;
  const vec = new Float32Array(dim);

  // Extract group prefix if present: "group-X-..."
  const groupMatch = text.match(/^group-(\d+)-/);
  if (groupMatch) {
    const groupId = parseInt(groupMatch[1], 10);
    // Base vector for the group — fill all dimensions with a stable pattern
    for (let i = 0; i < dim; i++) {
      vec[i] = Math.cos(groupId * 1.5 + i * 0.1) + Math.sin(groupId * 2.7 + i * 0.05);
    }

    // Add a tiny perturbation based on the suffix so different texts
    // in the same group have slightly different embeddings but still > 0.92
    const suffix = text.slice(groupMatch[0].length);
    for (let i = 0; i < suffix.length; i++) {
      vec[i % dim] += 0.001 * suffix.charCodeAt(i) / 256;
    }
  } else {
    // Non-group text: use a counter-based orthogonal approach.
    // Each unique text gets a distinct "slot" in a high-dimensional space
    // ensuring low cosine similarity between any two unique texts.
    const idx = uniqueCounter++;
    // Use a seeded pseudo-random walk that differs significantly per index
    for (let i = 0; i < dim; i++) {
      // Golden-ratio based hash for good distribution
      const hash = ((idx + 1) * 2654435761 + i * 40503) & 0xffffffff;
      vec[i] = ((hash / 0xffffffff) * 2) - 1;
    }
  }

  // Normalize to unit length
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      vec[i] /= norm;
    }
  }

  uniqueEmbeddingCache.set(text, new Float32Array(vec));
  return vec;
}

/** Simple identity redaction (no-op) for tests that don't test redaction. */
function noopRedact(text: string): string {
  return text;
}

/** A redaction function that uppercases all emails. */
function emailRedact(text: string, rules: RedactionRule[]): string {
  // Simple: replace anything that looks like an email
  return text.replace(
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    '[REDACTED:EMAIL]',
  );
}

/** Always-redact function that wraps text in a marker. */
function markerRedact(text: string): string {
  if (text.includes('[R]')) return text; // idempotent
  return `[R]${text}`;
}

function createStore(opts?: {
  embedFn?: (text: string) => Float32Array;
  redactFn?: (text: string, rules: RedactionRule[]) => string;
  dedupThreshold?: number;
}): MemoryStore {
  return new MemoryStore({
    generateEmbedding: async (text) =>
      (opts?.embedFn ?? deterministicEmbedding)(text),
    cosineSimilarity,
    redact: opts?.redactFn ?? ((text) => noopRedact(text)),
    dedupThreshold: opts?.dedupThreshold ?? DEFAULT_DEDUP_THRESHOLD,
    persist: false, // Disable IndexedDB for unit tests
  });
}

// --- Unit Tests ---

describe('MemoryStore — basic operations', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = createStore();
  });

  it('adds a fact and returns it with correct structure', async () => {
    const source: MemorySource = { meetingId: 'meeting-1', date: Date.now() };
    const fact = await store.add('The project deadline is next Friday', source);

    expect(fact).not.toBeNull();
    expect(fact!.text).toBe('The project deadline is next Friday');
    expect(fact!.embedding).toBeInstanceOf(Float32Array);
    expect(fact!.source.meetingId).toBe('meeting-1');
    expect(fact!.source.meetingIds).toContain('meeting-1');
    expect(fact!.source.date).toBe(source.date);
    expect(fact!.createdAt).toBeGreaterThan(0);
    expect(fact!.id).toMatch(/^fact-/);
  });

  it('returns null for empty text', async () => {
    const source: MemorySource = { meetingId: 'meeting-1', date: Date.now() };
    const fact = await store.add('', source);
    expect(fact).toBeNull();
  });

  it('returns null for whitespace-only text', async () => {
    const source: MemorySource = { meetingId: 'meeting-1', date: Date.now() };
    const fact = await store.add('   ', source);
    expect(fact).toBeNull();
  });

  it('search returns relevant facts ranked by similarity', async () => {
    const source: MemorySource = { meetingId: 'meeting-1', date: Date.now() };
    await store.add('The project uses React and TypeScript', source);
    await store.add('The deadline is next Friday', source);
    await store.add('The team meets daily at 9am', source);

    const results = await store.search('React TypeScript project');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThanOrEqual(results[results.length - 1].score);
  });

  it('search respects maxResults', async () => {
    const source: MemorySource = { meetingId: 'meeting-1', date: Date.now() };
    await store.add('fact one about coding', source);
    await store.add('fact two about testing', source);
    await store.add('fact three about deployment', source);

    const results = await store.search('coding testing deployment', { maxResults: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('forget removes a fact from the store', async () => {
    const source: MemorySource = { meetingId: 'meeting-1', date: Date.now() };
    const fact = await store.add('Important fact', source);
    expect(store.size).toBe(1);

    await store.forget(fact!.id);
    expect(store.size).toBe(0);
    expect(store.getFact(fact!.id)).toBeUndefined();
  });

  it('forget is a no-op for unknown IDs', async () => {
    await store.forget('non-existent-id');
    expect(store.size).toBe(0);
  });
});

describe('MemoryStore — dedup logic (Requirement 10.6)', () => {
  it('deduplicates facts with cosine similarity > threshold', async () => {
    // Use groupEmbedding so same-group texts are similar
    const store = createStore({ embedFn: groupEmbedding });
    const source1: MemorySource = { meetingId: 'meeting-1', date: 1000 };
    const source2: MemorySource = { meetingId: 'meeting-2', date: 2000 };

    await store.add('group-1-short text', source1);
    await store.add('group-1-a longer version of text here', source2);

    // Should have only 1 fact (deduped)
    expect(store.size).toBe(1);
    const facts = store.getAllFacts();
    // Longer text is retained
    expect(facts[0].text).toBe('group-1-a longer version of text here');
    // meetingIds merged
    expect(facts[0].source.meetingIds).toContain('meeting-1');
    expect(facts[0].source.meetingIds).toContain('meeting-2');
  });

  it('retains existing text when new text is shorter', async () => {
    const store = createStore({ embedFn: groupEmbedding });
    const source1: MemorySource = { meetingId: 'meeting-1', date: 1000 };
    const source2: MemorySource = { meetingId: 'meeting-2', date: 2000 };

    await store.add('group-1-this is a much longer description of the fact', source1);
    await store.add('group-1-short', source2);

    expect(store.size).toBe(1);
    const facts = store.getAllFacts();
    expect(facts[0].text).toBe('group-1-this is a much longer description of the fact');
    expect(facts[0].source.meetingIds).toContain('meeting-1');
    expect(facts[0].source.meetingIds).toContain('meeting-2');
  });

  it('does not dedup facts from different groups', async () => {
    const store = createStore({ embedFn: groupEmbedding });
    const source: MemorySource = { meetingId: 'meeting-1', date: 1000 };

    await store.add('group-1-first fact', source);
    await store.add('group-2-second fact', source);
    await store.add('group-3-third fact', source);

    expect(store.size).toBe(3);
  });
});

describe('MemoryStore — redaction on write (Requirement 10.5)', () => {
  it('applies redaction before storing', async () => {
    const store = createStore({ redactFn: emailRedact });
    const source: MemorySource = { meetingId: 'meeting-1', date: Date.now() };

    const fact = await store.add('Contact john@example.com for details', source);
    expect(fact).not.toBeNull();
    expect(fact!.text).toBe('Contact [REDACTED:EMAIL] for details');
    expect(fact!.text).not.toContain('john@example.com');
  });

  it('applyRedactionAndSave redacts all facts and tags with meetingId', async () => {
    const store = createStore({ redactFn: emailRedact });
    const source: MemorySource = { meetingId: 'meeting-42', date: Date.now() };
    const rules: RedactionRule[] = [{ kind: 'entity', entity: 'email' }];

    const results = await store.applyRedactionAndSave(
      ['Send to alice@test.org', 'No PII here', 'Reach out to bob@corp.co'],
      source,
      rules,
    );

    expect(results.length).toBe(3);
    for (const fact of results) {
      expect(fact.source.meetingIds).toContain('meeting-42');
      expect(fact.text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    }
  });

  it('returns null for text that becomes empty after redaction', async () => {
    // A redaction function that empties the text
    const store = createStore({ redactFn: () => '   ' });
    const source: MemorySource = { meetingId: 'meeting-1', date: Date.now() };

    const fact = await store.add('will be emptied', source);
    expect(fact).toBeNull();
  });
});

describe('MemoryStore — applyRedactionAndSave', () => {
  it('saves multiple facts with dedup', async () => {
    const store = createStore({ embedFn: groupEmbedding });
    const source: MemorySource = { meetingId: 'meeting-5', date: Date.now() };
    const rules: RedactionRule[] = [];

    const results = await store.applyRedactionAndSave(
      [
        'group-1-fact alpha version',
        'group-1-fact alpha version extended with more words',
        'group-2-completely different fact',
      ],
      source,
      rules,
    );

    // group-1 facts should be deduped (2 become 1), group-2 is separate
    expect(store.size).toBe(2);
    // All returned facts include the meetingId
    for (const fact of results) {
      expect(fact.source.meetingIds).toContain('meeting-5');
    }
  });
});

// --- Property-Based Tests ---

describe('Property 30: Memory_Store dedup invariant', () => {
  // **Validates: Requirements 10.6**
  //
  // After adding N facts where some are semantically similar (cosine > 0.92),
  // no two stored facts have cosine similarity > 0.92. The deduplication
  // retains the longer text.

  beforeEach(() => {
    uniqueCounter = 0;
    uniqueEmbeddingCache.clear();
  });

  it('no two stored facts have cosine similarity > threshold after insertions', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate a list of 2-10 fact texts. Some in same "group" to be similar.
        fc.array(
          fc.oneof(
            // Same-group facts (will be similar)
            fc.tuple(
              fc.integer({ min: 1, max: 3 }),
              fc.integer({ min: 1, max: 1000 }),
            ).map(([group, idx]) => `group-${group}-suffix${idx}`),
            // Unique facts: use integer index to guarantee distinct embeddings
            fc.integer({ min: 1, max: 10000 }).map(
              (idx) => `unique-${idx}-text`,
            ),
          ),
          { minLength: 2, maxLength: 10 },
        ),
        fc.integer({ min: 1, max: 100 }).map((n) => `meeting-${n}`),
        async (texts, meetingId) => {
          uniqueCounter = 0;
          uniqueEmbeddingCache.clear();
          const store = createStore({ embedFn: groupEmbedding });
          const source: MemorySource = { meetingId, date: Date.now() };

          // Add all facts
          for (const text of texts) {
            await store.add(text, source);
          }

          // Invariant: no two stored facts have cosine > threshold
          const facts = store.getAllFacts();
          for (let i = 0; i < facts.length; i++) {
            for (let j = i + 1; j < facts.length; j++) {
              const sim = cosineSimilarity(facts[i].embedding, facts[j].embedding);
              expect(sim).toBeLessThanOrEqual(DEFAULT_DEDUP_THRESHOLD);
            }
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it('deduplication retains the longer text', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.array(
          fc.string({ minLength: 1, maxLength: 40 }),
          { minLength: 2, maxLength: 6 },
        ),
        async (groupId, suffixes) => {
          const store = createStore({ embedFn: groupEmbedding });
          const source: MemorySource = { meetingId: 'meeting-prop', date: Date.now() };

          // Add facts in the same group with varying lengths
          const texts = suffixes.map((s) => `group-${groupId}-${s}`);
          for (const text of texts) {
            await store.add(text, source);
          }

          // After dedup, the stored fact's text should be the longest
          // among those that were deduped together
          const facts = store.getAllFacts();

          // For same-group texts that got deduped into one fact:
          // the stored text should be at least as long as the shortest input
          if (facts.length === 1) {
            const longestInput = texts.reduce(
              (a, b) => (a.length >= b.length ? a : b),
              '',
            );
            expect(facts[0].text.length).toBeGreaterThanOrEqual(longestInput.length);
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe('Property 31: facts are saved redacted with source tag', () => {
  // **Validates: Requirements 10.5**
  //
  // Every fact stored via applyRedactionAndSave has `source.meetingIds`
  // containing the originating meetingId, and the text field has been
  // passed through redaction.

  it('every stored fact has meetingId in source.meetingIds and text is redacted', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate an array of fact texts (non-empty, non-whitespace)
        fc.array(
          fc.string({ minLength: 3, maxLength: 50 }).filter((s) => s.trim().length > 0),
          { minLength: 1, maxLength: 8 },
        ),
        fc.string({ minLength: 3, maxLength: 20 }).map((s) => `meeting-${s}`),
        fc.integer({ min: 1000, max: 2000000000 }),
        async (factTexts, meetingId, date) => {
          // Use markerRedact so we can verify redaction was applied
          const store = createStore({ redactFn: markerRedact });
          const source: MemorySource = { meetingId, date };
          const rules: RedactionRule[] = [];

          const results = await store.applyRedactionAndSave(factTexts, source, rules);

          // Every returned fact must:
          for (const fact of results) {
            // 1. Have meetingId in source.meetingIds
            expect(fact.source.meetingIds).toContain(meetingId);

            // 2. Have text that was passed through redaction (marked with [R] prefix)
            expect(fact.text).toMatch(/^\[R\]/);
          }

          // Also verify all facts in the store satisfy the invariant
          const allFacts = store.getAllFacts();
          for (const fact of allFacts) {
            expect(fact.source.meetingIds).toContain(meetingId);
            expect(fact.text).toMatch(/^\[R\]/);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it('source.meetingIds always includes the originating meeting even after dedup', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.array(
          fc.tuple(
            fc.string({ minLength: 1, maxLength: 20 }),
            fc.string({ minLength: 3, maxLength: 15 }).map((s) => `m-${s}`),
          ),
          { minLength: 2, maxLength: 6 },
        ),
        async (groupId, insertions) => {
          const store = createStore({
            embedFn: groupEmbedding,
            redactFn: noopRedact,
          });

          // Insert same-group facts from different meetings
          const meetingIds: string[] = [];
          for (const [suffix, meetingId] of insertions) {
            const text = `group-${groupId}-${suffix}`;
            const source: MemorySource = { meetingId, date: Date.now() };
            await store.add(text, source);
            meetingIds.push(meetingId);
          }

          // After dedup, all meetingIds should be merged into the surviving fact(s)
          const facts = store.getAllFacts();
          const allStoredMeetingIds = new Set(
            facts.flatMap((f) => f.source.meetingIds),
          );

          // Every unique meetingId we inserted should appear somewhere
          const uniqueInserted = new Set(meetingIds);
          for (const mid of uniqueInserted) {
            expect(allStoredMeetingIds.has(mid)).toBe(true);
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
