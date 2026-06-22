// ============================================
// Zule AI — Voice Activity Detector (renderer-side, pure)
// ============================================
//
// Energy-based VAD gate inserted between PCM capture and the
// `whisper:transcribe` IPC for the loopback
// (`useSystemAudioTranscription`) and microphone (`WhisperProvider`)
// pipelines. The module is pure: no React, no IPC, no logging, no I/O —
// `scoreChunk` is a deterministic function of its inputs.
//
// Algorithm (mirrors design.md §"VAD Module"):
//   1. Reject `pcm.length === 0` and any sample outside [-2, 2]
//      (catches NaN / Infinity / corrupt buffers; the
//      `whisper:transcribe` IPC contract is [-1, 1] Float32) →
//      `{ score: 0, isSpeech: false }`.
//   2. Compute per-frame RMS over disjoint 30-ms frames
//      (`frameSize = 480` samples at 16 kHz).
//   3. score = clamp(median(rms_frames) / SPEECH_FLOOR, 0, 1)
//      with SPEECH_FLOOR = 0.02.
//   4. isSpeech = score >= cfg.speechThreshold.
//
// Validates: Requirements 5.1, 5.2, 5.3, 6.1, 6.2, 7.3, 7.6.

/**
 * Empirically-derived RMS amplitude above which `whisper-base.en`
 * consistently emits real text on the reference machine. The median
 * frame RMS is divided by this floor to normalise into a `[0, 1]`
 * score.
 */
export const SPEECH_FLOOR = 0.02;

/**
 * Default frame size = 480 samples = 30 ms at 16 kHz.
 */
export const DEFAULT_FRAME_SIZE = 480;

/**
 * Sensitivity → speechThreshold mapping. `medium` = 0.35 matches the
 * project's documented default speech threshold so existing users see
 * consistent behaviour on first upgrade (Requirement 7.6).
 */
const SENSITIVITY_TABLE = {
  low: 0.2,
  medium: 0.35,
  high: 0.55,
} as const;

/** The three discrete sensitivity levels exposed in Settings (Req 7.1). */
export type VADSensitivity = keyof typeof SENSITIVITY_TABLE;

/**
 * Map a sensitivity level to its `speechThreshold` value.
 *
 * Used by both pipelines on `start` and on every `vadSensitivityBus`
 * change event (tasks 9.1 / 10.1) so that the renderer-side gate is
 * configured directly from the persisted setting.
 */
export function mapSensitivityToThreshold(level: VADSensitivity): number {
  return SENSITIVITY_TABLE[level];
}

export interface VADConfig {
  /** Speech score threshold in [0,1]. Chunks with score ≥ threshold are speech. */
  speechThreshold: number;
  /** Frame size in samples (default 480 = 30 ms @ 16 kHz). */
  frameSize?: number;
  /** Hysteresis: number of consecutive speech frames required to flip to speech. */
  hangoverFrames?: number;
}

export interface VADResult {
  /** Speech probability in [0,1] (NaN is never returned). */
  score: number;
  /** True iff `score >= config.speechThreshold`. */
  isSpeech: boolean;
}

/**
 * Test-only kill-switch honoured by `scoreChunk` callers (the loopback
 * and microphone pipelines wired in tasks 9.1 / 10.1). When
 * `enabled === true`, callers SHOULD bypass the gate entirely and
 * forward every chunk to `whisper:transcribe`. The flag exists so the
 * existing `useSystemAudioTranscription` integration tests
 * (Requirement 9.3 — "with the VAD gate disabled or set to a
 * permissive threshold under test") keep their assertions.
 *
 * Exported as a mutable singleton object (rather than a top-level `let`)
 * so tests can flip the gate at run-time without re-importing the
 * module:
 *
 * ```ts
 * import { VAD_DISABLE_FOR_TEST } from './vad';
 * VAD_DISABLE_FOR_TEST.enabled = true;
 * ```
 *
 * `scoreChunk` itself ignores this flag — gating is the caller's job —
 * so the function stays a pure mathematical helper that the property
 * tests can drive directly.
 */
