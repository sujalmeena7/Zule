/**
 * Stage C Release Gate — Fail-Closed Release Decision.
 *
 * Implements the production release decision function that returns `approved`
 * ONLY when every gate has complete passing evidence for every matrix row
 * and distributed artifact. Any missing row, gate, field, measurement, or
 * result causes immediate failure.
 *
 * Waiver rejection: No runtime flag, environment variable, persisted setting,
 * remote content, or diagnostic retry can override a failed or incomplete gate.
 *
 * Requirements: 17.23–17.26
 */

import { createHash } from 'node:crypto';

import {
  type ReleaseEvidenceSet,
  type ReleaseDecision,
  type ReleaseDecisionFailure,
  type GateResultRecord,
  type EnvironmentMatrixRow,
  ALL_GATE_IDS,
  type ReleaseGateId,
} from './types';

import {
  generateEnvironmentMatrix,
  matrixRowKey,
} from './environmentMatrix';

// ────────────────────────────────────────────────────────────────────
// Waiver Rejection (Req 17.26)
// ────────────────────────────────────────────────────────────────────

/**
 * Environment variable names that are explicitly checked and rejected
 * as waiver sources. Their presence does NOT override the decision.
 */
const REJECTED_WAIVER_ENV_VARS: readonly string[] = [
  'STAGE_C_FORCE_APPROVE',
  'STAGE_C_SKIP_GATES',
  'STAGE_C_WAIVER',
  'STAGE_C_OVERRIDE',
  'ZULE_RELEASE_GATE_BYPASS',
  'ZULE_FORCE_STAGE_C',
] as const;

/**
 * Checks that no waiver injection is active. This function does NOT read
 * values to act on them — it detects and rejects their presence.
 *
 * Requirement 17.26: Reject production gate waivers supplied through
 * runtime flags, environment variables, persisted settings, remote content,
 * or diagnostic retry.
 *
 * @returns Array of waiver rejection failure reasons (empty if none detected)
 */
function detectWaiverAttempts(env: Readonly<Record<string, string | undefined>>): readonly ReleaseDecisionFailure[] {
  const failures: ReleaseDecisionFailure[] = [];

  for (const envVar of REJECTED_WAIVER_ENV_VARS) {
    if (env[envVar] !== undefined && env[envVar] !== '') {
      failures.push({
        reason: `Rejected waiver attempt via environment variable: ${envVar}`,
      });
    }
  }

  return failures;
}

// ────────────────────────────────────────────────────────────────────
// Evidence Validation
// ────────────────────────────────────────────────────────────────────

/**
 * Validates that a GateResultRecord has all required fields populated.
 * Missing or empty fields cause rejection.
 *
 * Requirement 17.23: Missing evidence field → failed.
 */
function validateRecordFields(record: GateResultRecord): readonly string[] {
  const errors: string[] = [];

  if (!record.gateId) {
    errors.push('Missing gateId');
  }
  if (!record.buildHash || record.buildHash.length === 0) {
    errors.push('Missing buildHash');
  }
  if (!record.osBuild || record.osBuild.length === 0) {
    errors.push('Missing osBuild');
  }
  if (!record.architecture || record.architecture.length === 0) {
    errors.push('Missing architecture');
  }
  if (!record.webView2Version || record.webView2Version.length === 0) {
    errors.push('Missing webView2Version');
  }
  if (!record.appVersion || record.appVersion.length === 0) {
    errors.push('Missing appVersion');
  }
  if (!record.sidecarVersion || record.sidecarVersion.length === 0) {
    errors.push('Missing sidecarVersion');
  }
  if (!record.rawMeasurementSummary || record.rawMeasurementSummary.length === 0) {
    errors.push('Missing rawMeasurementSummary');
  }
  if (record.verdict !== 'pass' && record.verdict !== 'fail') {
    errors.push('Invalid verdict — must be "pass" or "fail"');
  }
  if (!record.executedAt || record.executedAt.length === 0) {
    errors.push('Missing executedAt timestamp');
  }

  return errors;
}

/**
 * Validates that a result record's build hash matches the evidence set's
 * declared build hash. Mismatched hashes are rejected.
 */
