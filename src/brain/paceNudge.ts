// ============================================
// Zule AI — Coaching_Module: PaceNudgeMachine
// ============================================
//
// Companion to `coaching.ts`. The pure `getFullAnalysis` function exposes a
// per-tick snapshot of `wordsPerMinute`; this module turns a sequence of those
// snapshots into a non-blocking visual nudge whenever the user's pace has been
// out of band ("too slow" or "too fast") for at least 15 s of *user* speech.
//
// Design references:
//   - Requirement 9.4: "WHEN computed pace falls below 90 wpm or rises above
//     180 wpm for at least 15 seconds of User speech, THE Coaching_Module
//     SHALL surface a non-blocking visual nudge."
//   - design.md §"Coaching_Module" — sustained sub-90 or super-180 WPM for
//     ≥ 15 s of user speech transitions to `nudge`.
//   - design.md Property 27 — "the orchestrator enters the 'nudge' state if
//     and only if the sequence contains a sustained sub-sequence of length
//     covering at least 15 s in which every sample is below 90 or every
//     sample is above 180." Reset on band switch follows from the
//     "sustained sub-sequence" wording: a single in-band sample, or a
//     switch from the slow band to the fast band, breaks the run.
//
// The state machine is deliberately tiny so that orchestration code (the
// `Copilot_Engine`) can `tick(wpm, dtMs)` it once per coaching update and
// surface the returned `state` directly.

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/** The three possible classifications for a single WPM sample. */
export type PaceBand = 'slow' | 'normal' | 'fast';

/** The two possible exposed states. */
export type PaceNudgeState = 'normal' | 'nudge';

/**
 * Why the machine is in the `nudge` state, or `null` when the state is
 * `normal`. The caller uses this to choose the surface message ("speak up"
 * vs. "slow down").
 */
export type PaceNudgeReason = 'too-slow' | 'too-fast' | null;

export interface PaceNudgeTickResult {
  state: PaceNudgeState;
  reason: PaceNudgeReason;
}

export interface PaceNudgeMachineOptions {
  /** Ticks with `wpm < slowThresholdWpm` are classified as `slow`. Default 90. */
  slowThresholdWpm?: number;
  /** Ticks with `wpm > fastThresholdWpm` are classified as `fast`. Default 180. */
  fastThresholdWpm?: number;
  /**
   * Cumulative user-speech duration that must be sustained inside a single
   * out-of-band run before the machine transitions to `nudge`. Default 15 000 ms.
   */
  sustainedMs?: number;
}

// ----------------------------------------------------------------------------
// Pure helpers
// ----------------------------------------------------------------------------

/**
 * Classify a single WPM sample into one of the three pace bands. Non-finite
 * WPM samples (NaN, ±Infinity) are treated as `normal` so that one bad
 * coaching snapshot does not artificially trip the nudge.
 */
export function classifyBand(
  wpm: number,
  slowThreshold: number,
  fastThreshold: number,
): PaceBand {
  if (!Number.isFinite(wpm)) return 'normal';
  if (wpm < slowThreshold) return 'slow';
  if (wpm > fastThreshold) return 'fast';
  return 'normal';
}

// ----------------------------------------------------------------------------
// PaceNudgeMachine
// ----------------------------------------------------------------------------

/**
 * Tracks contiguous user-speech duration in a single out-of-band run and
 * exposes a `nudge` state once that run reaches `sustainedMs`. The machine
 * carries only its current band and accumulator; transitions are pure with
 * respect to `(wpm, dtMs)` and the prior internal state.
 *
 * Behavioural rules (encoded by `tick`):
 *   - When the new sample's band differs from the current run's band, the
 *     accumulator resets. If the new band is `normal`, the accumulator goes
 *     to 0 (nothing to track). If the new band is `slow` or `fast`, the
 *     accumulator restarts at the tick's own `dtMs` so that the new run is
 *     timed from this sample onward.
 *   - When the new sample's band equals the current run's band:
 *     - `normal`: accumulator stays at 0 (in-band time is irrelevant).
 *     - `slow`/`fast`: accumulator increments by `dtMs`.
 *   - The machine returns `nudge` only while the current band is `slow` or
 *     `fast` *and* the accumulator is `≥ sustainedMs`. Falling back into the
 *     `normal` band, or switching from `slow` to `fast` (or vice-versa),
 *     re-clears the state because the run that triggered the nudge has
 *     ended.
 *
 * `dtMs` represents the cumulative duration during which the user was the
 * active speaker since the previous tick; the caller is responsible for
 * filtering out non-user speech (Requirement 9.3). Negative or non-finite
 * `dtMs` values are coerced to 0.
 */
