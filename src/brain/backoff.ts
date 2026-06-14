// ============================================
// Zule AI — restartBackoff
// ============================================
//
// Pure helper used by the Transcription_Engine restart supervisor (and, soon,
// by the AI_Provider_Router retry loop) to compute exponential-backoff delays.
// Implements Requirement 1.2:
//
//     delay = min(8000, 250 * 2 ** k)
//
// where `k` is the consecutive-restart counter (0-indexed). The first restart
// waits 250 ms, the second 500 ms, then 1 000, 2 000, 4 000, and from the
// sixth restart onwards the delay is capped at 8 000 ms.
//
// Property 1 (validates Requirements 1.2, 4.5) checks that for every
// non-negative integer `k` the result equals `min(8000, 250 * 2 ** k)` and
// that the function is monotonically non-decreasing.

/** Cap on the backoff delay, in milliseconds. Per Requirement 1.2. */
export const RESTART_BACKOFF_MAX_MS = 8_000;

/** Initial delay (k = 0), in milliseconds. Per Requirement 1.2. */
export const RESTART_BACKOFF_INITIAL_MS = 250;

/** Doubling factor. Per Requirement 1.2. */
export const RESTART_BACKOFF_FACTOR = 2;

/**
 * Returns the delay, in milliseconds, before restart attempt index `k`
 * (0-indexed):
 *
 *     min(8000, 250 * 2 ** k)
 *
 * - `k === 0` →   250 ms (initial delay)
 * - `k === 1` →   500 ms
 * - `k === 2` → 1 000 ms
 * - `k === 3` → 2 000 ms
 * - `k === 4` → 4 000 ms
 * - `k >= 5`  → 8 000 ms (cap)
 *
 * The function is total over `number`. It is intended to receive non-negative
 * integers (the consecutive-restart counter); for very large `k` the
 * `2 ** k` term overflows to `Infinity`, which the `Math.min` cap handles
 * cleanly so the result is still 8 000 ms.
 */
export function restartBackoff(attempt: number): number {
  return Math.min(
    RESTART_BACKOFF_MAX_MS,
    RESTART_BACKOFF_INITIAL_MS * RESTART_BACKOFF_FACTOR ** attempt,
  );
}
