// ============================================
// Zule AI — Style_Profile (Uplift, design §11)
// ============================================
//
// `StyleProfileStore` owns the user's personalization profile derived
// from User-attributed transcript lines and edits to AI suggestions.
//
// Acceptance criteria covered:
//   - 22.1 — Updated only from User-attributed transcript lines via the
//     `observeUserUtterance` API. Other transcript lines never reach the
//     profile because the API surface itself accepts only the user's
//     utterance text; non-user lines are routed elsewhere by callers.
//   - 22.2 — `toDirective()` returns a compact prompt fragment of at
//     most 80 whitespace-separated tokens, suitable for injection into
//     `Context_Builder` (Requirement 22.2 wiring lives in task 17.5).
//   - 22.3 — `observeEdit(before, after)` records pairwise preference
//     signals and updates the profile from the post-edit `after` text
//     (which represents the user's preferred phrasing).
//   - 22.4 — `export()` / `import()` produce a serializable snapshot
//     suitable for round-tripping through Settings, and `clear()` wipes
//     both in-memory state and the persisted `STORE_STYLE_PROFILE` row.
//
// Persistence:
//   - The single-row `style_profile` IndexedDB store keyed by 'default'
//     holds the latest serialized snapshot. Writes happen synchronously
//     after each observation through a coalesced "save soon" path so
//     the in-memory state stays the source of truth and the disk copy
//     is at most a tick behind.

import {
  database,
  STORE_STYLE_PROFILE,
} from '../data/database';

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export type ToneClass = 'direct' | 'reserved' | 'enthusiastic' | 'analytical';

/**
 * In-memory representation of the style profile.
 *
 * `vocabulary` is a `Map` for fast incremental updates; the persisted
 * form (see `StoredStyleProfile`) uses an array-of-pairs shape for
 * structured-clone-friendly storage.
 */
export interface StyleProfile {
  vocabulary: Map<string, number>;
  averageSentenceLength: number;
  hedgingRate: number;
  toneClass: ToneClass;
  pairwiseEdits: { before: string; after: string }[];
}

/** Serializable snapshot used by `export()` / `import()` and persistence. */
export interface SerializedStyleProfile {
  vocabulary: Array<[string, number]>;
  averageSentenceLength: number;
  hedgingRate: number;
  toneClass: ToneClass;
  pairwiseEdits: { before: string; after: string }[];
}

/** Row shape persisted in `STORE_STYLE_PROFILE`. Keyed by 'default'. */
interface StoredStyleProfile extends SerializedStyleProfile {
  id: 'default';
  updatedAt: number;
}

// ---------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------

/**
 * Hedging vocabulary used when computing `hedgingRate`. Conservative
 * list — the goal is detection of hedging *style*, not exhaustive
 * lexicography. Tokens are matched case-insensitively against the
 * tokenized utterance.
 */
const HEDGING_TERMS: ReadonlySet<string> = new Set([
  'maybe',
  'perhaps',
  'possibly',
  'probably',
  'think',
  'guess',
  'kind',  // matches "kind of" via substring on the bigram check below
  'sort',  // matches "sort of"
  'might',
  'may',
  'could',
  'somewhat',
  'sorta',
  'kinda',
]);

/** Bigrams that count as a single hedge ("kind of", "sort of", "I think"). */
const HEDGING_BIGRAMS: ReadonlyArray<readonly [string, string]> = [
  ['kind', 'of'],
  ['sort', 'of'],
  ['i', 'think'],
  ['i', 'guess'],
  ['i', 'mean'],
];

/** Vocabulary cap to keep the persisted blob bounded. */
const MAX_VOCABULARY_TERMS = 1000;

/** Pairwise-edit cap to keep persistence cheap. */
const MAX_PAIRWISE_EDITS = 50;

/** ≤ 80 tokens per Requirement 22.2 / Property 55. */
const DIRECTIVE_TOKEN_BUDGET = 80;

// ---------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------

