/**
 * Stage C Release Gate — Scope-and-Honesty Gate.
 *
 * Verifies continued Dashboard, process, module, child-window, and
 * WebView2 Runtime observability. Asserts zero undetectability, evasion,
 * capture-impossibility, or impersonation claims in release material.
 *
 * Requirement 17.5
 */

import type { EnvironmentMatrixRow, GateResultRecord } from '../types';
import { ReleaseGateId } from '../types';
import type {
  GateBuildContext,
  ScopeHonestyGateDeps,
  ObservabilityReport,
  ClaimScanResult,
} from './types';

// ────────────────────────────────────────────────────────────────────
// Thresholds
// ────────────────────────────────────────────────────────────────────

/** Maximum allowed prohibited claims in release material (per category) */
export const MAX_UNDETECTABILITY_CLAIMS = 0;
export const MAX_EVASION_CLAIMS = 0;
export const MAX_CAPTURE_IMPOSSIBILITY_CLAIMS = 0;
export const MAX_IMPERSONATION_CLAIMS = 0;

// ────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────

/**
 * Validates that all required components remain observable.
 * Returns an array of violation descriptions (empty if valid).
 */
export function validateObservability(report: ObservabilityReport): readonly string[] {
  const violations: string[] = [];

  if (!report.dashboardObservable) {
    violations.push('Dashboard is not observable');
  }
  if (!report.processObservable) {
    violations.push('Process tree is not observable');
  }
  if (!report.moduleObservable) {
    violations.push('Loaded modules are not observable');
  }
  if (!report.childWindowObservable) {
    violations.push('Child windows are not observable');
  }
  if (!report.webView2Observable) {
    violations.push('WebView2 Runtime artifacts are not observable');
  }

  return violations;
}

/**
 * Validates that release material contains zero prohibited claims.
 * Returns an array of violation descriptions (empty if valid).
 */
export function validateClaimScan(scan: ClaimScanResult): readonly string[] {
  const violations: string[] = [];

  if (scan.undetectabilityClaims > MAX_UNDETECTABILITY_CLAIMS) {
    violations.push(
      `${scan.undetectabilityClaims} undetectability claim(s) found (max ${MAX_UNDETECTABILITY_CLAIMS})`,
    );
  }
  if (scan.evasionClaims > MAX_EVASION_CLAIMS) {
    violations.push(
      `${scan.evasionClaims} evasion claim(s) found (max ${MAX_EVASION_CLAIMS})`,
    );
  }
  if (scan.captureImpossibilityClaims > MAX_CAPTURE_IMPOSSIBILITY_CLAIMS) {
    violations.push(
      `${scan.captureImpossibilityClaims} capture-impossibility claim(s) found (max ${MAX_CAPTURE_IMPOSSIBILITY_CLAIMS})`,
    );
  }
  if (scan.impersonationClaims > MAX_IMPERSONATION_CLAIMS) {
    violations.push(
      `${scan.impersonationClaims} impersonation claim(s) found (max ${MAX_IMPERSONATION_CLAIMS})`,
    );
  }

  return violations;
}

// ────────────────────────────────────────────────────────────────────
// Gate Execution
// ────────────────────────────────────────────────────────────────────

/**
 * Executes the scope-and-honesty gate for a single environment row.
 *
 * Verifies:
 * 1. Dashboard, process, module, child-window, and WebView2 observability
 * 2. Zero prohibited claims in release material
 *
 * Requirement 17.5: Continued observability, zero prohibited claims.
 */
export async function executeScopeHonestyGate(
  env: EnvironmentMatrixRow,
  buildContext: GateBuildContext,
  deps: ScopeHonestyGateDeps,
): Promise<GateResultRecord> {
  const allViolations: string[] = [];

  // Step 1: Verify observability
  const observability = await deps.verifyObservability(env);
  const observabilityViolations = validateObservability(observability);
  allViolations.push(...observabilityViolations);

  // Step 2: Scan release material for prohibited claims
  const claimScan = await deps.scanReleaseMaterial();
  const claimViolations = validateClaimScan(claimScan);
  allViolations.push(...claimViolations);

  const verdict = allViolations.length === 0 ? 'pass' : 'fail';

  const rawMeasurementSummary = JSON.stringify({
    gate: ReleaseGateId.SCOPE_HONESTY,
    observability: {
      dashboardObservable: observability.dashboardObservable,
      processObservable: observability.processObservable,
      moduleObservable: observability.moduleObservable,
      childWindowObservable: observability.childWindowObservable,
      webView2Observable: observability.webView2Observable,
    },
    claimScan: {
      undetectabilityClaims: claimScan.undetectabilityClaims,
      evasionClaims: claimScan.evasionClaims,
      captureImpossibilityClaims: claimScan.captureImpossibilityClaims,
      impersonationClaims: claimScan.impersonationClaims,
    },
    violations: allViolations,
    thresholds: {
      maxUndetectabilityClaims: MAX_UNDETECTABILITY_CLAIMS,
      maxEvasionClaims: MAX_EVASION_CLAIMS,
      maxCaptureImpossibilityClaims: MAX_CAPTURE_IMPOSSIBILITY_CLAIMS,
      maxImpersonationClaims: MAX_IMPERSONATION_CLAIMS,
    },
  });

  return {
    gateId: ReleaseGateId.SCOPE_HONESTY,
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
