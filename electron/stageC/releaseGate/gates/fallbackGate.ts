/**
 * Stage C Release Gate — Lifecycle-Fallback Gate.
 *
 * Verifies that when every lifecycle failure type is injected multiple times,
 * the system recovers to Layer 0 with zero duplicate visible surfaces and
 * notification-to-recovery duration ≤ 500 ms.
 *
 * Requirement 17.15: Inject every probe, endpoint, launch, authentication,
 * handshake, WebView2, bridge, composition, snapshot, first-frame, disconnect,
 * timeout, and crash failure 10 times with Layer_0 recovery, zero duplicate
 * visible surfaces, and notification-to-recovery ≤ 500 ms.
 */

import { type EnvironmentMatrixRow, type GateResultRecord, ReleaseGateId } from '../types';

// ────────────────────────────────────────────────────────────────────
// Gate Thresholds (Req 17.15)
// ────────────────────────────────────────────────────────────────────

/** Number of times each failure type must be injected. */
export const REQUIRED_INJECTION_REPETITIONS = 10;

/** Maximum allowed notification-to-recovery duration (ms). */
export const MAX_RECOVERY_DURATION_MS = 500;

/** Maximum allowed duplicate visible surfaces (must be zero). */
export const MAX_DUPLICATE_VISIBLE_SURFACES = 0;

/** All lifecycle failure types that must be injected and tested. */
export const REQUIRED_FAILURE_TYPES: readonly string[] = [
  'probe',
  'endpoint',
  'launch',
  'authentication',
  'handshake',
  'webview2',
  'bridge',
  'composition',
  'snapshot',
  'first_frame',
  'disconnect',
  'timeout',
  'crash',
] as const;

// ────────────────────────────────────────────────────────────────────
// Fallback Gate Dependencies (injectable for testing)
// ────────────────────────────────────────────────────────────────────

/**
 * Result from a single lifecycle failure injection.
 */
export interface LifecycleFailureInjectionResult {
  /** The failure type that was injected. */
  readonly failureType: string;

  /** The repetition index (0-based) for this failure type. */
  readonly repetition: number;

  /** Whether Layer 0 recovery occurred. */
  readonly layer0Recovered: boolean;

  /** Number of duplicate visible surfaces observed during recovery. */
  readonly duplicateVisibleSurfaces: number;

  /** Time in milliseconds from failure notification to Layer 0 recovery. */
  readonly recoveryDurationMs: number;
}

/**
 * Injectable dependency interface for the fallback gate.
 */
export interface FallbackGateDeps {
  /**
   * Inject a lifecycle failure of the given type and measure recovery.
   * Must be called once per repetition for each failure type.
   */
  injectLifecycleFailure(failureType: string, repetition: number): Promise<LifecycleFailureInjectionResult>;
}

// ────────────────────────────────────────────────────────────────────
// Gate Execution
// ────────────────────────────────────────────────────────────────────

interface FallbackGateMetrics {
  totalInjections: number;
  maxRecoveryDurationMs: number;
  recoveryFailures: number;
  totalDuplicateVisibleSurfaces: number;
  recoveryExceeded: number;
  failures: string[];
}

/**
 * Executes the lifecycle-fallback gate for a given environment row.
 *
 * Requirement 17.15: Inject every required failure type 10 times.
 * Layer 0 must recover. Zero duplicate visible surfaces.
 * Notification-to-recovery ≤ 500 ms.
 */
export async function executeFallbackGate(
  row: EnvironmentMatrixRow,
  deps: FallbackGateDeps,
  buildHash: string,
  appVersion: string,
  sidecarVersion: string,
): Promise<GateResultRecord> {
  const metrics: FallbackGateMetrics = {
    totalInjections: 0,
    maxRecoveryDurationMs: 0,
    recoveryFailures: 0,
    totalDuplicateVisibleSurfaces: 0,
    recoveryExceeded: 0,
    failures: [],
  };

  for (const failureType of REQUIRED_FAILURE_TYPES) {
    for (let rep = 0; rep < REQUIRED_INJECTION_REPETITIONS; rep++) {
      const result = await deps.injectLifecycleFailure(failureType, rep);
      metrics.totalInjections++;

      if (!result.layer0Recovered) {
        metrics.recoveryFailures++;
        metrics.failures.push(
          `Failure type '${failureType}' rep ${rep}: Layer 0 did not recover`,
        );
      }

      if (result.duplicateVisibleSurfaces > MAX_DUPLICATE_VISIBLE_SURFACES) {
        metrics.totalDuplicateVisibleSurfaces += result.duplicateVisibleSurfaces;
        metrics.failures.push(
          `Failure type '${failureType}' rep ${rep}: ${result.duplicateVisibleSurfaces} duplicate visible surfaces`,
        );
      }

      if (result.recoveryDurationMs > metrics.maxRecoveryDurationMs) {
        metrics.maxRecoveryDurationMs = result.recoveryDurationMs;
      }

      if (result.recoveryDurationMs > MAX_RECOVERY_DURATION_MS) {
        metrics.recoveryExceeded++;
        metrics.failures.push(
          `Failure type '${failureType}' rep ${rep}: recovery took ${result.recoveryDurationMs}ms (max: ${MAX_RECOVERY_DURATION_MS}ms)`,
        );
      }
    }
  }

  // Verify total count
  const expectedInjections = REQUIRED_FAILURE_TYPES.length * REQUIRED_INJECTION_REPETITIONS;
  if (metrics.totalInjections < expectedInjections) {
    metrics.failures.push(
      `Only ${metrics.totalInjections}/${expectedInjections} failure injections completed`,
    );
  }

  const verdict = metrics.failures.length === 0 ? 'pass' : 'fail';

  const rawMeasurementSummary = JSON.stringify({
    failureTypes: REQUIRED_FAILURE_TYPES,
    requiredRepetitions: REQUIRED_INJECTION_REPETITIONS,
    totalInjections: metrics.totalInjections,
    expectedInjections,
    maxRecoveryDurationMs: metrics.maxRecoveryDurationMs,
    maxAllowedRecoveryMs: MAX_RECOVERY_DURATION_MS,
    recoveryFailures: metrics.recoveryFailures,
    totalDuplicateVisibleSurfaces: metrics.totalDuplicateVisibleSurfaces,
    recoveryExceeded: metrics.recoveryExceeded,
    failures: metrics.failures,
  });

  return {
    gateId: ReleaseGateId.FALLBACK,
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
