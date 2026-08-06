/**
 * Stage C Release Gate — Transparency Gate.
 *
 * Tests compact, expanded, and maximized modes at 100%, 125%, 150%,
 * and 200% scale. Asserts:
 * - Zero nonzero-alpha pixels in declared transparent regions
 * - Partial-alpha error ≤ 1 (8-bit unit)
 *
 * Requirement 17.8
 */

import type { EnvironmentMatrixRow, GateResultRecord } from '../types';
import { ReleaseGateId } from '../types';
import type {
  GateBuildContext,
  TransparencyGateDeps,
  TransparencyAnalysis,
  OverlayMode,
  ScaleFactor,
} from './types';

// ────────────────────────────────────────────────────────────────────
// Thresholds
// ────────────────────────────────────────────────────────────────────

/** All overlay modes that must be tested */
export const REQUIRED_MODES: readonly OverlayMode[] = ['compact', 'expanded', 'maximized'] as const;

/** All scale factors that must be tested */
export const REQUIRED_SCALE_FACTORS: readonly ScaleFactor[] = [100, 125, 150, 200] as const;

/** Maximum nonzero-alpha pixels in declared transparent regions */
export const MAX_NONZERO_ALPHA_PIXELS = 0;

/** Maximum partial-alpha error in 8-bit units (0–255) */
export const MAX_PARTIAL_ALPHA_ERROR = 1;

// ────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────

/**
 * Validates a single transparency analysis result.
 * Returns an array of violation descriptions (empty if valid).
 */
export function validateTransparencyAnalysis(analysis: TransparencyAnalysis): readonly string[] {
  const violations: string[] = [];
  const label = `${analysis.mode}@${analysis.scaleFactor}%`;

  if (analysis.nonzeroAlphaPixelCount > MAX_NONZERO_ALPHA_PIXELS) {
    violations.push(
      `${label}: ${analysis.nonzeroAlphaPixelCount} nonzero-alpha pixel(s) in transparent regions (max ${MAX_NONZERO_ALPHA_PIXELS})`,
    );
  }

  if (analysis.maxPartialAlphaError > MAX_PARTIAL_ALPHA_ERROR) {
    violations.push(
      `${label}: partial-alpha error ${analysis.maxPartialAlphaError} exceeds max ${MAX_PARTIAL_ALPHA_ERROR}`,
    );
  }

  return violations;
}

// ────────────────────────────────────────────────────────────────────
// Gate Execution
// ────────────────────────────────────────────────────────────────────

/**
 * Executes the transparency gate for a single environment row.
 *
 * Tests every combination of REQUIRED_MODES × REQUIRED_SCALE_FACTORS
 * and validates alpha correctness in declared transparent regions.
 *
 * Requirement 17.8: compact/expanded/maximized at 100/125/150/200%,
 * zero nonzero-alpha pixels, partial-alpha error ≤ 1.
 */
export async function executeTransparencyGate(
  env: EnvironmentMatrixRow,
  buildContext: GateBuildContext,
  deps: TransparencyGateDeps,
): Promise<GateResultRecord> {
  const allViolations: string[] = [];
  const analyses: TransparencyAnalysis[] = [];

  for (const mode of REQUIRED_MODES) {
    for (const scaleFactor of REQUIRED_SCALE_FACTORS) {
      const analysis = await deps.analyzeTransparency(env, mode, scaleFactor);
      analyses.push(analysis);

      const violations = validateTransparencyAnalysis(analysis);
      allViolations.push(...violations);
    }
  }

  const verdict = allViolations.length === 0 ? 'pass' : 'fail';

  const rawMeasurementSummary = JSON.stringify({
    gate: ReleaseGateId.TRANSPARENCY,
    totalCombinations: REQUIRED_MODES.length * REQUIRED_SCALE_FACTORS.length,
    analyses: analyses.map((a) => ({
      mode: a.mode,
      scaleFactor: a.scaleFactor,
      nonzeroAlphaPixelCount: a.nonzeroAlphaPixelCount,
      maxPartialAlphaError: a.maxPartialAlphaError,
    })),
    violations: allViolations,
    thresholds: {
      maxNonzeroAlphaPixels: MAX_NONZERO_ALPHA_PIXELS,
      maxPartialAlphaError: MAX_PARTIAL_ALPHA_ERROR,
      requiredModes: REQUIRED_MODES,
      requiredScaleFactors: REQUIRED_SCALE_FACTORS,
    },
  });

  return {
    gateId: ReleaseGateId.TRANSPARENCY,
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
