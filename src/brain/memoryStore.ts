// ============================================
// Zule AI — Memory_Store
// ============================================
//
// A per-user durable store of facts derived from prior meetings,
// distinct from the user-uploaded Knowledge_Base.
//
// Implements design.md §"Components and Interfaces > 10. Memory_Store":
//   - Dedup on cosine similarity > 0.92 (Requirement 10.6)
//   - Redacted-on-write via Redaction_Engine (Requirement 10.5)
//   - Hard-delete on forget (Requirement 24.3)
//   - Persists to STORE_MEMORY_FACTS in IndexedDB
//
// Each stored fact:
//   { id, text (redacted), embedding, source: { meetingId, meetingIds, date }, createdAt }

import type { RedactionRule } from '../types/redaction';
import { apply as redact } from './redaction';
import { cosineSimilarity } from './vectorMath';

// --- Interfaces ---

export interface MemoryFact {
  id: string;
  text: string;
  embedding: Float32Array;
  source: {
    meetingId: string;
    meetingIds: string[];
    date: number;
  };
  createdAt: number;
}

export interface MemoryStoreOptions {
  /** Generate an embedding vector for the given text. */
  generateEmbedding: (text: string) => Promise<Float32Array>;
  /** Compute cosine similarity between two embedding vectors. */
  cosineSimilarity: (a: Float32Array, b: Float32Array) => number;
  /** Redact text using rules. */
  redact: (text: string, rules: RedactionRule[]) => string;
  /** Dedup threshold — cosine similarity above which facts are considered duplicates. Default: 0.92 */
  dedupThreshold?: number;
  /** Whether to persist to IndexedDB. Default: true */
  persist?: boolean;
}

export interface MemorySource {
  meetingId: string;
  date: number;
}

export interface SearchResult {
  fact: MemoryFact;
  score: number;
}

// --- Default constants ---

export const DEFAULT_DEDUP_THRESHOLD = 0.92;
export const DEFAULT_SEARCH_MAX_RESULTS = 5;
export const DEFAULT_SEARCH_MIN_SCORE = 0.3;

// --- ID Generation ---

