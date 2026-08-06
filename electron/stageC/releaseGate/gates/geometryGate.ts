/**
 * Stage C Release Gate — Geometry Gate.
 *
 * Verifies that the Stage C sidecar correctly handles window geometry across
 * all required scale factors and topologies with final edge error ≤ 1 physical
 * pixel and a reachable Floating_Surface.
 *
 * Requirement 17.10: Scale factors 100%, 125%, 150%, 175%, 200%, 250%, 300%
 * across move, resize, nudge, recenter, snap, maximize, restore, monitor crossing,
 * monitor removal, negative coordinates, DPI change, rotation, and work-area change
 * with final edge error ≤ 1 physical pixel and a reachable Floating_Surface.
 */

import { type EnvironmentMatrixRow, type GateResultRecord, ReleaseGateId } from '../types';

// ────────────────────────────────────────────────────────────────────
// Gate Thresholds (Req 17.10)
// ────────────────────────────────────────────────────────────────────

/** Scale factors that must be tested. */
export const REQUIRED_SCALE_FACTORS: readonly number[] = [
  1.00,  // 100%
  1.25,  // 125%
  1.50,  // 150%
  1.75,  // 175%
  2.00,  // 200%
  2.50,  // 250%
  3.00,  // 300%
] as const;

/** Geometry operations (topologies) that must be tested at each scale. */
export const REQUIRED_TOPOLOGIES: readonly string[] = [
  'move',
  'resize',
  'nudge',
  'recenter',
  'snap',
  'maximize',
  'restore',
  'monitor_crossing',
  'monitor_removal',
  'negative_coordinates',
  'dpi_change',
  'rotation',
  'work_area_change',
] as const;

/** Maximum allowed final edge error in physical pixels. */
export const MAX_EDGE_ERROR_PX = 1;

// ────────────────────────────────────────────────────────────────────
// Geometry Gate Dependencies (injectable for testing)
// ────────────────────────────────────────────────────────────────────

/**
 * Result from a single geometry operation measurement.
 */
export interface GeometryOperationResult {
  /** The scale factor tested. */
  readonly scale: number;

  /** The topology operation tested. */
  readonly topology: string;

  /** Final edge error in physical pixels. */
  readonly edgeErrorPx: number;

  /** Whether the Floating_Surface remained reachable after the operation. */
  readonly surfaceReachable: boolean;
}

/**
 * Injectable dependency interface for the geometry gate.
 * Allows test harness to provide real or simulated geometry measurements.
 */
export interface GeometryGateDeps {
  /**
   * Execute a geometry operation at the given scale and return the measurement.
   * Must test the specific topology at the given scale factor.
   */
  runGeometryOperation(scale: number, topology: string): Promise<GeometryOperationResult>;
}

// ────────────────────────────────────────────────────────────────────
// Gate Execution
// ────────────────────────────────────────────────────────────────────

interface GeometryGateMetrics {
  totalOperations: number;
  maxEdgeErrorPx: number;
  unreachableSurfaces: number;
  missingCombinations: string[];
  failures: string[];
}

/**
 * Executes the geometry gate for a given environment row.
 *
 * Requirement 17.10: Tests all required scale factors across all required
 * topologies. Final edge error must be ≤ 1 physical pixel and the
 * Floating_Surface must always remain reachable.
 */
export async function executeGeometryGate(
  row: EnvironmentMatrixRow,
  deps: GeometryGateDeps,
  buildHash: string,
  appVersion: string,
  sidecarVersion: string,
): Promise<GateResultRecord> {
  const metrics: GeometryGateMetrics = {
    totalOperations: 0,
    maxEdgeErrorPx: 0,
    unreachableSurfaces: 0,
    missingCombinations: [],
    failures: [],
  };

  for (const scale of REQUIRED_SCALE_FACTORS) {
    for (const topology of REQUIRED_TOPOLOGIES) {
      const result = await deps.runGeometryOperation(scale, topology);
      metrics.totalOperations++;

      if (result.edgeErrorPx > metrics.maxEdgeErrorPx) {
        metrics.maxEdgeErrorPx = result.edgeErrorPx;
      }

      if (result.edgeErrorPx > MAX_EDGE_ERROR_PX) {
        metrics.failures.push(
          `Scale ${scale} / ${topology}: edge error ${result.edgeErrorPx}px exceeds ${MAX_EDGE_ERROR_PX}px`,
        );
      }

      if (!result.surfaceReachable) {
        metrics.unreachableSurfaces++;
        metrics.failures.push(
          `Scale ${scale} / ${topology}: Floating_Surface not reachable after operation`,
        );
      }
    }
  }

  // Verify all combinations were exercised
  const expectedCount = REQUIRED_SCALE_FACTORS.length * REQUIRED_TOPOLOGIES.length;
  if (metrics.totalOperations < expectedCount) {
    metrics.failures.push(
      `Only ${metrics.totalOperations}/${expectedCount} scale×topology combinations tested`,
    );
  }

  const verdict = metrics.failures.length === 0 ? 'pass' : 'fail';

  const rawMeasurementSummary = JSON.stringify({
    scaleFactors: REQUIRED_SCALE_FACTORS,
    topologies: REQUIRED_TOPOLOGIES,
    totalOperations: metrics.totalOperations,
    expectedOperations: expectedCount,
    maxEdgeErrorPx: metrics.maxEdgeErrorPx,
    unreachableSurfaces: metrics.unreachableSurfaces,
    failures: metrics.failures,
  });

  return {
    gateId: ReleaseGateId.GEOMETRY,
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