export class PaceNudgeMachine {
  private readonly slowThreshold: number;
  private readonly fastThreshold: number;
  private readonly sustainedMs: number;

  private currentBand: PaceBand = 'normal';
  private accumulatedMs = 0;

  constructor(opts: PaceNudgeMachineOptions = {}) {
    const slow = opts.slowThresholdWpm ?? 90;
    const fast = opts.fastThresholdWpm ?? 180;
    const sustained = opts.sustainedMs ?? 15_000;
    if (!(slow < fast)) {
      throw new RangeError(
        `PaceNudgeMachine: slowThresholdWpm (${slow}) must be < fastThresholdWpm (${fast})`,
      );
    }
    if (!Number.isFinite(sustained) || sustained < 0) {
      throw new RangeError(
        `PaceNudgeMachine: sustainedMs must be a non-negative finite number, got ${sustained}`,
      );
    }
    this.slowThreshold = slow;
    this.fastThreshold = fast;
    this.sustainedMs = sustained;
  }

  /**
   * Advance the machine by one coaching snapshot.
   *
   * @param wpm                                Current user words-per-minute.
   * @param userSpeakingDurationMsSinceLastTick Cumulative milliseconds during
   *   which the user was the active speaker since the previous `tick` call.
   *   Negative or non-finite values are treated as 0.
   * @returns                                 The new exposed state and reason.
   */
  tick(
    wpm: number,
    userSpeakingDurationMsSinceLastTick: number,
  ): PaceNudgeTickResult {
    const dt =
      Number.isFinite(userSpeakingDurationMsSinceLastTick) &&
      userSpeakingDurationMsSinceLastTick > 0
        ? userSpeakingDurationMsSinceLastTick
        : 0;
    const newBand = classifyBand(wpm, this.slowThreshold, this.fastThreshold);

    if (newBand !== this.currentBand) {
      // Band switched — the previous run is over, the new run starts now.
      // Entering `normal` zeroes the accumulator (no run to time); entering
      // an out-of-band starts the run with the current tick's duration.
      this.currentBand = newBand;
      this.accumulatedMs = newBand === 'normal' ? 0 : dt;
    } else if (newBand === 'normal') {
      // In-band time does not contribute to either run.
      this.accumulatedMs = 0;
    } else {
      // Continuation of the current out-of-band run.
      this.accumulatedMs += dt;
    }

    const isNudge =
      (this.currentBand === 'slow' || this.currentBand === 'fast') &&
      this.accumulatedMs >= this.sustainedMs;

    return {
      state: isNudge ? 'nudge' : 'normal',
      reason: isNudge
        ? this.currentBand === 'slow'
          ? 'too-slow'
          : 'too-fast'
        : null,
    };
  }

  /**
   * Reset the machine to its initial state. Useful when the user manually
   * pauses the session or the active speaker changes from `user` to `other`
   * for an extended period.
   */
  reset(): void {
    this.currentBand = 'normal';
    this.accumulatedMs = 0;
  }

  // ---- Inspection (read-only; intended for tests and diagnostics) --------

  /** The band classification of the most recent tick. */
  get band(): PaceBand {
    return this.currentBand;
  }

  /** Cumulative user-speech ms inside the current out-of-band run. */
  get accumulated(): number {
    return this.accumulatedMs;
  }

  /** Configured slow threshold (exclusive). */
  get slowThresholdWpm(): number {
    return this.slowThreshold;
  }

  /** Configured fast threshold (exclusive). */
  get fastThresholdWpm(): number {
    return this.fastThreshold;
  }

  /** Configured sustained duration in milliseconds. */
  get sustainedThresholdMs(): number {
    return this.sustainedMs;
  }
}
