/**
 * Stage C Release Gate — Capture-Fallback Gate.
 *
 * Verifies that when capture-related failures are injected, the system
 * falls back to Layer 0 within 500 ms with zero intervals where both
 * surfaces remain hidden beyond that deadline.
 *
 * Requirement 17.14: Inject application failure, read-back failure,
 * read-back mismatch, and read-back timeout with Layer_0 usable within
 * 500 milliseconds and zero intervals in which both surfaces remain
 * hidden beyond that deadline.
 */

import { type EnvironmentMatrixRow, type GateResultRecord, ReleaseGateId } from '../types';

// ────────────────────────────────────────────────────────────────────
// Gate Thresholds (Req 17.14)
// ────────────────────────────────────────────────────────────────────

/** Maximum time for Layer 0 to become usable after failure injection (ms). */
export const MAX_LAYER0_RECOVERY_MS = 500;

/** Maximum allowed intervals where both surfaces are hidden beyond the deadline. */
export const MAX_BOTH_HIDDEN_INTERVALS = 0;

/** Capture failure types that must be injected and tested. */
export const REQUIRED_CAPTURE_FAILURE_TYPES: readonly string[] = [
  'application_failure',
  'readback_failure',
  'readback_mismatch',
  'readback_timeout',
] as const;

// ────────────────────────────────────────────────────────────────────
// Capture-Fallback Gate Dependencies (injectable for testing)
// ────────────────────────────────────────────────────────────────────

/**
 * Result from a single capture failure injection test.
 */
export interface CaptureFailureInjectionResult {
  /** The failure type that was injected. */
  readonly failureType: string;

  /** Whether Layer 0 became usable after injection. */
  readonly layer0Usable: boolean;

  /** Time in milliseconds until Layer 0 was usable. */
  readonly layer0RecoveryMs: number;

  /** Number of intervals where both surfaces were hidden beyond the deadline. */
  readonly bothHiddenIntervals: number;
}

/**
 * Injectable dependency interface for the capture-fallback gate.
 */
export interface CaptureFallbackGateDeps {
  /**
   * Inject a capture failure of the given type and measure recovery.
   * Returns the injection result including Layer 0 recovery time.
   */
  injectCaptureFailure(failureType: string): Promise<CaptureFailureInjectionResult>;
}

// ────────────────────────────────────────────────────────────────────
// Gate Execution
// ────────────────────────────────────────────────────────────────────

interface CaptureFallbackGateMetrics {
  totalInjections: number;
  maxLayer0RecoveryMs: number;
  layer0Failures: number;
  totalBothHiddenIntervals: number;
  failures: string[];
}

/**
 * Executes the capture-fallback gate for a given environment row.
 *
 * Requirement 17.14: Inject all required capture failure types. Layer 0
 * must be usable within 500 ms. Zero intervals where both surfaces are
 * hidden beyond the 500 ms deadline.
 */
export async function executeCaptureFallbackGate(
  row: EnvironmentMatrixRow,
  deps: CaptureFallbackGateDeps,
  buildHash: string,
  appVersion: string,
  sidecarVersion: string,
): Promise<GateResultRecord> {
  const metrics: CaptureFallbackGateMetrics = {
    totalInjections: 0,
    maxLayer0RecoveryMs: 0,
    layer0Failures: 0,
    totalBothHiddenIntervals: 0,
    failures: [],
  };

  for (const failureType of REQUIRED_CAPTURE_FAILURE_TYPES) {
    const result = await deps.injectCaptureFailure(failureType);
    metrics.totalInjections++;

    if (result.layer0RecoveryMs > metrics.maxLayer0RecoveryMs) {
      metrics.maxLayer0RecoveryMs = result.layer0RecoveryMs;
    }

    if (!result.layer0Usable) {
      metrics.layer0Failures++;
      metrics.failures.push(
        `Failure type '${failureType}': Layer 0 did not become usable`,
      );
    } else if (result.layer0RecoveryMs > MAX_LAYER0_RECOVERY_MS) {
      metrics.failures.push(
        `Failure type '${failureType}': Layer 0 recovery took ${result.layer0RecoveryMs}ms (max: ${MAX_LAYER0_RECOVERY_MS}ms)`,
      );
    }

    if (result.bothHiddenIntervals > MAX_BOTH_HIDDEN_INTERVALS) {
      metrics.totalBothHiddenIntervals += result.bothHiddenIntervals;
      metrics.failures.push(
        `Failure type '${failureType}': ${result.bothHiddenIntervals} intervals with both surfaces hidden beyond deadline`,
      );
    }
  }

  // Verify all failure types were tested
  if (metrics.totalInjections < REQUIRED_CAPTURE_FAILURE_TYPES.length) {
    metrics.failures.push(
      `Only ${metrics.totalInjections}/${REQUIRED_CAPTURE_FAILURE_TYPES.length} capture failure types tested`,
    );
  }

  const verdict = metrics.failures.length === 0 ? 'pass' : 'fail';

  const rawMeasurementSummary = JSON.stringify({
    failureTypes: REQUIRED_CAPTURE_FAILURE_TYPES,
    totalInjections: metrics.totalInjections,
    maxLayer0RecoveryMs: metrics.maxLayer0RecoveryMs,
    maxAllowedRecoveryMs: MAX_LAYER0_RECOVERY_MS,
    layer0Failures: metrics.layer0Failures,
    totalBothHiddenIntervals: metrics.totalBothHiddenIntervals,
    failures: metrics.failures,
  });

  return {
    gateId: ReleaseGateId.CAPTURE_FALLBACK,
    buildHash,
    osBuild: row.osBuild,
    architecture: row.architecture,
    webView2Version: row.webView2Version,
    appVersion,
    sidecarVersion,
    rawMeasurementSummary,
    verdict,
    executedAt: new Date().toISOString(),
  };
}