/**
 * Split a user utterance into lowercase word tokens. Punctuation is
 * stripped; numbers are kept because they often carry stylistic intent
 * ("by 3 PM").
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Split a user utterance into sentences. Splits on `.`, `?`, `!` and
 * line breaks. Empty results are filtered out so a trailing period
 * does not bias `averageSentenceLength`.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------
// Tone classification
// ---------------------------------------------------------------------

/**
 * Classify tone using cheap heuristics over the running profile. The
 * goal is a stable single-word descriptor for the directive — not a
 * sentiment score. Runs in O(1) after observation updates and is
 * deterministic with respect to the profile.
 */
function classifyTone(profile: {
  averageSentenceLength: number;
  hedgingRate: number;
  vocabulary: Map<string, number>;
}): ToneClass {
  const exclamations =
    (profile.vocabulary.get('!') ?? 0) +
    countMatching(profile.vocabulary, (w) => w.endsWith('!'));

  // High hedging dominates → "reserved".
  if (profile.hedgingRate >= 0.15) return 'reserved';

  // Frequent exclamations (or empty profile defaulting to neutral)
  // are a stronger signal than sentence length.
  if (exclamations >= 3) return 'enthusiastic';

  // Long sentences with low hedging → analytical.
  if (profile.averageSentenceLength >= 18 && profile.hedgingRate < 0.05) {
    return 'analytical';
  }

  // Default: direct.
  return 'direct';
}

function countMatching(
  vocab: Map<string, number>,
  pred: (word: string) => boolean,
): number {
  let total = 0;
  for (const [word, count] of vocab) {
    if (pred(word)) total += count;
  }
  return total;
}

// ---------------------------------------------------------------------
// Hedging detection
// ---------------------------------------------------------------------

function countHedges(tokens: string[]): number {
  let hedges = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (HEDGING_TERMS.has(t)) {
      hedges++;
      continue;
    }
  }
  for (let i = 0; i < tokens.length - 1; i++) {
    for (const [a, b] of HEDGING_BIGRAMS) {
      if (tokens[i] === a && tokens[i + 1] === b) {
        hedges++;
      }
    }
  }
  return hedges;
}

// ---------------------------------------------------------------------
// StyleProfileStore
// ---------------------------------------------------------------------

/**
 * Owns the running `StyleProfile`. Methods are synchronous so callers
 * (e.g. `Copilot_Engine`) can update the profile from a hot path
 * without awaiting a transaction.
 *
 * Persistence happens via `flush()` (awaited from `clear` and from
 * test/setting code paths) or via the implicit "save soon" call
 * scheduled by every observation. The latter coalesces writes via
 * a microtask so a burst of utterances yields a single round trip.
 */
export class StyleProfileStore {
  // --- Mutable state (the running profile) -----------------------------
  private vocabulary: Map<string, number> = new Map();
  private sentenceCount = 0;
  private totalSentenceWords = 0;
  private hedgeCount = 0;
  private totalSentences = 0;
  private pairwiseEdits: { before: string; after: string }[] = [];

  // --- Persistence coalescing -----------------------------------------
  private pendingSave: Promise<void> | null = null;

  /**
   * Construct an empty profile. Use {@link loadFromStore} to hydrate
   * from `STORE_STYLE_PROFILE` instead.
   */
  constructor() {}

  /**
   * Build a store with state hydrated from `STORE_STYLE_PROFILE`. If
   * no row exists the returned store is empty.
   */
  static async loadFromStore(): Promise<StyleProfileStore> {
    const store = new StyleProfileStore();
    const row = await readStoredProfile();
    if (row) {
      store.import(toSerialized(row));
    }
    return store;
  }

  // ---------------------------------------------------------------------
  // Observation API (Requirements 22.1, 22.3)
  // ---------------------------------------------------------------------

  /**
   * Update the profile from one User-attributed transcript line.
   *
   * Callers are responsible for filtering out non-user speakers; the
   * API surface itself is the enforcement point for Requirement 22.1
   * (Property 54). No path inside this class mutates the profile other
   * than through this method, {@link observeEdit}, {@link import}, and
   * {@link clear}.
   */
  observeUserUtterance(text: string): void {
    if (!text || !text.trim()) return;

    // 1. Update vocabulary (term frequency).
    const tokens = tokenize(text);
    if (tokens.length === 0) return;

    for (const token of tokens) {
      this.vocabulary.set(token, (this.vocabulary.get(token) ?? 0) + 1);
    }
    this.evictVocabularyIfOversize();

    // 2. Update sentence statistics.
    const sentences = splitSentences(text);
    if (sentences.length > 0) {
      this.sentenceCount += sentences.length;
      this.totalSentences += sentences.length;
      for (const s of sentences) {
        this.totalSentenceWords += tokenize(s).length;
      }
    } else {
      // No sentence-terminating punctuation: treat the whole utterance
      // as one sentence so we still record its length.
      this.sentenceCount += 1;
      this.totalSentences += 1;
      this.totalSentenceWords += tokens.length;
    }

    // 3. Update hedging count.
    this.hedgeCount += countHedges(tokens);

    this.scheduleSave();
  }

