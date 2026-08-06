/**
 * Stage C — Capture Fallback and Layer 0 Parity
 *
 * Implements the fallback sequence when Stage C capture protection fails:
 * 1. Hide/close Stage C floating surface FIRST (Req 12.7, 13.8)
 * 2. Apply the same current capture-protection value on Layer 0 (Req 12.8)
 * 3. Verify Layer 0 capture state (Req 12.8)
 * 4. Show Layer 0 (restore usability within 500ms) (Req 12.6, 13.8)
 *
 * Never modifies Dashboard's capture behavior (Req 12.11).
 * Reports typed degradation without capture-impossibility claims (Req 12.12).
 *
 * Requirements: 12.6–12.12, 13.8–13.12
 */

// ────────────────────────────────────────────────────────────────────
// Fallback Status Types
// ────────────────────────────────────────────────────────────────────

/**
 * Typed degradation status for capture fallback.
 * Describes observed state, never claims capture impossibility (Req 12.12).
 */
export enum CaptureFallbackStatus {
  /** Layer 0 recovered with correct capture state verified. */
  FALLBACK_COMPLETE = 'FALLBACK_COMPLETE',

  /** Layer 0 shown but capture state could not be verified within deadline. */
  FALLBACK_PARTIAL = 'FALLBACK_PARTIAL',

  /** Exceeded 500ms recovery deadline; Layer 0 still shown for usability. */
  RECOVERY_TIMEOUT = 'RECOVERY_TIMEOUT',
}

// ────────────────────────────────────────────────────────────────────
// Result Type
// ────────────────────────────────────────────────────────────────────

/**
 * Structured result of a capture fallback operation.
 * Reports observed state without impossibility claims (Req 12.12).
 */
export interface CaptureFallbackResult {
  /** Outcome status of the fallback sequence. */
  status: CaptureFallbackStatus;

  /** Elapsed time in milliseconds for the entire recovery. */
  recoveryMs: number;

  /** Whether the requested capture value was applied to Layer 0. */
  captureValueApplied: boolean;

  /** Whether Layer 0 is visible after fallback. */
  layer0Visible: boolean;
}

// ────────────────────────────────────────────────────────────────────
// Dependency Interface (for testability)
// ────────────────────────────────────────────────────────────────────

/**
 * Injected dependencies for the capture fallback sequence.
 * Each operation is isolated so unit tests can control and verify ordering.
 */
export interface CaptureFallbackDeps {
  /**
   * Hide or close the Stage C floating surface.
   * Must complete before Layer 0 is shown (Req 12.7, 13.8).
   * Returns true if Stage C is hidden/closed successfully.
   */
  hideStageC(): boolean;

  /**
   * Show Layer 0 to restore overlay usability.
   * Returns true if Layer 0 is now visible.
   */
  showLayer0(): boolean;

  /**
   * Apply capture protection value on Layer 0.
   * Maps the boolean value to the appropriate WDA constant.
   * Returns true if the apply operation succeeded.
   */
  applyLayer0Capture(enabled: boolean): boolean;

  /**
   * Verify Layer 0 has the expected capture protection state.
   * Returns true if the read-back matches the expected value.
   */
  verifyLayer0Capture(enabled: boolean): boolean;

  /**
   * Get the user's last-requested capture protection value.
   * This is the canonical value that both Stage C and Layer 0 should match.
   */
  getRequestedCaptureValue(): boolean;
}

/**
 * Clock abstraction for testability of timing constraints.
 */
export interface FallbackClock {
  /** Returns current time in milliseconds (monotonic). */
  now(): number;
}

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

/**
 * Maximum allowed time for the entire fallback recovery sequence (Req 12.6, 13.8).
 * Layer 0 must be usable within this deadline.
 */
export const RECOVERY_DEADLINE_MS = 500;

// ────────────────────────────────────────────────────────────────────
// Default Clock
// ────────────────────────────────────────────────────────────────────

