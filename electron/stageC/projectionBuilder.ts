/**
 * Stage C — Projection Builder
 *
 * Builds safe OverlayProjection snapshots from canonical overlay state,
 * computes incremental patches (diffs between revisions), and increments
 * revision numbers monotonically.
 *
 * The projection NEVER contains:
 * - Provider credentials
 * - Raw audio data
 * - Screenshot bytes
 * - Unrestricted filesystem paths
 * - Service handles
 * - Database values
 *
 * Requirements: 8.1–8.6, 8.9
 */

import type { DipRectangle, OverlayMode } from './protocol/schema';
import type { OverlayProjection, OverlayPatch } from './protocol/projection';

// ────────────────────────────────────────────────────────────────────
// Canonical State Interface
// ────────────────────────────────────────────────────────────────────

/**
 * The canonical overlay state owned solely by App Core.
 * This is the authoritative source; the sidecar only receives projections.
 */
export interface CanonicalOverlayState {
  visible: boolean;
  mode: OverlayMode;
  bounds_dip: DipRectangle;
  capture_protection: boolean;
  /** Whether system audio transcription is active. */
  isSystemAudioActive: boolean;
  /** Whether the AI is currently loading a response. */
  isLoading: boolean;
  /** Whether the AI is currently streaming a response. */
  isStreaming: boolean;
  /** In-progress streaming text (projected as-is; no raw audio/credentials). */
  streamingText: string;
  /** Completed AI response (text + suggestions only; no provider credentials). */
  aiResponse: {
    text: string;
    suggestions: string[];
    followUps: string[];
  } | null;
  /** Current input text. */
  inputText: string;
  /** Elapsed time in seconds since session start. */
  elapsedTime: number;
}

// ────────────────────────────────────────────────────────────────────
// Sensitive data patterns to redact
// ────────────────────────────────────────────────────────────────────

/** Keys that must never appear in projected render state. */
const REDACTED_KEYS: ReadonlySet<string> = new Set([
  'apiKey',
  'api_key',
  'credential',
  'credentials',
  'token',
  'access_token',
  'refresh_token',
  'secret',
  'password',
  'rawAudio',
  'raw_audio',
  'audioBuffer',
  'audio_buffer',
  'screenshotBytes',
  'screenshot_bytes',
  'screenshotData',
  'screenshot_data',
  'imageData',
  'image_data',
  'filePath',
  'file_path',
  'absolutePath',
  'absolute_path',
  'databaseUrl',
  'database_url',
  'connectionString',
  'connection_string',
  'serviceHandle',
  'service_handle',
  'dbValue',
  'db_value',
]);

// ────────────────────────────────────────────────────────────────────
// Projection Builder
// ────────────────────────────────────────────────────────────────────

export class ProjectionBuilder {
  /** Current monotonically increasing revision. */
  private revision = 0;

  /** Previous projected state for patch computation. */
  private lastProjectedState: CanonicalOverlayState | null = null;

  /** Get the current revision number. */
  getRevision(): number {
    return this.revision;
  }

  /**
   * Build a full snapshot projection from canonical state.
   * Increments the revision and stores state for future patch computation.
   */
  buildSnapshot(state: CanonicalOverlayState): OverlayProjection {
    this.revision++;
    this.lastProjectedState = { ...state };

    const renderState = buildSafeRenderState(state);

    return {
      revision: this.revision,
      visibility_requested: state.visible,
      bounds_dip: { ...state.bounds_dip },
      mode: state.mode,
      capture_protection: state.capture_protection,
      render_state: renderState,
    };
  }

  /**
   * Build an incremental patch from the previous projected state to the current state.
   * Only includes fields that changed. Increments the revision.
   *
   * Returns null if no changes detected (no patch needed).
   */
  buildPatch(state: CanonicalOverlayState): OverlayPatch | null {
    if (this.lastProjectedState === null) {
      // No previous state; a full snapshot should be sent first.
      return null;
    }

    const baseRevision = this.revision;
    const prev = this.lastProjectedState;

    // Detect changes
    const patch: Partial<Omit<OverlayPatch, 'base_revision' | 'next_revision'>> = {};
    let hasChanges = false;

    if (state.visible !== prev.visible) {
      patch.visibility_requested = state.visible;
      hasChanges = true;
    }

    if (state.mode !== prev.mode) {
      patch.mode = state.mode;
      hasChanges = true;
    }

    if (
      state.bounds_dip.left !== prev.bounds_dip.left ||
      state.bounds_dip.top !== prev.bounds_dip.top ||
      state.bounds_dip.width !== prev.bounds_dip.width ||
      state.bounds_dip.height !== prev.bounds_dip.height
    ) {
      patch.bounds_dip = { ...state.bounds_dip };
      hasChanges = true;
    }

    if (state.capture_protection !== prev.capture_protection) {
      patch.capture_protection = state.capture_protection;
      hasChanges = true;
    }

    // Check render state differences
    const renderStatePatch = buildRenderStatePatch(prev, state);
    if (renderStatePatch !== null) {
      patch.render_state_patch = renderStatePatch;
      hasChanges = true;
    }

    if (!hasChanges) {
      return null;
    }

    // Increment revision
    this.revision++;
    this.lastProjectedState = { ...state };

    return {
      base_revision: baseRevision,
      next_revision: this.revision,
      ...patch,
    };
  }

