// ============================================
// Zule AI — Speaker_Module (per-session)
// ============================================
//
// `SpeakerManager` is a per-session class with no module-level mutable
// state. The orchestrator constructs a fresh instance at the start of
// every Active_Session so no diarization state leaks between meetings
// (Requirement 3.1).
//
// Audit defect remediated by this module:
//
//   The previous implementation wrote `speakerProfile.id` (e.g.
//   `'speaker-1'`) into a transcript-line field typed as
//   `'user' | 'other'`. The Question_Detector's check
//   `if (latestLine.speaker === 'user') return null;` therefore never
//   short-circuited and the assistant fired on the user's own speech
//   (Requirement 3.2). We fix that here at the type level by carrying
//   `speakerId` and `speakerRole` as two strictly separated fields, and
//   by making every classification helper emit both.
//
// References:
//   - design.md §Components and Interfaces > 2. Speaker_Module
//   - requirements.md Requirements 3.1, 3.2, 3.4, 3.5, 3.6, 3.7
//   - tasks.md Task 13.1
//
// A module-level `speakerManager` singleton is retained as a backward-
// compatibility shim for consumers (`FloatingCopilot`,
// `useSpeechRecognition`, `TranscriptPanel`) that have not yet been
// migrated to the per-session pattern. New code MUST construct its own
// instance; the singleton is deprecated and will be removed when those
// consumers move to `useTranscription` (task 14.x).

import type { DetectionMethod, SpeakerRole } from '../types/transcription';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A speaker profile. The strict `role` partition (`'user' | 'other'`)
 * is carried alongside the stable `id` so that classification helpers
 * can re-attribute audio without collapsing the user/other partition.
 */
export interface SpeakerProfile {
  /** Stable id within the session, e.g. `'speaker-1'`. */
  id: string;
  /** Display name. */
  name: string;
  /** CSS background or gradient for the avatar. */
  color: string;
  /** Single-character avatar label. */
  avatarInitial: string;
  /** Strict `'user' | 'other'` partition. */
  role: SpeakerRole;
}

/** Classification result returned by `classifyByGap`. */
export interface GapClassification {
  /** Speaker id assigned to this segment. */
  id: string;
  /** Speaker role assigned to this segment. */
  role: SpeakerRole;
  /** How the assignment was made. */
  method: 'manual' | 'gap-heuristic';
  /** Confidence in the assignment, in [0, 1]. */
  confidence: number;
  /** True when a silence gap > 2000 ms was observed (Requirement 3.6). */
  possibleSpeakerChange: boolean;
}

/** Classification result returned by `classifyByVoiceprint`. */
export interface VoiceprintClassification {
  /** Speaker id assigned (manual fallback if confidence < 0.55). */
  id: string;
  /** Speaker role assigned. */
  role: SpeakerRole;
  /** How the assignment was made. */
  method: DetectionMethod;
  /** Voiceprint confidence as reported by the embedding model, in [0, 1]. */
  confidence: number;
}

/** Raw output of a voiceprint embedding classifier. */
export interface VoiceprintGuess {
  id: string;
  confidence: number;
}

/**
 * Pluggable voiceprint classifier. Default implementation always
 * returns the active speaker with confidence 0 so that the manager
 * always falls back to manual assignment until a real voiceprint
 * pipeline is wired in (task 14.x).
 */
export type VoiceprintClassifier = (
  audio: Float32Array,
) => Promise<VoiceprintGuess> | VoiceprintGuess;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Confidence floor for trusting voiceprint diarization. Below this we
 * fall back to the most-recent manual assignment (Requirement 3.5).
 */
export const VOICEPRINT_CONFIDENCE_THRESHOLD = 0.55;

/**
 * Silence gap that flags a possible speaker change when voiceprint
 * diarization is disabled (Requirement 3.6).
 */
export const SPEAKER_GAP_MS = 2000;

const DEFAULT_PROFILES: SpeakerProfile[] = [
  {
    id: 'speaker-1',
    name: 'You',
    color: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
    avatarInitial: 'Y',
    role: 'user',
  },
  {
    id: 'speaker-2',
    name: 'Speaker 2',
    color: 'linear-gradient(135deg, #ec4899, #f43f5e)',
    avatarInitial: 'S',
    role: 'other',
  },
  {
    id: 'speaker-3',
    name: 'Speaker 3',
    color: 'linear-gradient(135deg, #22c55e, #14b8a6)',
    avatarInitial: 'S',
    role: 'other',
  },
  {
    id: 'speaker-4',
    name: 'Speaker 4',
    color: 'linear-gradient(135deg, #f59e0b, #ef4444)',
    avatarInitial: 'S',
    role: 'other',
  },
];

