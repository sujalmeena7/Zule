// ============================================
// Zule AI — Cross-window sync types
// ============================================
//
// Canonical message and state shapes exchanged between the host page and
// the detached copilot window (see design.md §Components and Interfaces
// > 14. Cross_Window_Sync v2).
//
// The design replaces the audit-flagged `payload: any` shape with a
// monotonically-versioned discriminated union so receivers can reject
// stale `state-update` messages, request snapshots on open, and
// detect host loss via heartbeats (Requirements 11.1 – 11.7).

import type { AIResponse } from '../brain/aiProvider';
import type { CopilotMode } from '../brain/modePrompts';

import type { TranscriptionLine } from './transcription';

/**
 * Coaching metrics surfaced to the detached window. Structurally matches
 * the existing `SentimentResult` and the `CoachingMetrics` interface
 * defined in design.md §Components and Interfaces > 6. Coaching_Module;
 * the `Coaching_Module` refactor (task 12.1) will expose this type from
 * `src/brain/coaching.ts` and this declaration can become a re-export.
 */
export interface CoachingMetrics {
  sentiment: 'positive' | 'negative' | 'neutral';
  /** -1..1 */
  score: number;
  fillerCount: number;
  fillerWords: string[];
  wordsPerMinute: number;
  /** 0..100 */
  confidenceScore: number;
}

/** Modalities that contributed to the most-recent prompt assembly. */
export type Modality = 'audio' | 'screen' | 'knowledge' | 'memory';

/**
 * Actions originated by the detached window and forwarded to the host
 * via a `host-action` `SyncMessage`. The shape is an open discriminated
 * union so additional client-originated commands can be added without
 * breaking existing receivers.
 */
export type ClientAction =
  | { kind: 'manual-submit'; text: string }
  | { kind: 'stop-session' }
  | { kind: 'change-mode'; mode: CopilotMode }
  | { kind: 'set-active-speaker'; speakerId: string }
  | { kind: 'request-snapshot' };

/**
 * The shared session state replicated from host to detached window. The
 * host owns the canonical copy; the detached window receives snapshots
 * and incremental `state-update` messages.
 */
export interface SyncState {
  isDetached: boolean;
  transcript: TranscriptionLine[];
  interimText: string;
  streamingText: string;
  aiResponse: AIResponse | null;
  isLoading: boolean;
  isStreaming: boolean;
  /** Seconds since the active session began. */
  elapsedTime: number;
  coaching: CoachingMetrics | null;
  activeMode: CopilotMode;
  modalitiesUsed: Modality[];
}

/**
 * The full set of messages exchanged on the `BroadcastChannel`
 * (or `localStorage`-event fallback when `BroadcastChannel` is
 * unavailable, Requirement 11.4). `version` is monotonically
 * non-decreasing per sender; receivers reject `state-update` messages
 * whose `version` is below the most-recently-applied version
 * (Requirement 11.1).
 */
export type SyncMessage =
  | { kind: 'state-update'; version: number; payload: SyncState }
  | { kind: 'snapshot-request'; version: number }
  | { kind: 'snapshot-response'; version: number; payload: SyncState }
  | { kind: 'heartbeat'; version: number; timestamp: number }
  | { kind: 'host-action'; version: number; action: ClientAction };

/** The discriminator key for `SyncMessage` variants. */
export type SyncMessageKind = SyncMessage['kind'];
