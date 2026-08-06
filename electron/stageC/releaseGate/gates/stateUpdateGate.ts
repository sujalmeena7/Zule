/**
 * Stage C Release Gate — State-Update Gate.
 *
 * Verifies state-update queue bounds, revision-correlated acknowledgements,
 * latest-value geometry and visibility operations, safe coalescing of
 * superseded intermediate render patches, and preservation of terminal
 * and error transitions.
 *
 * Requirement 17.22: WHEN state-update performance is tested, THE
 * Release_Gate_Harness SHALL verify the 256-message and 1,048,576-byte
 * queue bounds, revision-correlated acknowledgements, latest-value
 * geometry and visibility operations, coalescing only of superseded
 * intermediate render patches, and preservation of terminal and error
 * transitions.
 */

import type { EnvironmentMatrixRow, GateResultRecord, GateVerdict } from '../types';
import { ReleaseGateId } from '../types';

// ────────────────────────────────────────────────────────────────────
// Thresholds (exact values from Requirement 17.22)
// ────────────────────────────────────────────────────────────────────

/** Maximum number of messages allowed in the queue */
export const MAX_QUEUE_MESSAGE_COUNT = 256;

/** Maximum queue size in bytes (1 MiB) */
export const MAX_QUEUE_SIZE_BYTES = 1_048_576;

// ────────────────────────────────────────────────────────────────────
// Injectable Dependencies
// ────────────────────────────────────────────────────────────────────

/**
 * Results from state-update queue bound verification.
 */
export interface QueueBoundResult {
  /** Whether the 256-message bound was enforced */
  readonly messageCountBoundEnforced: boolean;

  /** Whether the 1,048,576-byte bound was enforced */
  readonly byteSizeBoundEnforced: boolean;

  /** Observed maximum message count during the test */
  readonly observedMaxMessageCount: number;

  /** Observed maximum byte size during the test */
  readonly observedMaxByteSize: number;
}

/**
 * Results from revision-correlated acknowledgement verification.
 */
export interface RevisionAckResult {
  /** Whether every acknowledgement correlates to the correct revision */
  readonly allAcksCorrelated: boolean;

  /** Number of acknowledgements validated */
  readonly totalAcksValidated: number;

  /** Number of acknowledgements that failed correlation */
  readonly uncorrelatedAcks: number;
}

/**
 * Results from latest-value geometry and visibility verification.
 */
export interface LatestValueResult {
  /** Whether geometry operations use latest-value semantics */
  readonly geometryLatestValue: boolean;

  /** Whether visibility operations use latest-value semantics */
  readonly visibilityLatestValue: boolean;
}

/**
 * Results from coalescing verification.
 */
export interface CoalescingResult {
  /** Whether only superseded intermediate render patches are coalesced */
  readonly onlySupersededCoalesced: boolean;

  /** Whether terminal transitions are preserved (never coalesced) */
  readonly terminalTransitionsPreserved: boolean;

  /** Whether error transitions are preserved (never coalesced) */
  readonly errorTransitionsPreserved: boolean;
}

/**
 * Combined state-update metrics from all sub-tests.
 */
export interface StateUpdateMetrics {
  readonly queueBounds: QueueBoundResult;
  readonly revisionAcks: RevisionAckResult;
  readonly latestValue: LatestValueResult;
  readonly coalescing: CoalescingResult;
}

/**
 * Injectable state-update verifier that exercises the queue,
 * acknowledgement, latest-value, and coalescing behaviors.
 */
export interface StateUpdateVerifier {
  /**
   * Verify all state-update behaviors and return metrics.
   */
  verify(env: EnvironmentMatrixRow): Promise<StateUpdateMetrics>;
}

// ────────────────────────────────────────────────────────────────────
// Gate Evaluation
// ────────────────────────────────────────────────────────────────────

/**
 * Input parameters for the state-update gate execution.
 */
