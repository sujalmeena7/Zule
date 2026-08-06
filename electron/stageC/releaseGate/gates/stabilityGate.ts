/**
 * Stage C Release Gate — Stability Gate.
 *
 * Verifies Stage C completes a 60-minute interaction soak and 100 start-stop
 * cycles with zero crashes, zero orphan processes, zero leaked windows,
 * and sidecar memory growth no greater than 50 MiB after warm-up.
 *
 * Requirement 17.18: WHEN the stability gate executes, THE Release_Gate_Harness
 * SHALL complete a 60-minute interaction soak and 100 start-stop cycles with
 * zero App_Core crashes, zero sidecar crashes, zero orphan processes, zero
 * leaked top-level sidecar windows, and sidecar private-memory growth no
 * greater than 50 MiB after warm-up.
 */

import type { EnvironmentMatrixRow, GateResultRecord, GateVerdict } from '../types';
import { ReleaseGateId } from '../types';

// ────────────────────────────────────────────────────────────────────
// Thresholds (exact values from Requirement 17.18)
// ────────────────────────────────────────────────────────────────────

/** Duration of the interaction soak in milliseconds (60 minutes) */
export const SOAK_DURATION_MS = 60 * 60 * 1000;

/** Number of required start-stop cycles */
export const START_STOP_CYCLES = 100;

/** Maximum allowed App Core crashes (must be zero) */
export const MAX_APP_CORE_CRASHES = 0;

/** Maximum allowed sidecar crashes (must be zero) */
export const MAX_SIDECAR_CRASHES = 0;

/** Maximum allowed orphan processes (must be zero) */
export const MAX_ORPHAN_PROCESSES = 0;

/** Maximum allowed leaked top-level sidecar windows (must be zero) */
export const MAX_LEAKED_WINDOWS = 0;

/** Maximum allowed sidecar private memory growth in bytes (50 MiB) */
export const MAX_MEMORY_GROWTH_BYTES = 50 * 1024 * 1024;

// ────────────────────────────────────────────────────────────────────
// Injectable Dependencies
// ────────────────────────────────────────────────────────────────────

/**
 * Raw metrics collected during the stability test run.
 */
export interface StabilityMetrics {
  /** Actual soak duration completed in milliseconds */
  readonly soakDurationMs: number;

  /** Number of start-stop cycles completed */
  readonly completedCycles: number;

  /** Number of App Core crashes observed during the run */
  readonly appCoreCrashes: number;

  /** Number of sidecar crashes observed during the run */
  readonly sidecarCrashes: number;

  /** Number of orphan processes detected after the run */
  readonly orphanProcesses: number;

  /** Number of leaked top-level sidecar windows detected after the run */
  readonly leakedWindows: number;

  /** Sidecar private memory growth in bytes after warm-up */
  readonly memoryGrowthBytes: number;
}

/**
 * Injectable process monitor that runs stability tests and returns
 * raw measurements.
 */
export interface StabilityProcessMonitor {
  /**
   * Execute the 60-minute interaction soak and report metrics.
   */
  runSoak(env: EnvironmentMatrixRow): Promise<StabilityMetrics>;

  /**
   * Execute 100 start-stop cycles and report metrics.
   */
  runStartStopCycles(env: EnvironmentMatrixRow): Promise<StabilityMetrics>;
}

// ────────────────────────────────────────────────────────────────────
// Gate Evaluation
// ────────────────────────────────────────────────────────────────────

/**
 * Input parameters for the stability gate execution.
 */
export interface StabilityGateInput {
  readonly env: EnvironmentMatrixRow;
  readonly buildHash: string;
  readonly appVersion: string;
  readonly sidecarVersion: string;
  readonly processMonitor: StabilityProcessMonitor;
}

/**
 * Evaluates the stability gate for a single environment matrix row.
 *
 * The gate runs both the soak test and start-stop cycles, then merges
 * the results. Both must pass for the gate to pass.
 *
 * @returns A GateResultRecord with verdict 'pass' or 'fail'
 */
