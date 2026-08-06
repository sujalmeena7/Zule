/**
 * Stage C Release Gate — Evidence Assembler Tests.
 *
 * Verifies that the evidence assembler:
 * - Emits an approval identifier ONLY when every result passes
 * - Rejects incomplete matrix coverage
 * - Signs evidence deterministically by build hash
 * - Validates gate × row completeness
 *
 * Requirements: 3.10, 17.1–17.3, 17.23–17.24
 */

import { describe, it, expect } from 'vitest';

import {
  assembleEvidenceAt,
  validateGateMatrixCompleteness,
  computeEvidenceSignature,
  type EvidenceAssemblyInput,
} from '../../../stageC/releaseGate/evidenceAssembler';

import {
  ALL_GATE_IDS,
  type GateResultRecord,
  type EnvironmentMatrixRow,
  type ReleaseGateId,
  ReleaseGateId as GateId,
} from '../../../stageC/releaseGate/types';

import {
  generateEnvironmentMatrix,
} from '../../../stageC/releaseGate/environmentMatrix';

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

const TEST_BUILD_HASH = 'a'.repeat(64);
const TEST_ASSEMBLED_AT = '2025-01-15T10:00:00.000Z';
const TEST_ARTIFACT_HASHES: Record<string, string> = {
  'stage-c/ZuleUI.exe': 'b'.repeat(64),
  'stage-c/manifest.json': 'c'.repeat(64),
};

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
    rawMeasurementSummary: JSON.stringify({ gate: gateId, status: 'pass' }),
    verdict: 'pass',
    executedAt: '2025-01-15T09:55:00.000Z',
  };
}

function makeFailingRecord(
  gateId: ReleaseGateId,
  row: EnvironmentMatrixRow,
): GateResultRecord {
  return {
    ...makePassingRecord(gateId, row),
    verdict: 'fail',
    rawMeasurementSummary: JSON.stringify({ gate: gateId, status: 'fail', reason: 'threshold exceeded' }),
  };
}

function makeCompletePassingResults(): GateResultRecord[] {
  const matrix = generateEnvironmentMatrix();
  const results: GateResultRecord[] = [];

  for (const gateId of ALL_GATE_IDS) {
    for (const row of matrix) {
      results.push(makePassingRecord(gateId, row));
    }
  }

  return results;
}