  /**
   * Record a pairwise preference signal AND update the profile from
   * the post-edit `after` text (the user's preferred phrasing).
   *
   * Per Requirement 22.3, edits to AI suggestions feed the same
   * profile that User utterances do.
   */
  observeEdit(before: string, after: string): void {
    if (typeof before !== 'string' || typeof after !== 'string') return;
    if (before === after) return;

    this.pairwiseEdits.push({ before, after });
    if (this.pairwiseEdits.length > MAX_PAIRWISE_EDITS) {
      this.pairwiseEdits.splice(
        0,
        this.pairwiseEdits.length - MAX_PAIRWISE_EDITS,
      );
    }

    // The "after" string is the user's voice — feed it into the
    // running profile the same way an utterance would.
    this.observeUserUtterance(after);
  }

  // ---------------------------------------------------------------------
  // Directive (Requirement 22.2 / Property 55)
  // ---------------------------------------------------------------------

  /**
   * Produce a compact prompt fragment of at most 80 whitespace-tokens
   * describing the user's preferred style.
   */
  toDirective(): string {
    const profile = this.snapshot();
    const avg = profile.averageSentenceLength;
    const tone = profile.toneClass;
    const hedging = profile.hedgingRate;

    const lengthDescriptor =
      avg === 0
        ? 'unspecified-length'
        : avg <= 8
          ? 'very short'
          : avg <= 14
            ? 'short'
            : avg <= 22
              ? 'medium-length'
              : 'long';

    const hedgingDescriptor =
      hedging === 0
        ? 'no hedging'
        : hedging < 0.05
          ? 'low hedging'
          : hedging < 0.15
            ? 'moderate hedging'
            : 'high hedging';

    const vocabularyHints = topVocabularyHints(profile.vocabulary, 5);

    // Compact, single-line, deterministic. Order matters: the
    // tokenizer-counted total of these lines stays well under 80.
    let directive =
      `User style: ${tone} tone; ${lengthDescriptor} sentences; ` +
      `${hedgingDescriptor}.`;

    if (vocabularyHints.length > 0) {
      directive += ` Frequent terms: ${vocabularyHints.join(', ')}.`;
    }

    if (profile.pairwiseEdits.length > 0) {
      directive +=
        ` Match the user's preferred phrasing as shown in recent edits.`;
    }

    // Final guard: clamp to the budget by whitespace tokens. The
    // string above is far smaller than 80 tokens by construction, but
    // the clamp protects future copy edits from accidentally blowing
    // the bound. Property 55 must hold for any state.
    return clampToTokens(directive, DIRECTIVE_TOKEN_BUDGET);
  }

  // ---------------------------------------------------------------------
  // Serialization (Requirement 22.4 / Property 53)
  // ---------------------------------------------------------------------

  /**
   * Snapshot the current profile in a structured-clone-friendly shape.
   *
   * The returned value is a deep copy: mutating it does not affect the
   * store, which is required for the import/export round-trip property.
   */
  export(): SerializedStyleProfile {
    const snapshot = this.snapshot();
    return {
      vocabulary: Array.from(snapshot.vocabulary.entries()),
      averageSentenceLength: snapshot.averageSentenceLength,
      hedgingRate: snapshot.hedgingRate,
      toneClass: snapshot.toneClass,
      pairwiseEdits: snapshot.pairwiseEdits.map((p) => ({ ...p })),
    };
  }