  /**
   * Reset projection state (e.g., on reconnect).
   * The next projection must be a full snapshot.
   */
  reset(): void {
    this.lastProjectedState = null;
    // Revision is NOT reset — it continues monotonically.
  }
}

// ────────────────────────────────────────────────────────────────────
// Safe Render State Builders
// ────────────────────────────────────────────────────────────────────

/**
 * Build a safe render_state Record from canonical state.
 * Strips all sensitive fields and includes only projection-safe data.
 */
export function buildSafeRenderState(state: CanonicalOverlayState): Record<string, unknown> {
  const renderState: Record<string, unknown> = {
    visible: state.visible,
    mode: state.mode,
    captureProtection: state.capture_protection,
    isSystemAudioActive: state.isSystemAudioActive,
    isLoading: state.isLoading,
    isStreaming: state.isStreaming,
    streamingText: state.streamingText,
    inputText: state.inputText,
    elapsedTime: state.elapsedTime,
  };

  if (state.aiResponse !== null) {
    renderState.aiResponse = {
      text: state.aiResponse.text,
      suggestions: [...state.aiResponse.suggestions],
      followUps: [...state.aiResponse.followUps],
    };
  } else {
    renderState.aiResponse = null;
  }

  return renderState;
}

/**
 * Build a partial render_state patch containing only changed fields.
 * Returns null if no render state fields changed.
 */
function buildRenderStatePatch(
  prev: CanonicalOverlayState,
  curr: CanonicalOverlayState,
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  let hasChanges = false;

  if (curr.isSystemAudioActive !== prev.isSystemAudioActive) {
    patch.isSystemAudioActive = curr.isSystemAudioActive;
    hasChanges = true;
  }
  if (curr.isLoading !== prev.isLoading) {
    patch.isLoading = curr.isLoading;
    hasChanges = true;
  }
  if (curr.isStreaming !== prev.isStreaming) {
    patch.isStreaming = curr.isStreaming;
    hasChanges = true;
  }
  if (curr.streamingText !== prev.streamingText) {
    patch.streamingText = curr.streamingText;
    hasChanges = true;
  }
  if (curr.inputText !== prev.inputText) {
    patch.inputText = curr.inputText;
    hasChanges = true;
  }
  if (curr.elapsedTime !== prev.elapsedTime) {
    patch.elapsedTime = curr.elapsedTime;
    hasChanges = true;
  }

  // AI response comparison
  const prevResp = prev.aiResponse;
  const currResp = curr.aiResponse;
  if (prevResp === null && currResp !== null) {
    patch.aiResponse = {
      text: currResp.text,
      suggestions: [...currResp.suggestions],
      followUps: [...currResp.followUps],
    };
    hasChanges = true;
  } else if (prevResp !== null && currResp === null) {
    patch.aiResponse = null;
    hasChanges = true;
  } else if (prevResp !== null && currResp !== null) {
    if (
      prevResp.text !== currResp.text ||
      JSON.stringify(prevResp.suggestions) !== JSON.stringify(currResp.suggestions) ||
      JSON.stringify(prevResp.followUps) !== JSON.stringify(currResp.followUps)
    ) {
      patch.aiResponse = {
        text: currResp.text,
        suggestions: [...currResp.suggestions],
        followUps: [...currResp.followUps],
      };
      hasChanges = true;
    }
  }

  return hasChanges ? patch : null;
}

/**
 * Validate that a render state object does not contain any redacted keys.
 * Returns true if the object is safe to project, false if any forbidden key is found.
 */
export function isRenderStateSafe(obj: Record<string, unknown>): boolean {
  return !containsRedactedKey(obj);
}

/**
 * Recursively checks for redacted keys in a nested object.
 */
function containsRedactedKey(obj: unknown): boolean {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }

  if (Array.isArray(obj)) {
    return obj.some(containsRedactedKey);
  }

  for (const key of Object.keys(obj)) {
    if (REDACTED_KEYS.has(key)) {
      return true;
    }
    if (containsRedactedKey((obj as Record<string, unknown>)[key])) {
      return true;
    }
  }

  return false;
}