export const VAD_DISABLE_FOR_TEST: { enabled: boolean } = { enabled: false };

/** Internal: clamp `x` to the closed interval `[lo, hi]`. */
function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/**
 * Internal: RMS amplitude of a contiguous slice of `pcm` starting at
 * `start` and `len` samples long. Caller guarantees `len >= 1`.
 */
function rmsOf(pcm: Float32Array, start: number, len: number): number {
  let sumSq = 0;
  const end = start + len;
  for (let i = start; i < end; i++) {
    const s = pcm[i];
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / len);
}

/**
 * Internal: median of a non-empty list of numbers.
 *
 * The median is more robust than the mean against single-frame click
 * artefacts (design.md §"VAD Module" step 4). For an empty input we
 * return 0 — `scoreChunk` never invokes this with an empty list, but
 * the guard keeps the helper well-defined.
 */
function median(values: readonly number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (n % 2 === 1) return sorted[(n - 1) >> 1];
  return (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/**
 * Score a 16 kHz mono Float32 PCM chunk for speech presence.
 *
 * Returns `{ score: 0, isSpeech: false }` when:
 *   - `pcm.length === 0` (Requirement 5.2 / 6.2 — no work on empty buffers)
 *   - any sample is outside the closed interval `[-2, 2]` (this catches
 *     `NaN`, `±Infinity`, and corrupt buffers from a misbehaving capture
 *     path; the `whisper:transcribe` IPC contract is `[-1, 1]`).
 *
 * Otherwise:
 *   1. Splits `pcm` into disjoint frames of `cfg.frameSize` samples
 *      (default 480 = 30 ms @ 16 kHz). When `pcm` is shorter than a
 *      single frame, the whole buffer is treated as one frame so the
 *      function stays well-defined for short inputs.
 *   2. Computes the RMS amplitude of each frame.
 *   3. Returns `score = clamp(median(rms_frames) / SPEECH_FLOOR, 0, 1)`
 *      and `isSpeech = score >= cfg.speechThreshold`.
 *
 * Pure and deterministic. Allocates one small `number[]` for the frame
 * RMS values and one sorted copy inside `median`; nothing per-sample.
 */
export function scoreChunk(pcm: Float32Array, cfg: VADConfig): VADResult {
  // Guard 1: empty buffer.
  if (pcm.length === 0) {
    return { score: 0, isSpeech: false };
  }

  // Guard 2: out-of-range samples (NaN, Infinity, corrupt buffers).
  // NaN comparisons always return `false`, so the in-range predicate
  // `s >= -2 && s <= 2` is negated rather than written as `s < -2 ||
  // s > 2` — the latter would silently let NaN through.
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i];
    if (!(s >= -2 && s <= 2)) {
      return { score: 0, isSpeech: false };
    }
  }

  // Per-frame RMS over disjoint 30-ms frames at 16 kHz.
  const frameSize =
    cfg.frameSize !== undefined && cfg.frameSize > 0
      ? Math.floor(cfg.frameSize)
      : DEFAULT_FRAME_SIZE;
  const fullFrames = Math.floor(pcm.length / frameSize);
  const rmsFrames: number[] = [];

  if (fullFrames === 0) {
    // pcm shorter than a single frame — treat the whole buffer as one
    // frame so the score stays a meaningful number rather than 0.
    rmsFrames.push(rmsOf(pcm, 0, pcm.length));
  } else {
    for (let f = 0; f < fullFrames; f++) {
      rmsFrames.push(rmsOf(pcm, f * frameSize, frameSize));
    }
  }

  const score = clamp(median(rmsFrames) / SPEECH_FLOOR, 0, 1);
  return { score, isSpeech: score >= cfg.speechThreshold };
}
