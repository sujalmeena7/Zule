/**
 * Stage C Release Gate — Capture Gate.
 *
 * Verifies that the Stage C sidecar correctly handles Capture_Protection
 * enable-disable cycles with read-back matching requests within 100 ms
 * and parity with Layer 0 observed via Electron desktop capture and
 * an external Windows Graphics Capture recorder.
 *
 * Requirement 17.13: 20 enable-disable cycles per environment with read-back
 * equal to each request within 100 milliseconds and observed results matching
 * Layer_0 in Electron desktop capture and an external Windows Graphics Capture
 * recorder.
 */

import { type EnvironmentMatrixRow, type GateResultRecord, ReleaseGateId } from '../types';

// ────────────────────────────────────────────────────────────────────
// Gate Thresholds (Req 17.13)
// ────────────────────────────────────────────────────────────────────

/** Number of enable-disable cycles required per environment. */
export const REQUIRED_CAPTURE_CYCLES = 20;

/** Maximum allowed read-back latency in milliseconds. */
export const MAX_READBACK_LATENCY_MS = 100;

/** Recorders that must confirm Layer 0 parity. */
export const REQUIRED_RECORDERS: readonly string[] = [
  'electron_desktop_capture',
  'windows_graphics_capture',
] as const;

// ────────────────────────────────────────────────────────────────────
// Capture Gate Dependencies (injectable for testing)
// ────────────────────────────────────────────────────────────────────

/**
 * Result from a single capture enable-disable cycle.
 */
export interface CaptureCycleResult {
  /** The cycle index (0-based). */
  readonly cycleIndex: number;

  /** Whether the read-back matched the request (enable or disable). */
  readonly readbackMatchesRequest: boolean;

  /** Time in milliseconds for read-back to reflect the request. */
  readonly readbackLatencyMs: number;
}

/**
 * Result from a recorder parity check.
 */
export interface RecorderParityResult {
  /** The recorder identifier. */
  readonly recorder: string;

  /** Whether the recorder observed the same capture behavior as Layer 0. */
  readonly parityWithLayer0: boolean;
}

/**
 * Injectable dependency interface for the capture gate.
 */
export interface CaptureGateDeps {
  /** Execute a capture enable-disable cycle and measure read-back. */
  runCaptureCycle(cycleIndex: number): Promise<CaptureCycleResult>;

  /** Check that the given recorder observes Layer 0 parity. */
  checkRecorderParity(recorder: string): Promise<RecorderParityResult>;
}

// ────────────────────────────────────────────────────────────────────
// Gate Execution
// ────────────────────────────────────────────────────────────────────

interface CaptureGateMetrics {
  completedCycles: number;
  readbackMismatches: number;
  maxReadbackLatencyMs: number;
  latencyExceeded: number;
  recorderResults: RecorderParityResult[];
  failures: string[];
}

/**
 * Executes the capture gate for a given environment row.
 *
 * Requirement 17.13: 20 enable-disable cycles per environment.
 * Read-back must equal request within 100 ms. Layer 0 parity must
 * be observed in both Electron desktop capture and external Windows
 * Graphics Capture recorder.
 */
export async function executeCaptureGate(
  row: EnvironmentMatrixRow,
  deps: CaptureGateDeps,
  buildHash: string,
  appVersion: string,
  sidecarVersion: string,
): Promise<GateResultRecord> {
  const metrics: CaptureGateMetrics = {
    completedCycles: 0,
    readbackMismatches: 0,
    maxReadbackLatencyMs: 0,
    latencyExceeded: 0,
    recorderResults: [],
    failures: [],
  };

  // Execute capture cycles
  for (let i = 0; i < REQUIRED_CAPTURE_CYCLES; i++) {
    const result = await deps.runCaptureCycle(i);
    metrics.completedCycles++;

    if (!result.readbackMatchesRequest) {
      metrics.readbackMismatches++;
    }

    if (result.readbackLatencyMs > metrics.maxReadbackLatencyMs) {
      metrics.maxReadbackLatencyMs = result.readbackLatencyMs;
    }

    if (result.readbackLatencyMs > MAX_READBACK_LATENCY_MS) {
      metrics.latencyExceeded++;
    }
  }

  // Check recorder parity
  for (const recorder of REQUIRED_RECORDERS) {
    const parityResult = await deps.checkRecorderParity(recorder);
    metrics.recorderResults.push(parityResult);

    if (!parityResult.parityWithLayer0) {
      metrics.failures.push(`Recorder '${recorder}' did not observe Layer 0 parity`);
    }
  }

  // Threshold checks
  if (metrics.completedCycles < REQUIRED_CAPTURE_CYCLES) {
    metrics.failures.push(
      `Only ${metrics.completedCycles}/${REQUIRED_CAPTURE_CYCLES} capture cycles completed`,
    );
  }

  if (metrics.readbackMismatches > 0) {
    metrics.failures.push(
      `${metrics.readbackMismatches} read-back mismatches detected (must be zero)`,
    );
  }

  if (metrics.latencyExceeded > 0) {
    metrics.failures.push(
      `${metrics.latencyExceeded} cycles exceeded ${MAX_READBACK_LATENCY_MS}ms read-back latency`,
    );
  }

  const verdict = metrics.failures.length === 0 ? 'pass' : 'fail';

  const rawMeasurementSummary = JSON.stringify({
    completedCycles: metrics.completedCycles,
    requiredCycles: REQUIRED_CAPTURE_CYCLES,
    readbackMismatches: metrics.readbackMismatches,
    maxReadbackLatencyMs: metrics.maxReadbackLatencyMs,
    latencyExceeded: metrics.latencyExceeded,
    recorderResults: metrics.recorderResults,
    failures: metrics.failures,
  });

  return {
    gateId: ReleaseGateId.CAPTURE,
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
