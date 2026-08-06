/**
 * Stage C Release Gate — Runtime-Probe Gate.
 *
 * Performs 30 cold probes per environment and asserts:
 * - Each successful probe completes within 3 seconds
 * - Each failed probe starts zero sidecar processes
 *
 * Requirement 17.6
 */

import type { EnvironmentMatrixRow, GateResultRecord } from '../types';
import { ReleaseGateId } from '../types';
import type { GateBuildContext, RuntimeProbeGateDeps, ColdProbeResult } from './types';

// ────────────────────────────────────────────────────────────────────
// Thresholds
// ────────────────────────────────────────────────────────────────────

/** Number of cold probes required per environment */
export const RUNTIME_PROBE_COLD_COUNT = 30;

/** Maximum duration for a successful probe (ms) */
export const PROBE_SUCCESS_DEADLINE_MS = 3000;

/** Maximum sidecar processes that a failed probe may start */
export const FAILED_PROBE_MAX_SIDECAR_PROCESSES = 0;

// ────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────

/**
 * Validates a single cold probe result against the gate thresholds.
 * Returns an array of violation descriptions (empty if valid).
 */
export function validateColdProbe(result: ColdProbeResult, probeIndex: number): readonly string[] {
  const violations: string[] = [];

  if (result.success && result.durationMs > PROBE_SUCCESS_DEADLINE_MS) {
    violations.push(
      `Probe ${probeIndex + 1}: successful probe took ${result.durationMs}ms (deadline ${PROBE_SUCCESS_DEADLINE_MS}ms)`,
    );
  }

  if (!result.success && result.sidecarProcessesStarted > FAILED_PROBE_MAX_SIDECAR_PROCESSES) {
    violations.push(
      `Probe ${probeIndex + 1}: failed probe started ${result.sidecarProcessesStarted} sidecar process(es) (max ${FAILED_PROBE_MAX_SIDECAR_PROCESSES})`,
    );
  }

  return violations;
}

// ────────────────────────────────────────────────────────────────────
// Gate Execution
// ────────────────────────────────────────────────────────────────────

/**
 * Executes the runtime-probe gate for a single environment row.
 *
 * Performs RUNTIME_PROBE_COLD_COUNT cold probes and validates each
 * against timing and process-creation thresholds.
 *
 * Requirement 17.6: 30 cold probes, 3s deadline for success,
 * zero sidecar processes for failure.
 */
export async function executeRuntimeProbeGate(
  env: EnvironmentMatrixRow,
  buildContext: GateBuildContext,
  deps: RuntimeProbeGateDeps,
): Promise<GateResultRecord> {
  const allViolations: string[] = [];
  const durations: number[] = [];
  let successCount = 0;
  let failureCount = 0;

  for (let i = 0; i < RUNTIME_PROBE_COLD_COUNT; i++) {
    const result = await deps.executeColdProbe(env);
    durations.push(result.durationMs);

    if (result.success) {
      successCount++;
    } else {
      failureCount++;
    }

    const violations = validateColdProbe(result, i);
    allViolations.push(...violations);
  }

  const verdict = allViolations.length === 0 ? 'pass' : 'fail';

  const rawMeasurementSummary = JSON.stringify({
    gate: ReleaseGateId.RUNTIME_PROBE,
    totalProbes: RUNTIME_PROBE_COLD_COUNT,
    successCount,
    failureCount,
    durations,
    violations: allViolations,
    thresholds: {
      probeSuccessDeadlineMs: PROBE_SUCCESS_DEADLINE_MS,
      failedProbeMaxSidecarProcesses: FAILED_PROBE_MAX_SIDECAR_PROCESSES,
    },
  });

  return {
    gateId: ReleaseGateId.RUNTIME_PROBE,
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
