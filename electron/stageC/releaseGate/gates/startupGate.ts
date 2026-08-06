/**
 * Stage C Release Gate — Startup Gate.
 *
 * Performs 30 cold launches per environment and asserts:
 * - Authentication, Ready_Handshake, snapshot ack, first-frame readiness
 *   occur in that order within 3 seconds
 * - 95th-percentile startup duration ≤ 2 seconds
 *
 * Requirement 17.7
 */

import type { EnvironmentMatrixRow, GateResultRecord } from '../types';
import { ReleaseGateId } from '../types';
import type { GateBuildContext, StartupGateDeps, ColdStartupResult, StartupMilestones } from './types';

// ────────────────────────────────────────────────────────────────────
// Thresholds
// ────────────────────────────────────────────────────────────────────

/** Number of cold launches required per environment */
export const STARTUP_COLD_LAUNCH_COUNT = 30;

/** Maximum total startup duration from cold start to first-frame (ms) */
export const STARTUP_DEADLINE_MS = 3000;

/** Maximum 95th-percentile startup duration (ms) */
export const STARTUP_P95_MS = 2000;

// ────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────

/**
 * Validates milestone ordering: authentication < handshake < snapshot ack < first-frame.
 * Returns an array of violation descriptions (empty if valid).
 */
export function validateMilestoneOrdering(milestones: StartupMilestones): readonly string[] {
  const violations: string[] = [];

  if (milestones.authenticationAt >= milestones.readyHandshakeAt) {
    violations.push(
      `Authentication (${milestones.authenticationAt}) not before Ready_Handshake (${milestones.readyHandshakeAt})`,
    );
  }

  if (milestones.readyHandshakeAt >= milestones.snapshotAckAt) {
    violations.push(
      `Ready_Handshake (${milestones.readyHandshakeAt}) not before snapshot ack (${milestones.snapshotAckAt})`,
    );
  }

  if (milestones.snapshotAckAt >= milestones.firstFrameAt) {
    violations.push(
      `Snapshot ack (${milestones.snapshotAckAt}) not before first-frame (${milestones.firstFrameAt})`,
    );
  }

  return violations;
}

/**
 * Validates a single cold startup result against the gate thresholds.
 * Returns an array of violation descriptions (empty if valid).
 */
export function validateColdStartup(result: ColdStartupResult, launchIndex: number): readonly string[] {
  const violations: string[] = [];

  if (!result.success) {
    violations.push(`Launch ${launchIndex + 1}: startup failed`);
    return violations;
  }

  if (result.durationMs > STARTUP_DEADLINE_MS) {
    violations.push(
      `Launch ${launchIndex + 1}: total duration ${result.durationMs}ms exceeds deadline ${STARTUP_DEADLINE_MS}ms`,
    );
  }

  if (result.milestones) {
    const orderViolations = validateMilestoneOrdering(result.milestones);
    for (const v of orderViolations) {
      violations.push(`Launch ${launchIndex + 1}: ${v}`);
    }
  }

  return violations;
}

/**
 * Computes the 95th-percentile value from a sorted array of durations.
 * Uses nearest-rank method.
 */
export function computeP95(durations: readonly number[]): number {
  if (durations.length === 0) {
    return 0;
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const index = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.min(index, sorted.length - 1)];
}

// ────────────────────────────────────────────────────────────────────
// Gate Execution
// ────────────────────────────────────────────────────────────────────

/**
 * Executes the startup gate for a single environment row.
 *
 * Performs STARTUP_COLD_LAUNCH_COUNT cold launches, validates ordering
 * and deadlines, and checks p95 startup duration.
 *
 * Requirement 17.7: 30 cold launches, ordered milestones within 3s,
 * p95 startup ≤ 2s.
 */
export async function executeStartupGate(
  env: EnvironmentMatrixRow,
  buildContext: GateBuildContext,
  deps: StartupGateDeps,
): Promise<GateResultRecord> {
  const allViolations: string[] = [];
  const durations: number[] = [];
  let passedLaunches = 0;

  for (let i = 0; i < STARTUP_COLD_LAUNCH_COUNT; i++) {
    const result = await deps.measureColdStartup(env);
    durations.push(result.durationMs);

    const violations = validateColdStartup(result, i);
    if (violations.length === 0) {
      passedLaunches++;
    } else {
      allViolations.push(...violations);
    }
  }

  // Check p95
  const p95 = computeP95(durations);
  if (p95 > STARTUP_P95_MS) {
    allViolations.push(
      `p95 startup duration ${p95}ms exceeds threshold ${STARTUP_P95_MS}ms`,
    );
  }

  const verdict = allViolations.length === 0 ? 'pass' : 'fail';

  const rawMeasurementSummary = JSON.stringify({
    gate: ReleaseGateId.STARTUP,
    totalLaunches: STARTUP_COLD_LAUNCH_COUNT,
    passedLaunches,
    failedLaunches: STARTUP_COLD_LAUNCH_COUNT - passedLaunches,
    durations,
    p95,
    violations: allViolations,
    thresholds: {
      startupDeadlineMs: STARTUP_DEADLINE_MS,
      startupP95Ms: STARTUP_P95_MS,
    },
  });

  return {
    gateId: ReleaseGateId.STARTUP,
    buildHash: buildContext.buildHash,
    osBuild: env.osBuild,
    architecture: env.architecture,
    webView2Version: env.webView2Version,
    appVersion: buildContext.appVersion,
    sidecarVersion: buildContext.sidecarVersion,
    rawMeasurementSummary,
    verdict,
    executedAt: new Date().toISOString(),
  };
}
