// ============================================
// Zule AI — Screen Context Guard
// ============================================
//
// Enforces frame freshness and context isolation for screen-context requests:
//   - Frame used for context must be captured at or after the Use_Screen_Action
//     invocation time (Property 10 / Req 8.1)
//   - Screen_Text must be derived from a frame captured strictly after the
//     previous request's frame (Property 11 / Req 8.2)
//   - Superseded request context must not leak to newer requests
//     (Property 12 / Req 8.3)
//   - Both modalities reported through modalitiesUsed when both present (Req 8.4)

import type { OcrEntry } from '../hooks/useScreenCapture';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScreenContextRequest {
  /** Monotonically increasing request counter for superseded-request detection. */
  requestId: number;
  /** Timestamp (epoch ms) when Use_Screen_Action was invoked. */
  invocationTimestamp: number;
}

export interface ScreenContextResult {
  /** Filtered screen text (only from fresh frames). Empty string if none qualifies. */
  screenText: string;
  /** The timestamp of the frame used for this request's screen text (or null). */
  frameTimestamp: number | null;
  /** Whether the request was superseded before context could be applied. */
  superseded: boolean;
}

export type ScreenModality = 'keyframe' | 'screenText';

// ---------------------------------------------------------------------------
// ScreenContextGuard
// ---------------------------------------------------------------------------

/**
 * Stateful guard that enforces frame freshness and cross-request isolation.
 *
 * One instance is shared per session. It tracks:
 *   - The last-used frame timestamp (for cross-request freshness, Req 8.2)
 *   - The current active request ID (for superseded-request detection, Req 8.3)
 */
export class ScreenContextGuard {
  /** Timestamp of the frame used by the most recently completed request. */
  private _lastUsedFrameTimestamp: number = 0;

  /** Request ID of the most recently initiated request. */
  private _activeRequestId: number = 0;

  /**
   * The last-used frame timestamp. Exposed for testing.
   */
  get lastUsedFrameTimestamp(): number {
    return this._lastUsedFrameTimestamp;
  }

  /**
   * The active request ID. Exposed for testing.
   */
  get activeRequestId(): number {
    return this._activeRequestId;
  }

  /**
   * Begin a new screen-context request. Marks this request as the active one,
   * superseding any previously active request.
   *
   * @returns A ScreenContextRequest object with the request's invocation timestamp.
   */
  beginRequest(requestId: number): ScreenContextRequest {
    this._activeRequestId = requestId;
    return {
      requestId,
      invocationTimestamp: Date.now(),
    };
  }

  /**
   * Select the freshest valid screen text from the ring buffer for a given request.
   *
   * Filtering rules:
   *   1. Only entries captured at or after the invocation timestamp (Req 8.1)
   *   2. Only entries captured strictly after the previous request's frame (Req 8.2)
   *   3. If the request has been superseded (a newer request arrived), the
   *      result is marked as superseded and should not be applied (Req 8.3)
   *
   * @param request The current screen context request (from beginRequest)
   * @param ringBuffer The recent OCR ring buffer entries
   * @returns The freshest valid screen text and metadata
   */
  selectFreshText(
    request: ScreenContextRequest,
    ringBuffer: readonly OcrEntry[],
  ): ScreenContextResult {
    // Check if this request has been superseded (Req 8.3)
    if (this._activeRequestId !== request.requestId) {
      return { screenText: '', frameTimestamp: null, superseded: true };
    }

    // Filter entries to only those that satisfy freshness constraints
    const validEntries = ringBuffer.filter((entry) => {
      // Req 8.1: Frame must be captured at or after invocation time
      if (entry.timestamp < request.invocationTimestamp) return false;
      // Req 8.2: Frame must be captured strictly after previous request's frame
      if (entry.timestamp <= this._lastUsedFrameTimestamp) return false;
      return true;
    });

    if (validEntries.length === 0) {
      return { screenText: '', frameTimestamp: null, superseded: false };
    }

    // Use the most recent valid entry (freshest available)
    const freshest = validEntries.reduce((a, b) =>
      b.timestamp > a.timestamp ? b : a,
    );

    return {
      screenText: freshest.text,
      frameTimestamp: freshest.timestamp,
      superseded: false,
    };
  }

  /**
   * Select the freshest valid screen text using only the current screenText ref
   * and a timestamp indicating when it was captured.
   *
   * This is used when the ring buffer isn't directly available but the caller
   * has a current text value with an associated capture timestamp.
   *
   * @param request The current screen context request
   * @param text The current screen text
   * @param capturedAt Epoch ms when this text's frame was captured
   * @returns The screen text result
   */
  selectFreshTextDirect(
    request: ScreenContextRequest,
    text: string,
    capturedAt: number,
  ): ScreenContextResult {
    // Check if this request has been superseded (Req 8.3)
    if (this._activeRequestId !== request.requestId) {
      return { screenText: '', frameTimestamp: null, superseded: true };
    }

    // Req 8.1: Frame must be captured at or after invocation time
    if (capturedAt < request.invocationTimestamp) {
      return { screenText: '', frameTimestamp: null, superseded: false };
    }

    // Req 8.2: Frame must be captured strictly after previous request's frame
    if (capturedAt <= this._lastUsedFrameTimestamp) {
      return { screenText: '', frameTimestamp: null, superseded: false };
    }

    return { screenText: text, frameTimestamp: capturedAt, superseded: false };
  }

  /**
   * Commit the frame timestamp for a completed request. This advances the
   * "last used frame" watermark so subsequent requests cannot reuse this frame.
   *
   * Only call this after the request context has been successfully dispatched.
   *
   * @param frameTimestamp The timestamp of the frame used for the completed request
   */
  commitFrame(frameTimestamp: number): void {
    if (frameTimestamp > this._lastUsedFrameTimestamp) {
      this._lastUsedFrameTimestamp = frameTimestamp;
    }
  }

  /**
   * Check whether a request has been superseded.
   *
   * @param requestId The request ID to check
   * @returns true if a newer request has been initiated
   */
  isSuperseded(requestId: number): boolean {
    return this._activeRequestId !== requestId;
  }

  /**
   * Determine which screen modalities are present for a request.
   * Reports both 'keyframe' and 'screenText' when both are attached (Req 8.4).
   *
   * @param hasKeyframe Whether a keyframe image was attached
   * @param hasScreenText Whether OCR screen text was attached
   * @returns Array of screen modalities present
   */
  reportModalities(
    hasKeyframe: boolean,
    hasScreenText: boolean,
  ): ScreenModality[] {
    const modalities: ScreenModality[] = [];
    if (hasKeyframe) modalities.push('keyframe');
    if (hasScreenText) modalities.push('screenText');
    return modalities;
  }

  /**
   * Reset the guard state. Called when a session ends or for testing.
   */
  reset(): void {
    this._lastUsedFrameTimestamp = 0;
    this._activeRequestId = 0;
  }
}