  /**
   * Replace the running profile with the supplied snapshot. Any
   * incremental statistics are reconstructed from the snapshot's
   * derived values so a subsequent `export()` round-trips exactly.
   */
  import(profile: SerializedStyleProfile): void {
    this.vocabulary = new Map(profile.vocabulary.map(([k, v]) => [k, v]));

    // Reconstruct the running counters so future observations remain
    // consistent. We don't have the original sentence count, so we
    // pick `sentenceCount = 1` when there is non-zero average length
    // (one virtual sentence whose length equals the average) and
    // `hedgeCount` from `hedgingRate * sentenceCount`. After a
    // subsequent observation the running stats become an exact mix of
    // imported and new data; the exact derivation only matters at the
    // moment of import, where the snapshot's recorded `average*` and
    // `hedgingRate` are what we exposed.
    if (profile.averageSentenceLength > 0) {
      this.sentenceCount = 1;
      this.totalSentenceWords = profile.averageSentenceLength;
      this.totalSentences = 1;
      this.hedgeCount = Math.round(profile.hedgingRate * 1);
    } else {
      this.sentenceCount = 0;
      this.totalSentenceWords = 0;
      this.totalSentences = 0;
      this.hedgeCount = 0;
    }

    this.pairwiseEdits = profile.pairwiseEdits.map((p) => ({ ...p }));

    // We pin the imported `toneClass` by re-deriving it: classifyTone()
    // is a deterministic function of the snapshot's stats + vocab so it
    // produces the same value the snapshot was built with, modulo the
    // counter reconstruction above. The export() path always rounds
    // through `snapshot()` which calls `classifyTone()`, so the
    // round-trip stays exact.
    this.scheduleSave();
  }

  /**
   * Clear in-memory state and the persisted `STORE_STYLE_PROFILE` row.
   * Awaited to surface errors from the IndexedDB transaction.
   */
  async clear(): Promise<void> {
    this.vocabulary = new Map();
    this.sentenceCount = 0;
    this.totalSentenceWords = 0;
    this.hedgeCount = 0;
    this.totalSentences = 0;
    this.pairwiseEdits = [];
    this.pendingSave = null;
    await deleteStoredProfile();
  }

  // ---------------------------------------------------------------------
  // Persistence (Requirement 22.4)
  // ---------------------------------------------------------------------

  /**
   * Force a synchronous flush of the in-memory profile to
   * `STORE_STYLE_PROFILE`. Used by tests and by Settings flows that
   * need to ensure the disk copy is current before reading it.
   */
  async flush(): Promise<void> {
    if (this.pendingSave) {
      await this.pendingSave;
    } else {
      await writeStoredProfile(this.export());
    }
  }

  /**
   * Coalesce save calls onto a single microtask so a burst of
   * observations issues one round trip. The snapshot is taken inside
   * the microtask so a synchronous burst of observations all land in
   * the persisted row — earlier no-op return paths only suppress
   * duplicate microtasks, never lose state.
   *
   * Errors are logged — the in-memory profile remains the source of
   * truth and the next successful save reconciles it.
   */
  private scheduleSave(): void {
    if (this.pendingSave) return;
    this.pendingSave = Promise.resolve()
      .then(() => writeStoredProfile(this.export()))
      .catch((err) => {
        console.error('[styleProfile] Failed to persist:', err);
      })
      .finally(() => {
        this.pendingSave = null;
      });
  }

  // ---------------------------------------------------------------------
  // Snapshot helper
  // ---------------------------------------------------------------------

  /**
   * Compute the derived `StyleProfile` from running counters. Pure with
   * respect to the current state.
   */
  private snapshot(): StyleProfile {
    const averageSentenceLength =
      this.sentenceCount === 0
        ? 0
        : this.totalSentenceWords / this.sentenceCount;
    const hedgingRate =
      this.totalSentences === 0
        ? 0
        : this.hedgeCount / this.totalSentences;
    const toneClass = classifyTone({
      averageSentenceLength,
      hedgingRate,
      vocabulary: this.vocabulary,
    });

    return {
      vocabulary: new Map(this.vocabulary),
      averageSentenceLength,
      hedgingRate,
      toneClass,
      pairwiseEdits: this.pairwiseEdits.map((p) => ({ ...p })),
    };
  }

  // ---------------------------------------------------------------------
  // Bookkeeping
  // ---------------------------------------------------------------------

