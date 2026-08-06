/**
 * Stage C Release Gate — Performance Gate.
 *
 * Verifies that Stage C sustains at least 30 presented frames per second
 * and a 95th-percentile local UI-intent round trip no greater than 50 ms
 * during a 10-minute expanded-overlay run.
 *
 * Requirement 17.17: WHEN the performance gate executes, THE Release_Gate_Harness
 * SHALL sustain at least 30 presented frames per second and a 95th-percentile
 * local UI-intent round trip no greater than 50 milliseconds during a 10-minute
 * expanded-overlay run.
 */

import type { EnvironmentMatrixRow, GateResultRecord, GateVerdict } from '../types';
import { ReleaseGateId } from '../types';

// ────────────────────────────────────────────────────────────────────
// Thresholds (exact values from Requirement 17.17)
// ────────────────────────────────────────────────────────────────────

/** Minimum sustained frames per second */
export const MIN_FPS = 30;

/** Maximum allowable p95 UI-intent round-trip latency in milliseconds */
export const MAX_P95_INTENT_LATENCY_MS = 50;

/** Duration of the expanded-overlay run in milliseconds (10 minutes) */
export const PERFORMANCE_RUN_DURATION_MS = 10 * 60 * 1000;

// ────────────────────────────────────────────────────────────────────
// Injectable Dependencies
// ────────────────────────────────────────────────────────────────────

/**
 * Raw metrics collected during the performance test run.
 */
export interface PerformanceMetrics {
  /** Observed sustained frames per second (minimum over the run) */
  readonly sustainedFps: number;

  /** p95 local UI-intent round-trip latency in milliseconds */
  readonly p95IntentLatencyMs: number;

  /** Actual run duration in milliseconds */
  readonly runDurationMs: number;
}

/**
 * Injectable metrics collector that runs the performance test and
 * returns raw measurements.
 */
export interface PerformanceMetricsCollector {
  /**
   * Execute a 10-minute expanded-overlay performance run and
   * return the collected metrics.
   */
  collect(env: EnvironmentMatrixRow): Promise<PerformanceMetrics>;
}

// ────────────────────────────────────────────────────────────────────
// Gate Evaluation
// ────────────────────────────────────────────────────────────────────

/**
 * Input parameters for the performance gate execution.
 */
export interface PerformanceGateInput {
  readonly env: EnvironmentMatrixRow;
  readonly buildHash: string;
  readonly appVersion: string;
  readonly sidecarVersion: string;
  readonly metricsCollector: PerformanceMetricsCollector;
}

/**
 * Evaluates the performance gate for a single environment matrix row.
 *
 * Pass criteria:
 *   - sustainedFps >= 30
 *   - p95IntentLatencyMs <= 50
 *   - runDurationMs >= PERFORMANCE_RUN_DURATION_MS
 *
 * @returns A GateResultRecord with verdict 'pass' or 'fail'
 */
export async function evaluatePerformanceGate(
  input: PerformanceGateInput,
): Promise<GateResultRecord> {
  const { env, buildHash, appVersion, sidecarVersion, metricsCollector } = input;

  const metrics = await metricsCollector.collect(env);

  const verdict = evaluatePerformanceMetrics(metrics);

  const rawMeasurementSummary = JSON.stringify({
    sustainedFps: metrics.sustainedFps,
    p95IntentLatencyMs: metrics.p95IntentLatencyMs,
    runDurationMs: metrics.runDurationMs,
    thresholds: {
      minFps: MIN_FPS,
      maxP95LatencyMs: MAX_P95_INTENT_LATENCY_MS,
      requiredDurationMs: PERFORMANCE_RUN_DURATION_MS,
    },
  });

  return {
    gateId: ReleaseGateId.PERFORMANCE,
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
 * Pure evaluation of performance metrics against thresholds.
 * Exported for unit testing.
 */
export function evaluatePerformanceMetrics(metrics: PerformanceMetrics): GateVerdict {
  if (metrics.runDurationMs < PERFORMANCE_RUN_DURATION_MS) {
    return 'fail';
  }

  if (metrics.sustainedFps < MIN_FPS) {
    return 'fail';
  }

  if (metrics.p95IntentLatencyMs > MAX_P95_INTENT_LATENCY_MS) {
    return 'fail';
  }

  return 'pass';
}
