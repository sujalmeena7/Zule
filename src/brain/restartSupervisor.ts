// ============================================
// Zule AI — RestartSupervisor (bounded restart state machine)
// ============================================
//
// Event-driven supervisor used by the Transcription_Engine to bound restart
// loops (Requirement 1.3, 20.3): after five consecutive restart attempts
// inside a 60-second sliding window without an intervening final
// transcription result or external reset, the supervisor enters the `paused`
// state and refuses to issue further restart delays. The user can resume by
// calling `reset()`.
//
// Property 2 (validates Requirements 1.3, 20.3) compares this implementation
// against an independent naive simulation oracle in restartSupervisor.test.ts.
//
// Semantics notes:
// - A `restart` event whose timestamp is not strictly greater than the most
//   recent clearing event (final / reset) does not count toward the threshold.
//   This makes the supervisor robust to events whose timestamps arrive
//   slightly out of order.
// - Once paused the supervisor LATCHES until `reset()` is called. Final
//   transcription results do not silently un-pause an explicitly paused
//   supervisor — that requires a deliberate user resume (Requirement 1.3:
//   "pause auto-restart until the User resumes").

import { restartBackoff } from './backoff';

export type RestartSupervisorState = 'ready' | 'paused';

export type RestartDecision =
  | {
      readonly state: 'ready';
      /** 1-based count of consecutive restarts since the last clearing event. */
      readonly attempt: number;
      /** Backoff delay returned by `restartBackoff(attempt - 1)`. */
      readonly delayMs: number;
    }
  | { readonly state: 'paused'; readonly attempt: number };

export interface RestartSupervisorOptions {
  /** Returns the current wall-clock time in ms. Defaults to `Date.now`. */
  now?: () => number;
  /** Threshold count, default 5. */
  maxRestartsInWindow?: number;
  /** Sliding-window length in ms, default 60 000. */
  windowMs?: number;
  /** Backoff formula. Defaults to `restartBackoff`. */
  backoff?: (attempt: number) => number;
}

const DEFAULT_MAX_RESTARTS = 5;
const DEFAULT_WINDOW_MS = 60_000;

export class RestartSupervisor {
  private _state: RestartSupervisorState = 'ready';
  /** Sorted ascending; only timestamps strictly greater than `lastClearAt`. */
  private restartTimes: number[] = [];
  private lastClearAt: number = Number.NEGATIVE_INFINITY;

  private readonly nowFn: () => number;
  private readonly maxInWindow: number;
  private readonly windowMs: number;
  private readonly backoffFn: (attempt: number) => number;

  constructor(opts: RestartSupervisorOptions = {}) {
    this.nowFn = opts.now ?? Date.now;
    this.maxInWindow = opts.maxRestartsInWindow ?? DEFAULT_MAX_RESTARTS;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.backoffFn = opts.backoff ?? restartBackoff;
  }

  /** Current state. */
  get state(): RestartSupervisorState {
    return this._state;
  }

  /** Number of valid (uncleared) restarts currently being tracked. */
  get attemptCount(): number {
    return this.restartTimes.length;
  }

  /**
   * Register a restart event. Returns the decision for the engine to act on:
   * `{ state: 'ready', attempt, delayMs }` to delay-and-restart, or
   * `{ state: 'paused', attempt }` to surface a recoverable error and wait
   * for `reset()`.
   */
  recordRestart(t?: number): RestartDecision {
    if (this._state === 'paused') {
      return { state: 'paused', attempt: this.restartTimes.length };
    }
    const time = t ?? this.nowFn();
    if (time > this.lastClearAt) {
      this.insertSorted(time);
    }
    if (this.checkPauseCondition()) {
      this._state = 'paused';
      return { state: 'paused', attempt: this.restartTimes.length };
    }
    const attempt = this.restartTimes.length; // 1-based
    return {
      state: 'ready',
      attempt,
      delayMs: this.backoffFn(attempt - 1),
    };
  }

  /**
   * Register that the engine produced a final transcription result. Clears
   * any tracked restart timestamps at or before `t`. No-op while paused so
   * that a stale final from before the pause does not silently resume the
   * supervisor.
   */
  recordFinal(t?: number): void {
    if (this._state === 'paused') return;
    const time = t ?? this.nowFn();
    if (time > this.lastClearAt) {
      this.lastClearAt = time;
      this.dropClearedRestarts();
    }
  }

  /**
   * External resume. Always transitions to `ready`, advances the clear
   * watermark to `t`, and drops any restart timestamps at or before `t`.
   * Use this when the user clicks "Resume" after a recoverable-error toast.
   */
  reset(t?: number): void {
    const time = t ?? this.nowFn();
    this._state = 'ready';
    if (time > this.lastClearAt) this.lastClearAt = time;
    this.dropClearedRestarts();
  }

  // ---- internals ----

  private insertSorted(t: number): void {
    let idx = this.restartTimes.length;
    while (idx > 0 && this.restartTimes[idx - 1] > t) idx--;
    this.restartTimes.splice(idx, 0, t);
  }

  private dropClearedRestarts(): void {
    if (this.restartTimes.length === 0) return;
    this.restartTimes = this.restartTimes.filter((rt) => rt > this.lastClearAt);
  }

  private checkPauseCondition(): boolean {
    const n = this.maxInWindow;
    if (this.restartTimes.length < n) return false;
    for (let i = 0; i + n - 1 < this.restartTimes.length; i++) {
      if (this.restartTimes[i + n - 1] - this.restartTimes[i] <= this.windowMs) {
        return true;
      }
    }
    return false;
  }
}
