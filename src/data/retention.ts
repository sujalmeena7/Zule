// ============================================
// Zule AI — Retention rules (background sweep)
// ============================================
//
// Pure, non-mutating helpers that implement the retention contract from
// design.md §16 / Requirement 16.5 and the property test in
// `retention.test.ts` (Property 48).
//
// The functions in this module are deliberately *I/O free*: they consume
// a snapshot of `StoredMeeting[]` and return a new snapshot. The actual
// IndexedDB sweep that loads meetings, runs `applyRetention`, and writes
// the result back lives in `database.ts` (`database.enforceRetention`)
// so that the pure logic remains trivially property-testable.
//
// Acceptance criteria covered:
//
//   - 16.5 — "THE persistence layer SHALL apply background retention
//     rules (default: meetings older than 365 days deleted, transcripts
//     truncated to 50 000 lines per meeting) configurable via Settings."
//
// Property covered:
//
//   - 48: Retention rules eliminate overdue records.

import type { StoredMeeting } from './database';

/** Number of milliseconds in one day. */
const DAY_MS = 86_400_000;

/** Default retention parameters mandated by Requirement 16.5. */
export const DEFAULT_MEETING_MAX_AGE_DAYS = 365;
export const DEFAULT_TRANSCRIPT_MAX_LINES = 50_000;

/**
 * Options accepted by {@link applyRetention} and (transitively) by
 * `database.enforceRetention`. The `now` field exists primarily so the
 * background sweep, the property test, and the Settings UI preview all
 * reference the same notion of "now"; it defaults to `Date.now()` when
 * omitted.
 */
export interface RetentionOptions {
  /**
   * Maximum age (in days) of a meeting's `startedAt` before it is
   * considered overdue and removed. Comparison uses *strict greater
   * than* on `(now - startedAt)` to match Property 48's wording.
   */
  maxAgeDays: number;

  /**
   * Maximum number of transcript lines retained per meeting. Meetings
   * with more lines are returned with their transcript truncated to the
   * most-recent `maxLines` entries. Negative or fractional values are
   * clamped to a non-negative integer floor; `maxLines === 0` empties
   * every transcript.
   */
  maxLines: number;

  /** Reference time for age comparison; defaults to `Date.now()`. */
  now?: number;
}

/**
 * Snapshot retention sweep.
 *
 * Given an array of meetings and a retention configuration, return a
 * new array (no mutation of inputs) in which:
 *
 *   1. No meeting `m` satisfies `(now - m.startedAt) > maxAgeDays * 86_400_000`.
 *   2. Every retained meeting's `transcript` has length `≤ maxLines`.
 *   3. Every meeting from the input whose `(now - startedAt)` is `≤
 *      maxAgeDays * 86_400_000` appears in the output (i.e. retention
 *      never drops a meeting that still falls inside the age window).
 *   4. Order of retained meetings is preserved.
 *
 * Truncation keeps the *most-recent* transcript lines (the suffix of
 * the array) on the assumption that callers append in chronological
 * order. The implementation does not inspect line timestamps because
 * the property test treats `transcript` as opaque — we only need to
 * guarantee the length bound.
 */
export function applyRetention(
  meetings: readonly StoredMeeting[],
  opts: RetentionOptions,
): StoredMeeting[] {
  const now = opts.now ?? Date.now();

  // Use raw arithmetic on the cutoff, then compare against `startedAt`
  // with strict inequality to mirror Property 48 exactly:
  //
  //   (now - startedAt) > maxAgeDays * DAY_MS    ⇔    startedAt < cutoff
  //
  // Computing `cutoff` once avoids per-meeting multiplication.
  const cutoff = now - opts.maxAgeDays * DAY_MS;

  // Clamp `maxLines` to a non-negative integer so a caller cannot wedge
  // the sweep with `Infinity`, `NaN`, or a negative value. `Math.floor`
  // preserves any reasonable integer input unchanged.
  const maxLines =
    Number.isFinite(opts.maxLines) && opts.maxLines > 0
      ? Math.floor(opts.maxLines)
      : 0;

  const result: StoredMeeting[] = [];
  for (const meeting of meetings) {
    // Age check first — overdue meetings are not transformed at all.
    if (meeting.startedAt < cutoff) continue;

    const transcript = meeting.transcript;
    if (transcript.length <= maxLines) {
      // Already within the line budget — pass the original reference
      // through. `applyRetention` is non-mutating, so sharing the
      // reference is safe.
      result.push(meeting);
    } else {
      // Keep the most-recent `maxLines` entries. `Array.prototype.slice`
      // returns a shallow copy and never mutates the source.
      result.push({
        ...meeting,
        transcript: transcript.slice(transcript.length - maxLines),
      });
    }
  }
  return result;
}

/**
 * Compute the diff between an input snapshot and the post-retention
 * snapshot. Used by `database.enforceRetention` to know which IDs to
 * `delete` and which to `put` back. Pure / unit-testable.
 */
export function diffRetention(
  before: readonly StoredMeeting[],
  after: readonly StoredMeeting[],
): { deletedIds: string[]; truncatedMeetings: StoredMeeting[] } {
  const afterById = new Map<string, StoredMeeting>();
  for (const m of after) afterById.set(m.id, m);

  const deletedIds: string[] = [];
  const truncatedMeetings: StoredMeeting[] = [];

  for (const original of before) {
    const kept = afterById.get(original.id);
    if (!kept) {
      deletedIds.push(original.id);
      continue;
    }
    // Reference inequality is enough because `applyRetention` only
    // allocates a new object when truncation actually happens.
    if (kept !== original) truncatedMeetings.push(kept);
  }

  return { deletedIds, truncatedMeetings };
}
