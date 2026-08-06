/**
 * Stage C Overlay — Bridge Type Definitions
 *
 * Defines the `window.zuleOverlay` adapter contract that the Stage C overlay
 * consumes for state projection and intent emission. These types mirror the
 * reviewed ZuleOverlayBridge interface from the design document.
 *
 * Requirements: 7.1–7.3, 7.11, 8.1–8.7
 */

import type { OverlayMode } from '../../overlay/useOverlayMode';

// ────────────────────────────────────────────────────────────────────
// State Projection (sidecar → overlay)
// ────────────────────────────────────────────────────────────────────

/** DIP rectangle matching the protocol schema. */
export interface DipRectangle {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Render state projected from App Core canonical state. */
export interface OverlayRenderState {
  /** Whether the overlay is visible. */
  visible: boolean;
  /** Current overlay mode: compact, expanded, or maximized. */
  mode: OverlayMode;
  /** Whether screen-capture protection is currently active. */
  captureProtection: boolean;
  /** Whether system audio transcription is active. */
  isSystemAudioActive: boolean;
  /** Whether the AI is currently loading a response. */
  isLoading: boolean;
  /** Whether the AI is currently streaming a response. */
  isStreaming: boolean;
  /** In-progress streaming text. */
  streamingText: string;
  /** Completed AI response (null when none). */
  aiResponse: {
    text: string;
    suggestions: string[];
    followUps: string[];
    isSimulated?: boolean;
  } | null;
  /** Current input text (synced from App Core). */
  inputText: string;
  /** Elapsed time in seconds since session start. */
  elapsedTime: number;
}

/** Complete state snapshot from App Core. */
export interface OverlayStateSnapshot {
  revision: number;
  bounds_dip: DipRectangle;
  render_state: OverlayRenderState;
}

/** Incremental state patch from App Core. */
export interface OverlayStatePatch {
  base_revision: number;
  next_revision: number;
  render_state_patch?: Partial<OverlayRenderState>;
  mode?: OverlayMode;
  bounds_dip?: DipRectangle;
}

/** Operation result from App Core after an intent is processed. */
export interface OperationResult {
  operation_id: string;
  success: boolean;
  error_code?: string;
  data?: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────────────
// Intents (overlay → sidecar)
// ────────────────────────────────────────────────────────────────────

/** Allowed overlay actions the user can trigger. */
export type OverlayAction =
  | { type: 'toggle-mode' }
  | { type: 'toggle-maximize' }
  | { type: 'set-mode'; mode: OverlayMode }
  | { type: 'toggle-visibility' }
  | { type: 'stop-session' }
  | { type: 'toggle-stealth'; enabled: boolean }
  | { type: 'set-input'; text: string }
  | { type: 'submit-input'; text: string };

/** Allowed AI actions the user can trigger. */
export type AIAction =
  | { type: 'trigger'; query?: string }
  | { type: 'stop-generation' }
  | { type: 'follow-up'; text: string };

/** Allowed audio actions the user can trigger. */
export type AudioAction =
  | { type: 'toggle-system-audio' };

/** Allowed screen-capture actions the user can trigger. */
export type ScreenCaptureAction =
  | { type: 'use-screen' };

// ────────────────────────────────────────────────────────────────────
// Drag/Interactive Region Reporting
// ────────────────────────────────────────────────────────────────────

/** A DIP rectangle region for hit-testing. */
export interface RegionRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// ────────────────────────────────────────────────────────────────────
// Bridge Interface (frozen on window.zuleOverlay)
// ────────────────────────────────────────────────────────────────────

/**
 * The frozen `window.zuleOverlay` adapter. This is the ONLY interface
 * between the Stage C overlay page and the native sidecar bridge.
 *
 * Requirements: 7.1–7.3, 7.10
 */
export interface ZuleOverlayBridge {
  // --- Intent Methods (overlay → sidecar) ---
  requestOverlayAction(action: OverlayAction): void;
  requestAI(action: AIAction): void;
  requestAudio(action: AudioAction): void;
  requestScreenCapture(action: ScreenCaptureAction): void;
  reportDragRegions(revision: number, regions: RegionRect[]): void;
  reportInteractiveRegions(revision: number, regions: RegionRect[]): void;

  // --- State Events (sidecar → overlay) ---
  onStateSnapshot(callback: (snapshot: OverlayStateSnapshot) => void): void;
  onStatePatch(callback: (patch: OverlayStatePatch) => void): void;
  onOperationResult(callback: (result: OperationResult) => void): void;
}

// ────────────────────────────────────────────────────────────────────
// Global augmentation
// ────────────────────────────────────────────────────────────────────

declare global {
  interface Window {
    zuleOverlay?: ZuleOverlayBridge;
  }
}