/** Default clock using performance.now() for monotonic timing. */
export const DEFAULT_FALLBACK_CLOCK: FallbackClock = {
  now: () => performance.now(),
};

// ────────────────────────────────────────────────────────────────────
// Core Implementation
// ────────────────────────────────────────────────────────────────────

/**
 * Execute the capture fallback sequence when Stage C capture protection fails.
 *
 * Sequence (Req 12.6–12.9, 13.8–13.12):
 * 1. Hide/close Stage C floating surface FIRST
 * 2. Apply the same current capture-protection value on Layer 0
 * 3. Verify Layer 0 capture state
 * 4. Show Layer 0 (restore usability)
 *
 * The fallback NEVER modifies Dashboard capture behavior (Req 12.11).
 * The result describes observed degradation state, never claims
 * capture impossibility (Req 12.12).
 *
 * @param deps - Injectable dependencies for each step
 * @param clock - Clock for measuring elapsed time
 * @returns Typed result with status, timing, and state
 */
export function executeCaptureFallback(
  deps: CaptureFallbackDeps,
  clock: FallbackClock = DEFAULT_FALLBACK_CLOCK,
): CaptureFallbackResult {
  const startTime = clock.now();

  // Step 1: Hide/close Stage C FIRST (Req 12.7, 13.8)
  // This ensures no mismatched Stage C surface is ever visible
  deps.hideStageC();

  // Step 2: Get the user's requested capture value for Layer 0 parity
  const requestedValue = deps.getRequestedCaptureValue();

  // Step 3: Apply capture protection on Layer 0 (Req 12.8)
  const applySuccess = deps.applyLayer0Capture(requestedValue);

  // Check deadline before verification
  const afterApplyMs = clock.now() - startTime;
  if (afterApplyMs >= RECOVERY_DEADLINE_MS) {
    // Deadline exceeded — still show Layer 0 for usability (Req 12.6)
    deps.showLayer0();
    return {
      status: CaptureFallbackStatus.RECOVERY_TIMEOUT,
      recoveryMs: clock.now() - startTime,
      captureValueApplied: applySuccess,
      layer0Visible: true,
    };
  }

  // Step 4: Verify Layer 0 capture state (Req 12.8)
  let verified = false;
  if (applySuccess) {
    verified = deps.verifyLayer0Capture(requestedValue);
  }

  // Check deadline after verification
  const afterVerifyMs = clock.now() - startTime;
  if (afterVerifyMs >= RECOVERY_DEADLINE_MS) {
    // Deadline exceeded during verification — still show Layer 0 (Req 12.6)
    deps.showLayer0();
    return {
      status: CaptureFallbackStatus.RECOVERY_TIMEOUT,
      recoveryMs: clock.now() - startTime,
      captureValueApplied: applySuccess,
      layer0Visible: true,
    };
  }

  // Step 5: Show Layer 0 (Req 12.6, 13.8)
  const showSuccess = deps.showLayer0();

  const totalMs = clock.now() - startTime;

  // Determine final status
  if (totalMs >= RECOVERY_DEADLINE_MS) {
    // Show itself caused deadline to be exceeded
    return {
      status: CaptureFallbackStatus.RECOVERY_TIMEOUT,
      recoveryMs: totalMs,
      captureValueApplied: applySuccess,
      layer0Visible: showSuccess,
    };
  }

  if (applySuccess && verified) {
    // Full success: Layer 0 has correct capture state, verified (Req 12.8)
    return {
      status: CaptureFallbackStatus.FALLBACK_COMPLETE,
      recoveryMs: totalMs,
      captureValueApplied: true,
      layer0Visible: showSuccess,
    };
  }

  // Partial: Layer 0 shown but capture state unverified (Req 12.9)
  return {
    status: CaptureFallbackStatus.FALLBACK_PARTIAL,
    recoveryMs: totalMs,
    captureValueApplied: applySuccess,
    layer0Visible: showSuccess,
  };
}