function generateFactId(): string {
  return `fact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- MemoryStore Class ---

export class MemoryStore {
  private facts: Map<string, MemoryFact> = new Map();
  private readonly generateEmbedding: (text: string) => Promise<Float32Array>;
  private readonly cosine: (a: Float32Array, b: Float32Array) => number;
  private readonly redactFn: (text: string, rules: RedactionRule[]) => string;
  private readonly dedupThreshold: number;
  private readonly persist: boolean;
  private readonly defaultRedactionRules: RedactionRule[];

  constructor(opts: MemoryStoreOptions) {
    this.generateEmbedding = opts.generateEmbedding;
    this.cosine = opts.cosineSimilarity;
    this.redactFn = opts.redact;
    this.dedupThreshold = opts.dedupThreshold ?? DEFAULT_DEDUP_THRESHOLD;
    this.persist = opts.persist ?? true;
    this.defaultRedactionRules = [];
  }

  /**
   * Add a fact to the memory store. The text is redacted before storage.
   *
   * Dedup logic (Requirement 10.6):
   *   If cosine similarity to any existing fact exceeds dedupThreshold (0.92),
   *   the longer text is retained and meetingIds are merged. If the new text is
   *   shorter or equal, the existing fact's meetingIds are updated. If the new
   *   text is longer, the existing fact is replaced with the new text and merged
   *   meetingIds.
   *
   * The source.meetingIds array always includes the originating meetingId
   * (Requirement 10.5).
   *
   * Returns the stored/updated fact, or null if text is empty after redaction.
   */
  async add(
    text: string,
    source: MemorySource,
    rules: RedactionRule[] = [],
  ): Promise<MemoryFact | null> {
    // Redact before storage (Requirement 10.5)
    const redactedText = this.redactFn(text, rules);

    // Skip empty text after redaction
    if (redactedText.trim().length === 0) {
      return null;
    }

    // Generate embedding for the redacted text
    const embedding = await this.generateEmbedding(redactedText);

    // Check for duplicates (Requirement 10.6)
    let bestMatch: { fact: MemoryFact; similarity: number } | null = null;
    for (const existing of this.facts.values()) {
      const similarity = this.cosine(embedding, existing.embedding);
      if (similarity > this.dedupThreshold) {
        if (bestMatch === null || similarity > bestMatch.similarity) {
          bestMatch = { fact: existing, similarity };
        }
      }
    }

    if (bestMatch) {
      // Dedup: merge meetingIds and retain longer text
      const existingFact = bestMatch.fact;
      const mergedMeetingIds = Array.from(
        new Set([...existingFact.source.meetingIds, source.meetingId]),
      );

      if (redactedText.length > existingFact.text.length) {
        // New text is longer — replace with new text, keep merged meetingIds
        const updatedFact: MemoryFact = {
          ...existingFact,
          text: redactedText,
          embedding,
          source: {
            meetingId: existingFact.source.meetingId,
            meetingIds: mergedMeetingIds,
            date: existingFact.source.date,
          },
        };
        this.facts.set(existingFact.id, updatedFact);
        if (this.persist) {
          await this.persistFact(updatedFact);
        }
        return updatedFact;
      } else {
        // Existing text is longer or equal — keep existing, merge meetingIds
        const updatedFact: MemoryFact = {
          ...existingFact,
          source: {
            ...existingFact.source,
            meetingIds: mergedMeetingIds,
          },
        };
        this.facts.set(existingFact.id, updatedFact);
        if (this.persist) {
          await this.persistFact(updatedFact);
        }
        return updatedFact;
      }
    }

    // No duplicate found — insert new fact
    const fact: MemoryFact = {
      id: generateFactId(),
      text: redactedText,
      embedding,
      source: {
        meetingId: source.meetingId,
        meetingIds: [source.meetingId],
        date: source.date,
      },
      createdAt: Date.now(),
    };
    this.facts.set(fact.id, fact);
    if (this.persist) {
      await this.persistFact(fact);
    }
    return fact;
  }

  /**
   * Search memory facts by semantic similarity.
   * Returns top matches ranked by cosine similarity above a minimum score.
   */
  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number },
  ): Promise<SearchResult[]> {
    const maxResults = opts?.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS;
    const minScore = opts?.minScore ?? DEFAULT_SEARCH_MIN_SCORE;

    const queryEmbedding = await this.generateEmbedding(query);

    const scored: SearchResult[] = [];
    for (const fact of this.facts.values()) {
      const score = this.cosine(queryEmbedding, fact.embedding);
      if (score >= minScore) {
        scored.push({ fact, score });
      }
    }

    // Sort descending by score and take top N
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults);
  }

  /**
   * Hard-delete a fact from memory (Requirement 24.3).
   * Removes from in-memory store and persistence.
   */
  async forget(id: string): Promise<void> {
    this.facts.delete(id);
    if (this.persist) {
      await this.deleteFact(id);
    }
  }

  /**
   * Apply redaction to each fact string and save to the store.
   * Each fact gets the originating meetingId in its source.meetingIds.
   * (Requirements 10.5, 10.6)
   *
   * Returns the array of stored MemoryFacts (deduped/merged as appropriate).
   */
  async applyRedactionAndSave(
    facts: string[],
    source: MemorySource,
    rules: RedactionRule[],
  ): Promise<MemoryFact[]> {
    const results: MemoryFact[] = [];
    for (const factText of facts) {
      const stored = await this.add(factText, source, rules);
      if (stored) {
        results.push(stored);
      }
    }
    return results;
  }

  // --- Accessors for testing ---

  /** Get all facts currently in the store (for testing/inspection). */
  getAllFacts(): MemoryFact[] {
    return Array.from(this.facts.values());
  }

  /** Get a single fact by ID. */
  getFact(id: string): MemoryFact | undefined {
    return this.facts.get(id);
  }

  /** Get the number of facts stored. */
  get size(): number {
    return this.facts.size;
  }

  // --- Persistence (IndexedDB) ---

  private async persistFact(fact: MemoryFact): Promise<void> {
    try {
      const { STORE_MEMORY_FACTS } = await import('../data/database');
      const db = await this.openDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_MEMORY_FACTS, 'readwrite');
        // Serialize Float32Array to a plain array for IndexedDB storage
        const serialized = {
          ...fact,
          embedding: Array.from(fact.embedding),
        };
        tx.objectStore(STORE_MEMORY_FACTS).put(serialized);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[MemoryStore] Failed to persist fact:', error);
    }
  }

  private async deleteFact(id: string): Promise<void> {
    try {
      const { STORE_MEMORY_FACTS } = await import('../data/database');
      const db = await this.openDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_MEMORY_FACTS, 'readwrite');
        tx.objectStore(STORE_MEMORY_FACTS).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[MemoryStore] Failed to delete fact:', error);
    }
  }

  private openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('zule-unified', 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Load all facts from IndexedDB into memory. Called on startup.
   */
  async loadFromPersistence(): Promise<void> {
    if (!this.persist) return;
    try {
      const { STORE_MEMORY_FACTS } = await import('../data/database');
      const db = await this.openDB();
      const rows = await new Promise<unknown[]>((resolve, reject) => {
        const tx = db.transaction(STORE_MEMORY_FACTS, 'readonly');
        const request = tx.objectStore(STORE_MEMORY_FACTS).getAll();
        request.onsuccess = () => resolve(request.result as unknown[]);
        request.onerror = () => reject(request.error);
      });
      for (const row of rows) {
        const r = row as Record<string, unknown>;
        const fact: MemoryFact = {
          id: r.id as string,
          text: r.text as string,
          embedding: new Float32Array(r.embedding as number[]),
          source: r.source as MemoryFact['source'],
          createdAt: r.createdAt as number,
        };
        this.facts.set(fact.id, fact);
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[MemoryStore] Failed to load from persistence:', error);
    }
  }
}