/** Returns a fresh deep copy of the default profiles. */
export function getDefaultSpeakerProfiles(): SpeakerProfile[] {
  return DEFAULT_PROFILES.map((p) => ({ ...p }));
}

// ---------------------------------------------------------------------------
// SpeakerManager
// ---------------------------------------------------------------------------

const STUB_VOICEPRINT: VoiceprintClassifier = () => ({
  id: '',
  // 0 < 0.55 always, so the manager always falls back to manual
  // until a real voiceprint pipeline is plugged in (task 14.x).
  confidence: 0,
});

/**
 * Per-session speaker manager. No module-level mutable state.
 */
export class SpeakerManager {
  private readonly speakers: Map<string, SpeakerProfile>;
  private activeSpeakerId: string;
  /** History of `setActive` invocations, oldest first. */
  private readonly toggleHistory: Array<{ speakerId: string; at: number }>;
  /** Most recent `classifyByGap` timestamp, or `null` if never invoked. */
  private lastSpokenAt: number | null;
  private readonly voiceprintClassifier: VoiceprintClassifier;

  constructor(opts?: {
    profiles?: SpeakerProfile[];
    voiceprintClassifier?: VoiceprintClassifier;
    initialActiveId?: string;
    /** Clock used to stamp `toggleHistory`. Injectable for tests. */
    now?: () => number;
  }) {
    const profiles = opts?.profiles ?? getDefaultSpeakerProfiles();
    if (profiles.length === 0) {
      throw new Error('SpeakerManager requires at least one profile');
    }
    this.speakers = new Map(profiles.map((p) => [p.id, { ...p }]));

    // Default active id: the first 'other'-role speaker if present,
    // else the first profile. This matches the prior behaviour of
    // starting attribution on the remote participant.
    const fallbackActive =
      profiles.find((p) => p.role === 'other')?.id ?? profiles[0].id;
    const requested = opts?.initialActiveId;
    this.activeSpeakerId =
      requested && this.speakers.has(requested) ? requested : fallbackActive;

    this.voiceprintClassifier =
      opts?.voiceprintClassifier ?? STUB_VOICEPRINT;
    this.lastSpokenAt = null;
    const clockNow = opts?.now ?? (() => Date.now());
    this.toggleHistory = [
      { speakerId: this.activeSpeakerId, at: clockNow() },
    ];
  }

  // -------------------------------------------------------------------------
  // Profile access
  // -------------------------------------------------------------------------

  /** Returns the profile for `id`, or `null` if unknown. */
  getProfile(id: string): SpeakerProfile | null {
    const p = this.speakers.get(id);
    return p ? { ...p } : null;
  }

  /** Returns all known profiles in insertion order. */
  getAllProfiles(): SpeakerProfile[] {
    return Array.from(this.speakers.values()).map((p) => ({ ...p }));
  }

  /** Updates a profile's display fields; the role is immutable. */
  updateProfile(
    id: string,
    updates: Partial<Omit<SpeakerProfile, 'id' | 'role'>>,
  ): void {
    const existing = this.speakers.get(id);
    if (!existing) return;
    this.speakers.set(id, { ...existing, ...updates });
  }

  // -------------------------------------------------------------------------
  // Active speaker
  // -------------------------------------------------------------------------

  /** Returns the currently active speaker profile. */
  getActive(): SpeakerProfile {
    // The invariant is upheld in the constructor and in `setActive`.
    return { ...this.speakers.get(this.activeSpeakerId)! };
  }

  /**
   * Sets the active speaker. Unknown ids are ignored. Toggle history is
   * appended in invocation order so subsequent transcript lines can be
   * attributed to the most-recent toggle (Requirement 3.4, Property 7).
   */
  setActive(speakerId: string, opts?: { now?: () => number }): void {
    if (!this.speakers.has(speakerId)) return;
    if (this.activeSpeakerId === speakerId) {
      // Still record the toggle so callers can audit identical-active
      // toggles from the UI; the property test only depends on the
      // most-recent entry being the most-recent setActive value.
    }
    this.activeSpeakerId = speakerId;
    const at = (opts?.now ?? (() => Date.now()))();
    this.toggleHistory.push({ speakerId, at });
  }

  /**
   * Returns the toggle history, oldest first. The first entry is always
   * the constructor's initial assignment.
   */
  getToggleHistory(): Array<{ speakerId: string; at: number }> {
    return this.toggleHistory.map((entry) => ({ ...entry }));
  }

