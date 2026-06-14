// ============================================
// Zule AI — Coaching_Module (pure)
// ============================================
//
// This module is the "purified" replacement for the original
// `sentimentAnalyzer.ts`. It exposes a single entry point — `getFullAnalysis`
// — that takes a fully-formed input record and returns a `CoachingMetrics`
// snapshot. Every helper is pure and has no module-level mutable state, so
// `getFullAnalysis(x)` always equals `getFullAnalysis(x)` no matter when or
// how often it is called.
//
// Design references:
//   - Requirement 9.2: filler counts use whole-word matching anchored on
//     word boundaries. Multi-word fillers tolerate runs of whitespace.
//   - Requirement 9.3: `wordsPerMinute` is computed from
//     `totalWordCount / (durationSeconds / 60)`. The caller is responsible
//     for passing user-attributed words and user-active duration.
//   - Requirement 9.5: identical inputs produce identical outputs, with
//     no dependence on wall-clock time, prior calls, or hidden state.
//   - Requirement 9.6: `confidenceScore` is bounded to [0, 100] for any
//     non-negative `wordsPerMinute` and any `fillerRatio ∈ [0, 1]`.
//
// `sentimentAnalyzer.ts` is intentionally left in place as a legacy shim
// while other modules migrate; this file is the canonical implementation.

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface CoachingMetrics {
  /** High-level sentiment label derived from the lexicon score. */
  sentiment: 'positive' | 'negative' | 'neutral';
  /** Lexicon score in [-1, 1]; 0 when no lexicon hits are present. */
  score: number;
  /** Total whole-word filler matches in `text`. */
  fillerCount: number;
  /** The filler tokens that matched, in order of canonical lexicon iteration. */
  fillerWords: string[];
  /** Words per minute derived strictly from `totalWordCount / (durationSeconds / 60)`. */
  wordsPerMinute: number;
  /** Bounded confidence in [0, 100]. */
  confidenceScore: number;
}

export interface CoachingInput {
  /** Raw transcript text the metrics are computed against. */
  text: string;
  /** Number of user-attributed words. The caller is responsible for filtering. */
  totalWordCount: number;
  /** Duration during which the user was the active speaker, in seconds. */
  durationSeconds: number;
}

// ----------------------------------------------------------------------------
// Lexicons (frozen; never mutated after module load)
// ----------------------------------------------------------------------------

/** Lexicon of positive sentiment indicators. */
export const POSITIVE_WORDS: readonly string[] = Object.freeze([
  'great', 'excellent', 'amazing', 'fantastic', 'wonderful', 'perfect', 'love',
  'brilliant', 'outstanding', 'impressive', 'definitely', 'absolutely', 'excited',
  'thrilled', 'passionate', 'innovative', 'successful', 'achieved', 'accomplished',
  'strong', 'confident', 'effective', 'efficient', 'improved', 'growth', 'opportunity',
]);

/** Lexicon of negative sentiment indicators. */
export const NEGATIVE_WORDS: readonly string[] = Object.freeze([
  'bad', 'terrible', 'awful', 'horrible', 'worst', 'hate', 'disappointed',
  'frustrated', 'confused', 'worried', 'concerned', 'unfortunately', 'failed',
  'struggling', 'difficult', 'problem', 'issue', 'wrong', 'mistake', 'error',
  'unclear', 'complicated', 'impossible', 'never', 'cannot',
]);

/**
 * Filler tokens, including multi-word phrases. Multi-word phrases are matched
 * with whitespace tolerance via `\s+`.
 */
export const FILLER_WORDS: readonly string[] = Object.freeze([
  'um', 'uh', 'uhh', 'umm', 'like', 'you know', 'basically', 'actually',
  'literally', 'honestly', 'obviously', 'right', 'so yeah', 'I mean',
  'kind of', 'sort of', 'I guess', 'you see',
]);

// ----------------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------------

/** Escape characters that have a special meaning in a regular expression. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a case-insensitive, global, whole-word regex for `phrase`. Runs of
 * whitespace inside `phrase` are matched by `\s+` so that "you know" and
 * "you  know" both match while "youknow" does not.
 */
function buildWholeWordRegex(phrase: string): RegExp {
  const escaped = escapeRegex(phrase);
  // Replace every run of whitespace with `\s+` for whitespace tolerance.
  const pattern = escaped.replace(/\s+/g, '\\s+');
  return new RegExp(`\\b${pattern}\\b`, 'gi');
}

/**
 * Count the number of whole-word occurrences of every word in `lexicon`
 * inside `text`. Word boundaries follow the JavaScript `\b` semantics so
 * that "great" matches "That was great." but not "greater" or "ungreat".
 */
function countLexiconHits(text: string, lexicon: readonly string[]): number {
  let total = 0;
  for (const word of lexicon) {
    const matches = text.match(buildWholeWordRegex(word));
    if (matches) total += matches.length;
  }
  return total;
}

// ----------------------------------------------------------------------------
// Public helpers
// ----------------------------------------------------------------------------

/**
 * Score sentiment over `text` using the bundled lexicons. The score is in
 * [-1, 1] with 0 returned when neither lexicon matches.
 */
