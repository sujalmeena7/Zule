// ============================================
// Zule AI — Transcription types
// ============================================
//
// Canonical transcript-line shape produced by `Transcription_Engine`
// (see design.md §Components and Interfaces > 1. Transcription_Engine).
//
// The schema invariants enforced by Property 5 (`Every transcript line
// satisfies the schema invariant`) are encoded here:
//
//   * `speakerRole` is strictly `'user' | 'other'`. The audit defect in
//     which a `speaker-1` id was written into a `speakerRole`-typed field
//     (defeating the Question_Detector's user-speech short-circuit) is
//     prevented at the type level (Requirements 3.2, 3.7).
//   * `detection` is restricted to a closed set of methods.
//   * `provider` is restricted to the supported transcription back-ends.

/**
 * Strict speaker role. `speakerId` (e.g. `speaker-1`, `speaker-2`) is
 * carried separately so that classification methods can re-attribute
 * audio without losing the user/other partition.
 */
export type SpeakerRole = 'user' | 'other';

/** How the speaker for a given line was determined. */
export type DetectionMethod = 'manual' | 'gap-heuristic' | 'voiceprint';

/** Transcription back-end that produced a line. */
export type TranscriptionProvider = 'web-speech' | 'local-whisper';

export interface TranscriptionLine {
  /** Unique id within a session. */
  id: string;
  /** Recognised text (post-confidence-filter for finals). */
  text: string;
  /** Epoch milliseconds at which the line was emitted. */
  timestamp: number;
  /** True for interim/partial results, false for finals. */
  isInterim: boolean;
  /** Stable speaker identifier within the session, e.g. `'speaker-1'`. */
  speakerId: string;
  /** Strict `'user' | 'other'` partition; gates Question_Detector. */
  speakerRole: SpeakerRole;
  /** Method used to assign `speakerId`/`speakerRole`. */
  detection: DetectionMethod;
  /** Confidence in the detection assignment, in [0, 1]. */
  detectionConfidence: number;
  /** ASR confidence as reported by the provider, in [0, 1]. */
  asrConfidence: number;
  /** BCP-47 language tag (e.g. `'en-US'`). */
  language: string;
  /** Transcription back-end that produced this line. */
  provider: TranscriptionProvider;
  /**
   * Hint emitted by the engine when a likely speaker change was observed
   * (e.g. via the gap heuristic) but not yet committed.
   */
  possibleSpeakerChange?: boolean;
}
