/**
 * Stage C Release Gate — Decision Unit Tests.
 *
 * Tests the fail-closed release decision logic: environment matrix,
 * evidence schema validation, waiver rejection, and build hash binding.
 *
 * Requirements: 17.1–17.3, 17.23–17.26
 */

import { describe, it, expect } from 'vitest';

import {
  evaluateReleaseDecision,
  generateEnvironmentMatrix,
  getExpectedMatrixRowCount,
  matrixRowKey,
  validateMatrixCompleteness,
  SUPPORTED_OS_BUILDS,
  DISTRIBUTED_ARCHITECTURES,
  SUPPORTED_WEBVIEW2_VERSIONS,
  ALL_GATE_IDS,
  ReleaseGateId,
  type ReleaseEvidenceSet,
  type GateResultRecord,
  type EnvironmentMatrixRow,
} from '../../../stageC/releaseGate';

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

const TEST_BUILD_HASH = 'a'.repeat(64);
const TEST_ASSEMBLED_AT = '2025-01-15T10:00:00.000Z';

function makePassingRecord(
  gateId: ReleaseGateId,
  row: EnvironmentMatrixRow,
): GateResultRecord {
  return {
    gateId,
    buildHash: TEST_BUILD_HASH,
    osBuild: row.osBuild,
    architecture: row.architecture,
    webView2Version: row.webView2Version,
    appVersion: '1.0.0',
    sidecarVersion: '1.0.0',
    rawMeasurementSummary: `${gateId}: all checks passed`,
    verdict: 'pass',
    executedAt: '2025-01-15T09:30:00.000Z',
  };
}

function buildCompletePassingEvidence(): ReleaseEvidenceSet {
  const matrix = generateEnvironmentMatrix();
  const results: GateResultRecord[] = [];

  for (const gateId of ALL_GATE_IDS) {
    for (const row of matrix) {
      results.push(makePassingRecord(gateId, row));
    }
  }

  return {
    buildHash: TEST_BUILD_HASH,
    artifactHashes: {
      'stage-c/ZuleUI.exe': 'b'.repeat(64),
      'stage-c/manifest.json': 'c'.repeat(64),
    },
    matrix,
    results,
    assembledAt: TEST_ASSEMBLED_AT,
  };
}

// ────────────────────────────────────────────────────────────────────
// Environment Matrix Tests
// ────────────────────────────────────────────────────────────────────