function makeInput(results: GateResultRecord[]): EvidenceAssemblyInput {
  return {
    buildHash: TEST_BUILD_HASH,
    artifactHashes: TEST_ARTIFACT_HASHES,
    results,
  };
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

describe('Evidence Assembler', () => {
  describe('assembleEvidenceAt', () => {
    it('emits approval identifier when every gate passes for every row', () => {
      const results = makeCompletePassingResults();
      const archive = assembleEvidenceAt(makeInput(results), TEST_ASSEMBLED_AT);

      expect(archive.decision.outcome).toBe('approved');
      expect(archive.decision.approvalId).not.toBeNull();
      expect(archive.decision.approvalId).toHaveLength(64); // SHA-256 hex
      expect(archive.decision.buildHash).toBe(TEST_BUILD_HASH);
      expect(archive.decision.failures).toHaveLength(0);
    });

    it('does NOT emit approval when any gate fails', () => {
      const matrix = generateEnvironmentMatrix();
      const results = makeCompletePassingResults();

      // Replace one passing result with a failing one
      const targetGate = GateId.PERFORMANCE;
      const targetRow = matrix[0];
      const idx = results.findIndex(
        (r) =>
          r.gateId === targetGate &&
          r.osBuild === targetRow.osBuild &&
          r.architecture === targetRow.architecture &&
          r.webView2Version === targetRow.webView2Version,
      );
      results[idx] = makeFailingRecord(targetGate, targetRow);

      const archive = assembleEvidenceAt(makeInput(results), TEST_ASSEMBLED_AT);

      expect(archive.decision.outcome).toBe('failed');
      expect(archive.decision.approvalId).toBeNull();
      expect(archive.decision.failures.length).toBeGreaterThan(0);
    });

    it('does NOT emit approval when a gate result is missing', () => {
      const results = makeCompletePassingResults();

      // Remove one result
      results.pop();

      const archive = assembleEvidenceAt(makeInput(results), TEST_ASSEMBLED_AT);

      expect(archive.decision.outcome).toBe('failed');
      expect(archive.decision.approvalId).toBeNull();
    });

    it('does NOT emit approval when results array is empty', () => {
      const archive = assembleEvidenceAt(makeInput([]), TEST_ASSEMBLED_AT);

      expect(archive.decision.outcome).toBe('failed');
      expect(archive.decision.approvalId).toBeNull();
    });

    it('binds evidence to the correct build hash', () => {
      const results = makeCompletePassingResults();
      const archive = assembleEvidenceAt(makeInput(results), TEST_ASSEMBLED_AT);

      expect(archive.evidence.buildHash).toBe(TEST_BUILD_HASH);
      expect(archive.evidence.artifactHashes).toEqual(TEST_ARTIFACT_HASHES);
    });

    it('includes the full environment matrix in evidence', () => {
      const results = makeCompletePassingResults();
      const archive = assembleEvidenceAt(makeInput(results), TEST_ASSEMBLED_AT);
      const expectedMatrix = generateEnvironmentMatrix();

      expect(archive.evidence.matrix).toHaveLength(expectedMatrix.length);
    });

    it('produces a non-empty evidence signature', () => {
      const results = makeCompletePassingResults();
      const archive = assembleEvidenceAt(makeInput(results), TEST_ASSEMBLED_AT);

      expect(archive.evidenceSignature).toHaveLength(64); // SHA-256 hex
    });

    it('produces deterministic signatures for identical evidence', () => {
      const results = makeCompletePassingResults();
      const archive1 = assembleEvidenceAt(makeInput(results), TEST_ASSEMBLED_AT);
      const archive2 = assembleEvidenceAt(makeInput(results), TEST_ASSEMBLED_AT);

      expect(archive1.evidenceSignature).toBe(archive2.evidenceSignature);
    });

    it('produces different signatures for different build hashes', () => {
      const results1 = makeCompletePassingResults();
      const results2 = makeCompletePassingResults().map((r) => ({
        ...r,
        buildHash: 'f'.repeat(64),
      }));

      const archive1 = assembleEvidenceAt(makeInput(results1), TEST_ASSEMBLED_AT);
      const archive2 = assembleEvidenceAt(
        { ...makeInput(results2), buildHash: 'f'.repeat(64) },
        TEST_ASSEMBLED_AT,
      );

      expect(archive1.evidenceSignature).not.toBe(archive2.evidenceSignature);
    });
  });

  describe('validateGateMatrixCompleteness', () => {
    it('reports complete when all gates × rows are present', () => {
      const results = makeCompletePassingResults();
      const completeness = validateGateMatrixCompleteness(results);

      expect(completeness.complete).toBe(true);
      expect(completeness.missingCombinations).toHaveLength(0);
      expect(completeness.presentCount).toBe(completeness.expectedCount);
    });

    it('reports incomplete with correct gap count for empty results', () => {
      const completeness = validateGateMatrixCompleteness([]);
      const matrix = generateEnvironmentMatrix();

      expect(completeness.complete).toBe(false);
      expect(completeness.expectedCount).toBe(ALL_GATE_IDS.length * matrix.length);
      expect(completeness.presentCount).toBe(0);
      expect(completeness.missingCombinations).toHaveLength(completeness.expectedCount);
    });

    it('reports incomplete when one gate is missing from one row', () => {
      const results = makeCompletePassingResults();
      results.pop(); // Remove the last result

      const completeness = validateGateMatrixCompleteness(results);

      expect(completeness.complete).toBe(false);
      expect(completeness.missingCombinations).toHaveLength(1);
    });

    it('identifies the exact missing gate and row', () => {
      const matrix = generateEnvironmentMatrix();
      const results = makeCompletePassingResults();

      // Remove a specific known result
      const targetGate = GateId.STABILITY;
      const targetRow = matrix[matrix.length - 1];
      const idx = results.findIndex(
        (r) =>
          r.gateId === targetGate &&
          r.osBuild === targetRow.osBuild &&
          r.architecture === targetRow.architecture &&
          r.webView2Version === targetRow.webView2Version,
      );
      results.splice(idx, 1);

      const completeness = validateGateMatrixCompleteness(results);

      expect(completeness.missingCombinations).toHaveLength(1);
      expect(completeness.missingCombinations[0].gateId).toBe(targetGate);
      expect(completeness.missingCombinations[0].row).toEqual(targetRow);
    });
  });

  describe('computeEvidenceSignature', () => {
    it('produces a 64-char hex string (SHA-256)', () => {
      const results = makeCompletePassingResults();
      const archive = assembleEvidenceAt(makeInput(results), TEST_ASSEMBLED_AT);

      const signature = computeEvidenceSignature(archive.evidence);
      expect(signature).toMatch(/^[a-f0-9]{64}$/);
    });

    it('is deterministic for the same evidence', () => {
      const results = makeCompletePassingResults();
      const archive = assembleEvidenceAt(makeInput(results), TEST_ASSEMBLED_AT);

      const sig1 = computeEvidenceSignature(archive.evidence);
      const sig2 = computeEvidenceSignature(archive.evidence);
      expect(sig1).toBe(sig2);
    });
  });
});