export async function evaluateStabilityGate(
  input: StabilityGateInput,
): Promise<GateResultRecord> {
  const { env, buildHash, appVersion, sidecarVersion, processMonitor } = input;

  const soakMetrics = await processMonitor.runSoak(env);
  const cycleMetrics = await processMonitor.runStartStopCycles(env);

  const soakVerdict = evaluateStabilityMetrics(soakMetrics);
  const cycleVerdict = evaluateStartStopMetrics(cycleMetrics);

  const verdict: GateVerdict = soakVerdict === 'pass' && cycleVerdict === 'pass'
    ? 'pass'
    : 'fail';

  const rawMeasurementSummary = JSON.stringify({
    soak: {
      soakDurationMs: soakMetrics.soakDurationMs,
      appCoreCrashes: soakMetrics.appCoreCrashes,
      sidecarCrashes: soakMetrics.sidecarCrashes,
      orphanProcesses: soakMetrics.orphanProcesses,
      leakedWindows: soakMetrics.leakedWindows,
      memoryGrowthBytes: soakMetrics.memoryGrowthBytes,
    },
    cycles: {
      completedCycles: cycleMetrics.completedCycles,
      appCoreCrashes: cycleMetrics.appCoreCrashes,
      sidecarCrashes: cycleMetrics.sidecarCrashes,
      orphanProcesses: cycleMetrics.orphanProcesses,
      leakedWindows: cycleMetrics.leakedWindows,
      memoryGrowthBytes: cycleMetrics.memoryGrowthBytes,
    },
    thresholds: {
      soakDurationMs: SOAK_DURATION_MS,
      startStopCycles: START_STOP_CYCLES,
      maxAppCoreCrashes: MAX_APP_CORE_CRASHES,
      maxSidecarCrashes: MAX_SIDECAR_CRASHES,
      maxOrphanProcesses: MAX_ORPHAN_PROCESSES,
      maxLeakedWindows: MAX_LEAKED_WINDOWS,
      maxMemoryGrowthBytes: MAX_MEMORY_GROWTH_BYTES,
    },
  });

  return {
    gateId: ReleaseGateId.STABILITY,
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
 * Pure evaluation of soak stability metrics against thresholds.
 * Exported for unit testing.
 */
export function evaluateStabilityMetrics(metrics: StabilityMetrics): GateVerdict {
  if (metrics.soakDurationMs < SOAK_DURATION_MS) {
    return 'fail';
  }

  if (metrics.appCoreCrashes > MAX_APP_CORE_CRASHES) {
    return 'fail';
  }

  if (metrics.sidecarCrashes > MAX_SIDECAR_CRASHES) {
    return 'fail';
  }

  if (metrics.orphanProcesses > MAX_ORPHAN_PROCESSES) {
    return 'fail';
  }

  if (metrics.leakedWindows > MAX_LEAKED_WINDOWS) {
    return 'fail';
  }

  if (metrics.memoryGrowthBytes > MAX_MEMORY_GROWTH_BYTES) {
    return 'fail';
  }

  return 'pass';
}

/**
 * Pure evaluation of start-stop cycle metrics against thresholds.
 * Exported for unit testing.
 */
export function evaluateStartStopMetrics(metrics: StabilityMetrics): GateVerdict {
  if (metrics.completedCycles < START_STOP_CYCLES) {
    return 'fail';
  }

  if (metrics.appCoreCrashes > MAX_APP_CORE_CRASHES) {
    return 'fail';
  }

  if (metrics.sidecarCrashes > MAX_SIDECAR_CRASHES) {
    return 'fail';
  }

  if (metrics.orphanProcesses > MAX_ORPHAN_PROCESSES) {
    return 'fail';
  }

  if (metrics.leakedWindows > MAX_LEAKED_WINDOWS) {
    return 'fail';
  }

  if (metrics.memoryGrowthBytes > MAX_MEMORY_GROWTH_BYTES) {
    return 'fail';
  }

  return 'pass';
}
