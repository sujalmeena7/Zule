/**
 * Stage C Release Gate — Diagnostic-Retry Gate.
 *
 * Verifies that the diagnostic retry mechanism allows exactly one accepted
 * retry and rejects every later retry in the same App Core launch.
 *
 * Requirement 17.16: Verify one accepted retry and rejection of every later
 * retry in the same App_Core launch.
 */

import { type EnvironmentMatrixRow, type GateResultRecord, ReleaseGateId } from '../types';

// ────────────────────────────────────────────────────────────────────
// Gate Thresholds (Req 17.16)
// ────────────────────────────────────────────────────────────────────

/** Exactly one retry must be accepted per App Core launch. */
export const EXPECTED_ACCEPTED_RETRIES = 1;

/** Number of additional retry attempts to verify rejection. */
export const REJECTION_VERIFICATION_ATTEMPTS = 5;

// ────────────────────────────────────────────────────────────────────
// Diagnostic-Retry Gate Dependencies (injectable for testing)
// ────────────────────────────────────────────────────────────────────

/**
 * Result from a diagnostic retry attempt.
 */
export interface DiagnosticRetryAttemptResult {
  /** The attempt index (0-based). */
  readonly attemptIndex: number;

  /** Whether the retry was accepted by the system. */
  readonly accepted: boolean;
}

/**
 * Injectable dependency interface for the diagnostic-retry gate.
 */
export interface DiagnosticRetryGateDeps {
  /**
   * Trigger a diagnostic retry attempt and observe whether it is accepted.
   * The first call should be accepted; subsequent calls should be rejected.
   */
  attemptDiagnosticRetry(attemptIndex: number): Promise<DiagnosticRetryAttemptResult>;
}

// ────────────────────────────────────────────────────────────────────
// Gate Execution
// ────────────────────────────────────────────────────────────────────

interface DiagnosticRetryGateMetrics {
  totalAttempts: number;
  acceptedRetries: number;
  rejectedAfterFirst: number;
  unexpectedAcceptances: number;
  firstRetryAccepted: boolean;
  failures: string[];
}

/**
 * Executes the diagnostic-retry gate for a given environment row.
 *
 * Requirement 17.16: One accepted retry, every later retry rejected
 * in the same App Core launch.
 */
export async function executeDiagnosticRetryGate(
  row: EnvironmentMatrixRow,
  deps: DiagnosticRetryGateDeps,
  buildHash: string,
  appVersion: string,
  sidecarVersion: string,
): Promise<GateResultRecord> {
  const metrics: DiagnosticRetryGateMetrics = {
    totalAttempts: 0,
    acceptedRetries: 0,
    rejectedAfterFirst: 0,
    unexpectedAcceptances: 0,
    firstRetryAccepted: false,
    failures: [],
  };

  const totalAttempts = EXPECTED_ACCEPTED_RETRIES + REJECTION_VERIFICATION_ATTEMPTS;

  for (let i = 0; i < totalAttempts; i++) {
    const result = await deps.attemptDiagnosticRetry(i);
    metrics.totalAttempts++;

    if (result.accepted) {
      metrics.acceptedRetries++;

      if (i === 0) {
        // First retry should be accepted
        metrics.firstRetryAccepted = true;
      } else {
        // Later retries should be rejected
        metrics.unexpectedAcceptances++;
        metrics.failures.push(
          `Retry attempt ${i} was accepted (should have been rejected after first accepted retry)`,
        );
      }
    } else {
      if (i === 0) {
        // First retry should have been accepted
        metrics.failures.push(
          `First retry attempt was rejected (should have been accepted)`,
        );
      } else {
        metrics.rejectedAfterFirst++;
      }
    }
  }

  // Verify exactly one accepted retry
  if (metrics.acceptedRetries !== EXPECTED_ACCEPTED_RETRIES) {
    metrics.failures.push(
      `${metrics.acceptedRetries} retries accepted (expected exactly ${EXPECTED_ACCEPTED_RETRIES})`,
    );
  }

  // Verify first retry was accepted
  if (!metrics.firstRetryAccepted) {
    metrics.failures.push('First diagnostic retry was not accepted');
  }

  // Verify all subsequent retries were rejected
  const expectedRejections = REJECTION_VERIFICATION_ATTEMPTS;
  if (metrics.rejectedAfterFirst < expectedRejections) {
    metrics.failures.push(
      `Only ${metrics.rejectedAfterFirst}/${expectedRejections} subsequent retries were correctly rejected`,
    );
  }

  const verdict = metrics.failures.length === 0 ? 'pass' : 'fail';

  const rawMeasurementSummary = JSON.stringify({
    totalAttempts: metrics.totalAttempts,
    acceptedRetries: metrics.acceptedRetries,
    expectedAccepted: EXPECTED_ACCEPTED_RETRIES,
    rejectedAfterFirst: metrics.rejectedAfterFirst,
    unexpectedAcceptances: metrics.unexpectedAcceptances,
    firstRetryAccepted: metrics.firstRetryAccepted,
    failures: metrics.failures,
  });

  return {
    gateId: ReleaseGateId.DIAGNOSTIC_RETRY,
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