function validateBuildHashBinding(
  record: GateResultRecord,
  expectedBuildHash: string,
): string | null {
  if (record.buildHash !== expectedBuildHash) {
    return `Result for gate '${record.gateId}' has buildHash '${record.buildHash.slice(0, 16)}...' which does not match evidence set buildHash '${expectedBuildHash.slice(0, 16)}...'`;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────
// Approval Identifier Generation
// ────────────────────────────────────────────────────────────────────

/**
 * Generates a deterministic approval identifier from the build hash
 * and evidence assembly timestamp. This identifier is bound to the
 * exact build and evidence.
 */
function generateApprovalId(buildHash: string, assembledAt: string): string {
  const input = `${buildHash}:${assembledAt}:stage-c-release-approved`;
  return createHash('sha256').update(input).digest('hex');
}

// ────────────────────────────────────────────────────────────────────
// Fail-Closed Release Decision
// ────────────────────────────────────────────────────────────────────

/**
 * Options for the release decision function. Allows dependency injection
 * of the environment for waiver detection without reading process.env
 * directly in unit tests.
 */
export interface ReleaseDecisionOptions {
  /**
   * Environment variable map to check for waiver attempts.
   * Defaults to process.env if not provided.
   */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Evaluates the fail-closed production release decision.
 *
 * Returns `approved` ONLY when ALL of the following are true:
 * 1. No waiver injection is detected (Req 17.26)
 * 2. The evidence set has a valid build hash and artifact hashes
 * 3. The matrix is complete (all required rows present)
 * 4. Every gate has been executed for every matrix row
 * 5. Every result record has all required fields populated
 * 6. Every result record is bound to the correct build hash
 * 7. Every result record has verdict 'pass'
 *
 * If ANY of the above fails, the decision is 'failed' with detailed reasons.
 *
 * Requirement 17.23: Missing row, gate result, field, measurement → failed.
 * Requirement 17.24: Approve only when every gate passes for every row/artifact.
 * Requirement 17.25: Keep Stage C disabled on any failure.
 * Requirement 17.26: Reject waivers from flags, env vars, settings, remote, retry.
 *
 * @param evidence - The complete evidence set to evaluate
 * @param options - Optional configuration for dependency injection
 * @returns The release decision with outcome, approval ID, and failure reasons
 */
export function evaluateReleaseDecision(
  evidence: ReleaseEvidenceSet,
  options?: ReleaseDecisionOptions,
): ReleaseDecision {
  const failures: ReleaseDecisionFailure[] = [];
  const env = options?.env ?? (process.env as Readonly<Record<string, string | undefined>>);

  // ──────────────────────────────────────────────────────────────────
  // Step 1: Reject any waiver injection attempts (Req 17.26)
  // ──────────────────────────────────────────────────────────────────
  const waiverFailures = detectWaiverAttempts(env);
  failures.push(...waiverFailures);

  // ──────────────────────────────────────────────────────────────────
  // Step 2: Validate evidence set top-level fields
  // ──────────────────────────────────────────────────────────────────
  if (!evidence.buildHash || evidence.buildHash.length === 0) {
    failures.push({ reason: 'Evidence set missing buildHash' });
    return buildFailedDecision(failures);
  }

  if (
    !evidence.artifactHashes ||
    typeof evidence.artifactHashes !== 'object' ||
    Object.keys(evidence.artifactHashes).length === 0
  ) {
    failures.push({ reason: 'Evidence set missing or empty artifactHashes' });
    return buildFailedDecision(failures);
  }

  if (!evidence.assembledAt || evidence.assembledAt.length === 0) {
    failures.push({ reason: 'Evidence set missing assembledAt timestamp' });
    return buildFailedDecision(failures);
  }

  // ──────────────────────────────────────────────────────────────────
  // Step 3: Validate matrix completeness (Req 17.1, 17.23)
  // ──────────────────────────────────────────────────────────────────
  if (!evidence.matrix || evidence.matrix.length === 0) {
    failures.push({ reason: 'Evidence set has empty environment matrix' });
    return buildFailedDecision(failures);
  }

  const expectedMatrix = generateEnvironmentMatrix();
  const expectedRowKeys = new Set(expectedMatrix.map(matrixRowKey));
  const actualRowKeys = new Set(evidence.matrix.map(matrixRowKey));

  for (const expectedKey of expectedRowKeys) {
    if (!actualRowKeys.has(expectedKey)) {
      failures.push({
        reason: `Missing required environment matrix row: ${expectedKey}`,
      });
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Step 4: Check coverage — every (gate × row) must have a result
  // ──────────────────────────────────────────────────────────────────
  if (!evidence.results || evidence.results.length === 0) {
    failures.push({ reason: 'Evidence set has no gate results' });
    return buildFailedDecision(failures);
  }

  // Build a lookup map: key = "gateId|rowKey" → result
  const resultMap = new Map<string, GateResultRecord>();
  for (const result of evidence.results) {
    const rowKey = `${result.osBuild}|${result.architecture}|${result.webView2Version}`;
    const compositeKey = `${result.gateId}|${rowKey}`;
    resultMap.set(compositeKey, result);
  }

  // Check that every gate has a result for every required matrix row
  for (const gateId of ALL_GATE_IDS) {
    for (const row of expectedMatrix) {
      const rowKey = matrixRowKey(row);
      const compositeKey = `${gateId}|${rowKey}`;
      const result = resultMap.get(compositeKey);

      if (!result) {
        failures.push({
          reason: `Missing result for gate '${gateId}' on environment row '${rowKey}'`,
          gateId,
          matrixRow: row,
        });
        continue;
      }

      // Step 5: Validate record fields (Req 17.23)
      const fieldErrors = validateRecordFields(result);
      for (const fieldError of fieldErrors) {
        failures.push({
          reason: `Gate '${gateId}' row '${rowKey}': ${fieldError}`,
          gateId,
          matrixRow: row,
        });
      }

      // Step 6: Validate build hash binding
      const hashError = validateBuildHashBinding(result, evidence.buildHash);
      if (hashError !== null) {
        failures.push({
          reason: hashError,
          gateId,
          matrixRow: row,
        });
      }

      // Step 7: Check verdict (Req 17.24)
      if (result.verdict !== 'pass') {
        failures.push({
          reason: `Gate '${gateId}' failed on environment row '${rowKey}'`,
          gateId,
          matrixRow: row,
        });
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Final Decision
  // ──────────────────────────────────────────────────────────────────
  if (failures.length > 0) {
    return buildFailedDecision(failures);
  }

  // All gates pass for all rows — approve and bind to build hash
  const approvalId = generateApprovalId(evidence.buildHash, evidence.assembledAt);

  return {
    outcome: 'approved',
    buildHash: evidence.buildHash,
    approvalId,
    failures: [],
  };
}

/**
 * Builds a failed release decision with the given failure reasons.
 */
function buildFailedDecision(failures: readonly ReleaseDecisionFailure[]): ReleaseDecision {
  return {
    outcome: 'failed',
    buildHash: null,
    approvalId: null,
    failures,
  };
}