  // -------------------------------------------------------------------------
  // Classification
  // -------------------------------------------------------------------------

  /**
   * Returns a gap-based classification for the line being emitted at
   * `now` (Requirement 3.6). When `now - lastSpokenAt > 2000 ms`, the
   * `possibleSpeakerChange` hint is set; the speaker id itself is not
   * automatically toggled because the design defers that decision to
   * the UI / voiceprint module.
   */
  classifyByGap(now: number): GapClassification {
    const previous = this.lastSpokenAt;
    this.lastSpokenAt = now;
    const gap = previous === null ? 0 : Math.max(0, now - previous);
    const possibleChange = gap > SPEAKER_GAP_MS;
    const active = this.getActive();
    return {
      id: active.id,
      role: active.role,
      method: possibleChange ? 'gap-heuristic' : 'manual',
      // Manual assignment is fully trusted; the gap heuristic is a hint
      // only, so we report a low confidence to flag the uncertainty.
      confidence: possibleChange ? 0.4 : 1.0,
      possibleSpeakerChange: possibleChange,
    };
  }

  /**
   * Classifies a final line via voiceprint. When the configured
   * classifier returns confidence below {@link VOICEPRINT_CONFIDENCE_THRESHOLD}
   * the manager falls back to the most-recent manual assignment and the
   * returned `method` is `'manual'` (Requirement 3.5, Property 8). The
   * returned confidence is the raw classifier confidence in either
   * branch so that telemetry can record the observed value.
   */
  async classifyByVoiceprint(
    audio: Float32Array,
  ): Promise<VoiceprintClassification> {
    const guess = await this.voiceprintClassifier(audio);
    const candidate = this.speakers.get(guess.id);
    if (
      candidate &&
      Number.isFinite(guess.confidence) &&
      guess.confidence >= VOICEPRINT_CONFIDENCE_THRESHOLD
    ) {
      return {
        id: candidate.id,
        role: candidate.role,
        method: 'voiceprint',
        confidence: clamp01(guess.confidence),
      };
    }
    const active = this.getActive();
    return {
      id: active.id,
      role: active.role,
      method: 'manual',
      confidence: clamp01(Number.isFinite(guess.confidence) ? guess.confidence : 0),
    };
  }

  // -------------------------------------------------------------------------
  // Backward-compatible aliases (deprecated)
  // -------------------------------------------------------------------------
  // Existing consumers (`FloatingCopilot`, `useSpeechRecognition`,
  // `TranscriptPanel`) call `getSpeaker`, `getActiveSpeaker`,
  // `setActiveSpeaker`, `updateSpeaker`, and `checkPossibleSpeakerChange`
  // on the module singleton. These are retained as thin shims while
  // those consumers migrate to the per-session pattern in tasks 14.x.

  /** @deprecated Use `getProfile` instead. */
  getSpeaker(id: string): SpeakerProfile {
    return (
      this.getProfile(id) ??
      this.getProfile('speaker-2') ??
      this.getActive()
    );
  }

  /** @deprecated Use `getAllProfiles` instead. */
  getAllSpeakers(): SpeakerProfile[] {
    return this.getAllProfiles();
  }

  /** @deprecated Use `getActive` instead. */
  getActiveSpeaker(): SpeakerProfile {
    return this.getActive();
  }

  /** @deprecated Use `setActive` instead. */
  setActiveSpeaker(id: string): void {
    this.setActive(id);
  }

  /** @deprecated Use `updateProfile` instead. */
  updateSpeaker(
    id: string,
    updates: Partial<Omit<SpeakerProfile, 'id' | 'role'>>,
  ): void {
    this.updateProfile(id, updates);
  }

  /**
   * @deprecated Use `classifyByGap` instead. Returns whether the gap
   * heuristic would have flagged a possible speaker change at the time
   * of invocation, side-effecting `lastSpokenAt`.
   */
  checkPossibleSpeakerChange(now: number = Date.now()): boolean {
    return this.classifyByGap(now).possibleSpeakerChange;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

// ---------------------------------------------------------------------------
// Backward-compatibility singleton (deprecated)
// ---------------------------------------------------------------------------

/**
 * @deprecated Module-level singleton retained only so that
 * `FloatingCopilot`, `useSpeechRecognition`, and `TranscriptPanel`
 * keep compiling during the incremental migration. New code MUST
 * construct its own `SpeakerManager` per-session per Requirement 3.1.
 */
export const speakerManager = new SpeakerManager();