export interface StateUpdateGateInput {
  readonly env: EnvironmentMatrixRow;
  readonly buildHash: string;
  readonly appVersion: string;
  readonly sidecarVersion: string;
  readonly stateUpdateVerifier: StateUpdateVerifier;
}

/**
 * Evaluates the state-update gate for a single environment matrix row.
 *
 * Pass criteria (all must hold):
 *   - 256-message queue bound is enforced
 *   - 1,048,576-byte queue bound is enforced
 *   - All acknowledgements are revision-correlated
 *   - Geometry operations use latest-value semantics
 *   - Visibility operations use latest-value semantics
 *   - Only superseded intermediate render patches are coalesced
 *   - Terminal transitions are preserved
 *   - Error transitions are preserved
 *
 * @returns A GateResultRecord with verdict 'pass' or 'fail'
 */
export async function evaluateStateUpdateGate(
  input: StateUpdateGateInput,
): Promise<GateResultRecord> {
  const { env, buildHash, appVersion, sidecarVersion, stateUpdateVerifier } = input;

  const metrics = await stateUpdateVerifier.verify(env);

  const verdict = evaluateStateUpdateMetrics(metrics);

  const rawMeasurementSummary = JSON.stringify({
    queueBounds: {
      messageCountBoundEnforced: metrics.queueBounds.messageCountBoundEnforced,
      byteSizeBoundEnforced: metrics.queueBounds.byteSizeBoundEnforced,
      observedMaxMessageCount: metrics.queueBounds.observedMaxMessageCount,
      observedMaxByteSize: metrics.queueBounds.observedMaxByteSize,
    },
    revisionAcks: {
      allAcksCorrelated: metrics.revisionAcks.allAcksCorrelated,
      totalAcksValidated: metrics.revisionAcks.totalAcksValidated,
      uncorrelatedAcks: metrics.revisionAcks.uncorrelatedAcks,
    },
    latestValue: {
      geometryLatestValue: metrics.latestValue.geometryLatestValue,
      visibilityLatestValue: metrics.latestValue.visibilityLatestValue,
    },
    coalescing: {
      onlySupersededCoalesced: metrics.coalescing.onlySupersededCoalesced,
      terminalTransitionsPreserved: metrics.coalescing.terminalTransitionsPreserved,
      errorTransitionsPreserved: metrics.coalescing.errorTransitionsPreserved,
    },
    thresholds: {
      maxQueueMessageCount: MAX_QUEUE_MESSAGE_COUNT,
      maxQueueSizeBytes: MAX_QUEUE_SIZE_BYTES,
    },
  });

  return {
    gateId: ReleaseGateId.STATE_UPDATE,
    buildHash,
    osBuild: env.osBuild,
    architecture: env.architecture,
    webView2Version: env.webView2Version,
    appVersion,
    sidecarVersion,
    rawMeasurementSummary,
    verdict,
    executedAt: new Date().toISOString(),
  };
}

/**
 * Pure evaluation of state-update metrics against requirements.
 * Exported for unit testing.
 */
export function evaluateStateUpdateMetrics(metrics: StateUpdateMetrics): GateVerdict {
  // Queue bounds enforcement
  if (!metrics.queueBounds.messageCountBoundEnforced) {
    return 'fail';
  }

  if (!metrics.queueBounds.byteSizeBoundEnforced) {
    return 'fail';
  }

  // Revision-correlated acknowledgements
  if (!metrics.revisionAcks.allAcksCorrelated) {
    return 'fail';
  }

  // Latest-value semantics for geometry and visibility
  if (!metrics.latestValue.geometryLatestValue) {
    return 'fail';
  }

  if (!metrics.latestValue.visibilityLatestValue) {
    return 'fail';
  }

  // Coalescing safety
  if (!metrics.coalescing.onlySupersededCoalesced) {
    return 'fail';
  }

  if (!metrics.coalescing.terminalTransitionsPreserved) {
    return 'fail';
  }

  if (!metrics.coalescing.errorTransitionsPreserved) {
    return 'fail';
  }

  return 'pass';
}