export function analyzeSentiment(
  text: string,
): Pick<CoachingMetrics, 'sentiment' | 'score'> {
  const positive = countLexiconHits(text, POSITIVE_WORDS);
  const negative = countLexiconHits(text, NEGATIVE_WORDS);
  const total = positive + negative;
  if (total === 0) return { sentiment: 'neutral', score: 0 };

  const score = (positive - negative) / total;
  // Score is mathematically in [-1, 1]; the threshold band of ±0.1 picks
  // the neutral label so that one-or-two-hit transcripts do not flip
  // labels unstably.
  const sentiment: 'positive' | 'negative' | 'neutral' =
    score > 0.1 ? 'positive' : score < -0.1 ? 'negative' : 'neutral';
  return { sentiment, score };
}

/**
 * Count filler whole-word matches in `text`. Multi-word fillers are matched
 * with whitespace tolerance; the returned `found` array preserves the
 * canonical filler tokens (one entry per match).
 */
export function countFillers(text: string): { count: number; found: string[] } {
  const found: string[] = [];
  let count = 0;
  for (const filler of FILLER_WORDS) {
    const matches = text.match(buildWholeWordRegex(filler));
    if (matches) {
      count += matches.length;
      for (let i = 0; i < matches.length; i += 1) found.push(filler);
    }
  }
  return { count, found };
}

/**
 * Words per minute = totalWordCount / (durationSeconds / 60), rounded to the
 * nearest integer. Returns 0 when `durationSeconds` is non-positive or non-
 * finite, when `totalWordCount` is non-finite, or when `totalWordCount < 0`.
 *
 * The function is intentionally agnostic to speaker roles. The caller is
 * responsible for passing user-attributed words and user-active duration
 * (Requirement 9.3).
 */
export function calculateWPM(
  totalWordCount: number,
  durationSeconds: number,
): number {
  if (
    !Number.isFinite(totalWordCount) ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    totalWordCount < 0
  ) {
    return 0;
  }
  return Math.round((totalWordCount / durationSeconds) * 60);
}

/**
 * Compute a confidence score in [0, 100] from `wpm` and `fillerRatio`. The
 * curve rewards a 120–160 WPM pace and penalises filler usage at 5× the
 * filler ratio. The closed clamp at the end guarantees the bounded-output
 * invariant in Requirement 9.6.
 */
export function calculateConfidence(wpm: number, fillerRatio: number): number {
  // Defensive coercion of non-finite inputs to keep the function total.
  const safeWpm = Number.isFinite(wpm) && wpm >= 0 ? wpm : 0;
  const safeRatio = Number.isFinite(fillerRatio)
    ? Math.max(0, Math.min(1, fillerRatio))
    : 0;

  // Pace score curve. Each branch is closed-form and produces a finite value.
  let paceScore: number;
  if (safeWpm < 80) paceScore = 40 + (safeWpm / 80) * 30;
  else if (safeWpm < 120) paceScore = 70 + ((safeWpm - 80) / 40) * 20;
  else if (safeWpm <= 160) paceScore = 90 + ((safeWpm - 120) / 40) * 10;
  else if (safeWpm <= 200) paceScore = 100 - ((safeWpm - 160) / 40) * 15;
  else paceScore = 85 - ((safeWpm - 200) / 50) * 20;

  // Filler ratio penalty. A 0% ratio earns 100; 20%+ earns 0.
  const fillerScore = Math.max(0, 100 - safeRatio * 500);

  // Weighted combination, then a final clamp to honour the bound invariant
  // even if the underlying curves produce out-of-range intermediates.
  const blended = paceScore * 0.4 + fillerScore * 0.6;
  return Math.max(0, Math.min(100, Math.round(blended)));
}

// ----------------------------------------------------------------------------
// Public entry point
// ----------------------------------------------------------------------------

/**
 * Run the full coaching analysis over `input`. The function is pure: for
 * every fixed `input`, the returned `CoachingMetrics` is deeply identical
 * across calls. There is no dependence on wall-clock time or module-level
 * mutable state.
 */
export function getFullAnalysis(input: CoachingInput): CoachingMetrics {
  const { text, totalWordCount, durationSeconds } = input;

  const { sentiment, score } = analyzeSentiment(text);
  const { count: fillerCount, found: fillerWords } = countFillers(text);
  const wordsPerMinute = calculateWPM(totalWordCount, durationSeconds);

  // Filler ratio is taken over the surface word count of `text` itself so
  // it is well-defined for any string and never depends on `totalWordCount`
  // (which counts user-attributed words from the caller's perspective).
  const surfaceWords = text.trim().length === 0
    ? 0
    : text.trim().split(/\s+/).length;
  const fillerRatio = surfaceWords > 0 ? fillerCount / surfaceWords : 0;
  const boundedFillerRatio = Math.max(0, Math.min(1, fillerRatio));

  const confidenceScore = calculateConfidence(wordsPerMinute, boundedFillerRatio);

  return {
    sentiment,
    score,
    fillerCount,
    fillerWords,
    wordsPerMinute,
    confidenceScore,
  };
}