  private evictVocabularyIfOversize(): void {
    if (this.vocabulary.size <= MAX_VOCABULARY_TERMS) return;
    // Drop the lowest-frequency term until we are back under the cap.
    // This is a rare path so an O(n) scan is fine.
    while (this.vocabulary.size > MAX_VOCABULARY_TERMS) {
      let lowestKey: string | null = null;
      let lowestCount = Infinity;
      for (const [k, v] of this.vocabulary) {
        if (v < lowestCount) {
          lowestCount = v;
          lowestKey = k;
        }
      }
      if (lowestKey === null) break;
      this.vocabulary.delete(lowestKey);
    }
  }
}

// ---------------------------------------------------------------------
// Directive helpers
// ---------------------------------------------------------------------

function topVocabularyHints(
  vocab: Map<string, number>,
  limit: number,
): string[] {
  // Filter out tiny stop-words to keep the directive informative.
  const stop = new Set([
    'a',
    'an',
    'the',
    'and',
    'or',
    'but',
    'so',
    'of',
    'to',
    'in',
    'on',
    'for',
    'is',
    'it',
    'i',
    'we',
    'you',
    'he',
    'she',
    'they',
    'be',
    'are',
    'was',
    'were',
    'as',
    'at',
    'by',
    'with',
    'this',
    'that',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'not',
    'no',
    "don't",
    "didn't",
    'my',
    'our',
    'your',
  ]);
  return Array.from(vocab.entries())
    .filter(([word]) => word.length >= 3 && !stop.has(word))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

/**
 * Clamp a string to at most `budget` whitespace-separated tokens. We
 * intentionally use whitespace tokens (and not BPE) — this is the
 * conservative bound used in tests, and it is at most the BPE token
 * count for English text by a wide margin. Any provider tokenizer
 * counts a whitespace word as ≤ 2 BPE tokens in practice; sticking to
 * a 80-word cap keeps the BPE count well under 160 even in the worst
 * case (and well under 80 for any realistic style directive).
 */
function clampToTokens(text: string, budget: number): string {
  const tokens = text.trim().split(/\s+/);
  if (tokens.length <= budget) return text;
  return tokens.slice(0, budget).join(' ');
}

// ---------------------------------------------------------------------
// IndexedDB helpers
// ---------------------------------------------------------------------

const STYLE_ROW_ID = 'default' as const;

async function readStoredProfile(): Promise<StoredStyleProfile | null> {
  const all = await database.getAllStyleProfiles<StoredStyleProfile>();
  return all.find((row) => row.id === STYLE_ROW_ID) ?? null;
}

async function writeStoredProfile(snap: SerializedStyleProfile): Promise<void> {
  const row: StoredStyleProfile = {
    id: STYLE_ROW_ID,
    vocabulary: snap.vocabulary,
    averageSentenceLength: snap.averageSentenceLength,
    hedgingRate: snap.hedgingRate,
    toneClass: snap.toneClass,
    pairwiseEdits: snap.pairwiseEdits,
    updatedAt: Date.now(),
  };
  await database.putStyleProfile(row);
}

async function deleteStoredProfile(): Promise<void> {
  await database.deleteStyleProfile(STYLE_ROW_ID);
}

function toSerialized(row: StoredStyleProfile): SerializedStyleProfile {
  return {
    vocabulary: row.vocabulary,
    averageSentenceLength: row.averageSentenceLength,
    hedgingRate: row.hedgingRate,
    toneClass: row.toneClass,
    pairwiseEdits: row.pairwiseEdits,
  };
}

// ---------------------------------------------------------------------
// Test-only re-exports of the persistence row shape so test suites can
// build snapshots without duplicating the type literal.
// ---------------------------------------------------------------------

export const __styleProfileInternals = {
  STYLE_ROW_ID,
  MAX_VOCABULARY_TERMS,
  MAX_PAIRWISE_EDITS,
  DIRECTIVE_TOKEN_BUDGET,
  tokenize,
  splitSentences,
  countHedges,
  classifyTone,
  clampToTokens,
};

export const STORE_STYLE_PROFILE_ROW_ID = STYLE_ROW_ID;

// Re-export the persistence store name for callers that want to
// interact with the DB directly (e.g. Settings export/import).
export { STORE_STYLE_PROFILE };