describe('Environment Matrix', () => {
  it('enumerates Windows 10 22H2', () => {
    expect(SUPPORTED_OS_BUILDS).toContain('win10_22h2');
  });

  it('enumerates Windows 11 23H2 or newer', () => {
    expect(SUPPORTED_OS_BUILDS).toContain('win11_23h2');
    expect(SUPPORTED_OS_BUILDS).toContain('win11_24h2');
  });

  it('enumerates at least one distributed architecture', () => {
    expect(DISTRIBUTED_ARCHITECTURES.length).toBeGreaterThanOrEqual(1);
    expect(DISTRIBUTED_ARCHITECTURES).toContain('x64');
  });

  it('enumerates supported WebView2 versions', () => {
    expect(SUPPORTED_WEBVIEW2_VERSIONS.length).toBeGreaterThanOrEqual(1);
  });

  it('generates the Cartesian product of OS × arch × WebView2', () => {
    const matrix = generateEnvironmentMatrix();
    const expectedCount =
      SUPPORTED_OS_BUILDS.length *
      DISTRIBUTED_ARCHITECTURES.length *
      SUPPORTED_WEBVIEW2_VERSIONS.length;

    expect(matrix.length).toBe(expectedCount);
    expect(getExpectedMatrixRowCount()).toBe(expectedCount);
  });

  it('each matrix row has all required fields', () => {
    const matrix = generateEnvironmentMatrix();
    for (const row of matrix) {
      expect(row.osBuild).toBeTruthy();
      expect(row.architecture).toBeTruthy();
      expect(row.webView2Version).toBeTruthy();
    }
  });

  it('generates unique keys for each row', () => {
    const matrix = generateEnvironmentMatrix();
    const keys = matrix.map(matrixRowKey);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(matrix.length);
  });

  it('validates complete matrix as valid', () => {
    const matrix = generateEnvironmentMatrix();
    const errors = validateMatrixCompleteness(matrix);
    expect(errors).toHaveLength(0);
  });

  it('reports missing rows in incomplete matrix', () => {
    const matrix = generateEnvironmentMatrix().slice(1); // Remove first row
    const errors = validateMatrixCompleteness(matrix);
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// Fail-Closed Decision Tests
// ────────────────────────────────────────────────────────────────────

describe('Release Decision — Fail-Closed Logic', () => {
  it('approves when all gates pass for all matrix rows', () => {
    const evidence = buildCompletePassingEvidence();
    const decision = evaluateReleaseDecision(evidence, { env: {} });

    expect(decision.outcome).toBe('approved');
    expect(decision.buildHash).toBe(TEST_BUILD_HASH);
    expect(decision.approvalId).toBeTruthy();
    expect(decision.failures).toHaveLength(0);
  });

  it('fails when evidence set has empty buildHash', () => {
    const evidence = buildCompletePassingEvidence();
    const modified: ReleaseEvidenceSet = { ...evidence, buildHash: '' };
    const decision = evaluateReleaseDecision(modified, { env: {} });

    expect(decision.outcome).toBe('failed');
    expect(decision.buildHash).toBeNull();
    expect(decision.approvalId).toBeNull();
  });

  it('fails when evidence set has empty artifactHashes', () => {
    const evidence = buildCompletePassingEvidence();
    const modified: ReleaseEvidenceSet = { ...evidence, artifactHashes: {} };
    const decision = evaluateReleaseDecision(modified, { env: {} });

    expect(decision.outcome).toBe('failed');
  });

  it('fails when evidence set has empty matrix', () => {
    const evidence = buildCompletePassingEvidence();
    const modified: ReleaseEvidenceSet = { ...evidence, matrix: [] };
    const decision = evaluateReleaseDecision(modified, { env: {} });

    expect(decision.outcome).toBe('failed');
  });

  it('fails when assembledAt timestamp is missing', () => {
    const evidence = buildCompletePassingEvidence();
    const modified: ReleaseEvidenceSet = { ...evidence, assembledAt: '' };
    const decision = evaluateReleaseDecision(modified, { env: {} });

    expect(decision.outcome).toBe('failed');
  });

  it('fails when a matrix row is missing from evidence', () => {
    const evidence = buildCompletePassingEvidence();
    // Remove the first row from the matrix
    const incompleteMatrix = evidence.matrix.slice(1);
    const modified: ReleaseEvidenceSet = { ...evidence, matrix: incompleteMatrix };
    const decision = evaluateReleaseDecision(modified, { env: {} });

    expect(decision.outcome).toBe('failed');
    expect(decision.failures.some((f) => f.reason.includes('Missing required environment matrix row'))).toBe(true);
  });

  it('fails when a gate result is missing for a row', () => {
    const evidence = buildCompletePassingEvidence();
    // Remove the last result
    const incompleteResults = evidence.results.slice(0, -1);
    const modified: ReleaseEvidenceSet = { ...evidence, results: incompleteResults };
    const decision = evaluateReleaseDecision(modified, { env: {} });

    expect(decision.outcome).toBe('failed');
    expect(decision.failures.some((f) => f.reason.includes('Missing result for gate'))).toBe(true);
  });

  it('fails when any gate verdict is "fail"', () => {
    const evidence = buildCompletePassingEvidence();
    const results = [...evidence.results];
    // Make one result fail
    const failedRecord: GateResultRecord = {
      ...results[0],
      verdict: 'fail',
    };
    results[0] = failedRecord;
    const modified: ReleaseEvidenceSet = { ...evidence, results };
    const decision = evaluateReleaseDecision(modified, { env: {} });

    expect(decision.outcome).toBe('failed');
    expect(decision.failures.some((f) => f.reason.includes('failed on environment row'))).toBe(true);
  });

  it('fails when a result has mismatched buildHash', () => {
    const evidence = buildCompletePassingEvidence();
    const results = [...evidence.results];
    const mismatchedRecord: GateResultRecord = {
      ...results[0],
      buildHash: 'f'.repeat(64),
    };
    results[0] = mismatchedRecord;
    const modified: ReleaseEvidenceSet = { ...evidence, results };
    const decision = evaluateReleaseDecision(modified, { env: {} });

    expect(decision.outcome).toBe('failed');
    expect(decision.failures.some((f) => f.reason.includes('does not match evidence set buildHash'))).toBe(true);
  });

  it('fails when a result has empty rawMeasurementSummary', () => {
    const evidence = buildCompletePassingEvidence();
    const results = [...evidence.results];
    const invalidRecord: GateResultRecord = {
      ...results[0],
      rawMeasurementSummary: '',
    };
    results[0] = invalidRecord;
    const modified: ReleaseEvidenceSet = { ...evidence, results };
    const decision = evaluateReleaseDecision(modified, { env: {} });

    expect(decision.outcome).toBe('failed');
    expect(decision.failures.some((f) => f.reason.includes('rawMeasurementSummary'))).toBe(true);
  });

  it('fails when results array is empty', () => {
    const evidence = buildCompletePassingEvidence();
    const modified: ReleaseEvidenceSet = { ...evidence, results: [] };
    const decision = evaluateReleaseDecision(modified, { env: {} });

    expect(decision.outcome).toBe('failed');
  });

  it('binds approval to the exact build hash', () => {
    const evidence = buildCompletePassingEvidence();
    const decision = evaluateReleaseDecision(evidence, { env: {} });

    expect(decision.outcome).toBe('approved');
    expect(decision.buildHash).toBe(TEST_BUILD_HASH);
    // Different build hash should produce different approval
    const evidence2: ReleaseEvidenceSet = {
      ...evidence,
      buildHash: 'z'.repeat(64),
      results: evidence.results.map((r) => ({ ...r, buildHash: 'z'.repeat(64) })),
    };
    const decision2 = evaluateReleaseDecision(evidence2, { env: {} });
    expect(decision2.outcome).toBe('approved');
    expect(decision2.approvalId).not.toBe(decision.approvalId);
  });
});

// ────────────────────────────────────────────────────────────────────
// Waiver Rejection Tests (Req 17.26)
// ────────────────────────────────────────────────────────────────────

describe('Release Decision — Waiver Rejection', () => {
  it('rejects waiver via STAGE_C_FORCE_APPROVE env var', () => {
    const evidence = buildCompletePassingEvidence();
    const decision = evaluateReleaseDecision(evidence, {
      env: { STAGE_C_FORCE_APPROVE: 'true' },
    });

    expect(decision.outcome).toBe('failed');
    expect(decision.failures.some((f) => f.reason.includes('STAGE_C_FORCE_APPROVE'))).toBe(true);
  });

  it('rejects waiver via STAGE_C_SKIP_GATES env var', () => {
    const evidence = buildCompletePassingEvidence();
    const decision = evaluateReleaseDecision(evidence, {
      env: { STAGE_C_SKIP_GATES: '1' },
    });

    expect(decision.outcome).toBe('failed');
    expect(decision.failures.some((f) => f.reason.includes('STAGE_C_SKIP_GATES'))).toBe(true);
  });

  it('rejects waiver via STAGE_C_WAIVER env var', () => {
    const evidence = buildCompletePassingEvidence();
    const decision = evaluateReleaseDecision(evidence, {
      env: { STAGE_C_WAIVER: 'granted' },
    });

    expect(decision.outcome).toBe('failed');
    expect(decision.failures.some((f) => f.reason.includes('STAGE_C_WAIVER'))).toBe(true);
  });

  it('rejects waiver via STAGE_C_OVERRIDE env var', () => {
    const evidence = buildCompletePassingEvidence();
    const decision = evaluateReleaseDecision(evidence, {
      env: { STAGE_C_OVERRIDE: 'yes' },
    });

    expect(decision.outcome).toBe('failed');
    expect(decision.failures.some((f) => f.reason.includes('STAGE_C_OVERRIDE'))).toBe(true);
  });

  it('rejects waiver via ZULE_RELEASE_GATE_BYPASS env var', () => {
    const evidence = buildCompletePassingEvidence();
    const decision = evaluateReleaseDecision(evidence, {
      env: { ZULE_RELEASE_GATE_BYPASS: '1' },
    });

    expect(decision.outcome).toBe('failed');
    expect(decision.failures.some((f) => f.reason.includes('ZULE_RELEASE_GATE_BYPASS'))).toBe(true);
  });

  it('rejects waiver via ZULE_FORCE_STAGE_C env var', () => {
    const evidence = buildCompletePassingEvidence();
    const decision = evaluateReleaseDecision(evidence, {
      env: { ZULE_FORCE_STAGE_C: 'enabled' },
    });

    expect(decision.outcome).toBe('failed');
    expect(decision.failures.some((f) => f.reason.includes('ZULE_FORCE_STAGE_C'))).toBe(true);
  });

  it('does not reject when waiver env vars are absent', () => {
    const evidence = buildCompletePassingEvidence();
    const decision = evaluateReleaseDecision(evidence, { env: {} });

    expect(decision.outcome).toBe('approved');
    expect(decision.failures).toHaveLength(0);
  });

  it('does not reject when waiver env vars are empty string', () => {
    const evidence = buildCompletePassingEvidence();
    const decision = evaluateReleaseDecision(evidence, {
      env: { STAGE_C_FORCE_APPROVE: '' },
    });

    expect(decision.outcome).toBe('approved');
  });
});

// ────────────────────────────────────────────────────────────────────
// Gate ID completeness
// ────────────────────────────────────────────────────────────────────

describe('Release Gate IDs', () => {
  it('includes all expected gates from requirements', () => {
    expect(ALL_GATE_IDS).toContain(ReleaseGateId.METADATA);
    expect(ALL_GATE_IDS).toContain(ReleaseGateId.SCOPE_HONESTY);
    expect(ALL_GATE_IDS).toContain(ReleaseGateId.RUNTIME_PROBE);
    expect(ALL_GATE_IDS).toContain(ReleaseGateId.STARTUP);
    expect(ALL_GATE_IDS).toContain(ReleaseGateId.TRANSPARENCY);
    expect(ALL_GATE_IDS).toContain(ReleaseGateId.INPUT);
    expect(ALL_GATE_IDS).toContain(ReleaseGateId.GEOMETRY);
    expect(ALL_GATE_IDS).toContain(ReleaseGateId.IPC_SECURITY);
    expect(ALL_GATE_IDS).toContain(ReleaseGateId.BRIDGE_SECURITY);
    expect(ALL_GATE_IDS).toContain(ReleaseGateId.CAPTURE);
    expect(ALL_GATE_IDS).toContain(ReleaseGateId.CAPTURE_FALLBACK);
    expect(ALL_GATE_IDS).toContain(ReleaseGateId.FALLBACK);
    expect(ALL_GATE_IDS).toContain(ReleaseGateId.DIAGNOSTIC_RETRY);
    expect(ALL_GATE_IDS).toContain(ReleaseGateId.PERFORMANCE);
    expect(ALL_GATE_IDS).toContain(ReleaseGateId.STABILITY);
    expect(ALL_GATE_IDS).toContain(ReleaseGateId.PACKAGING);
    expect(ALL_GATE_IDS).toContain(ReleaseGateId.TELEMETRY_PRIVACY);
    expect(ALL_GATE_IDS).toContain(ReleaseGateId.TELEMETRY_SCHEMA);
    expect(ALL_GATE_IDS).toContain(ReleaseGateId.STATE_UPDATE);
  });

  it('has no duplicate gate IDs', () => {
    const uniqueIds = new Set(ALL_GATE_IDS);
    expect(uniqueIds.size).toBe(ALL_GATE_IDS.length);
  });
});
