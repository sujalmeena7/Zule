/**
 * Stage C Release Gate — Release-Decision and No-Waiver Property Tests.
 *
 * Property-based tests using fast-check that verify:
 * - Omitted rows → failed (Req 17.23)
 * - Failed rows → failed (Req 17.23)
 * - Tampered rows → failed (Req 17.23)
 * - Flag/env waiver attempts → failed (Req 17.26)
 * - Persisted setting waivers → failed (Req 17.26)
 * - Remote content waivers → failed (Req 17.26)
 * - Diagnostic retry waivers → failed (Req 17.26)
 * - Combined failures → failed (Req 17.23–17.26)
 *
 * **Validates: Requirements 17.23–17.26**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  evaluateReleaseDecision,
  generateEnvironmentMatrix,
  ALL_GATE_IDS,
  ReleaseGateId,
  type ReleaseEvidenceSet,
  type GateResultRecord,
  type EnvironmentMatrixRow,
} from '../../../stageC/releaseGate';

// ────────────────────────────────────────────────────────────────────
// Helpers & Generators
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

/** Generates a non-empty subset of indices from [0, length) */
function arbSubsetIndices(length: number): fc.Arbitrary<number[]> {
  return fc.uniqueArray(fc.integer({ min: 0, max: length - 1 }), {
    minLength: 1,
    maxLength: Math.min(length, 10),
  });
}

/** All known waiver env vars that the decision function rejects */
const WAIVER_ENV_VARS = [
  'STAGE_C_FORCE_APPROVE',
  'STAGE_C_SKIP_GATES',
  'STAGE_C_WAIVER',
  'STAGE_C_OVERRIDE',
  'ZULE_RELEASE_GATE_BYPASS',
  'ZULE_FORCE_STAGE_C',
] as const;

/** Generates a non-empty string value for waiver env vars */
const arbWaiverValue = fc.oneof(
  fc.constant('true'),
  fc.constant('1'),
  fc.constant('yes'),
  fc.constant('enabled'),
  fc.constant('granted'),
  fc.stringOf(fc.char(), { minLength: 1, maxLength: 20 }),
);

/** Generates a non-empty subset of waiver env var names */
const arbWaiverVarSubset = fc.uniqueArray(
  fc.integer({ min: 0, max: WAIVER_ENV_VARS.length - 1 }),
  { minLength: 1, maxLength: WAIVER_ENV_VARS.length },
).map(indices => indices.map(i => WAIVER_ENV_VARS[i]));

// ────────────────────────────────────────────────────────────────────
// Property Tests: Omitted Rows (Req 17.23)
// ────────────────────────────────────────────────────────────────────

describe('Release Decision — Omitted Rows Property (Req 17.23)', () => {
  it('any subset of omitted matrix rows causes decision to be failed', () => {
    const baseEvidence = buildCompletePassingEvidence();
    const matrix = generateEnvironmentMatrix();
    const totalResults = baseEvidence.results.length;

    fc.assert(
      fc.property(
        arbSubsetIndices(matrix.length),
        (omittedRowIndices) => {
          // Build a set of row keys to omit
          const omittedKeys = new Set(
            omittedRowIndices.map(i => {
              const row = matrix[i];
              return `${row.osBuild}|${row.architecture}|${row.webView2Version}`;
            }),
          );

          // Remove results for the omitted rows
          const filteredResults = baseEvidence.results.filter(r => {
            const key = `${r.osBuild}|${r.architecture}|${r.webView2Version}`;
            return !omittedKeys.has(key);
          });

          // Also remove the rows from the matrix (simulates missing rows)
          const filteredMatrix = matrix.filter((_, i) => !omittedRowIndices.includes(i));

          const evidence: ReleaseEvidenceSet = {
            ...baseEvidence,
            matrix: filteredMatrix,
            results: filteredResults,
          };

          const decision = evaluateReleaseDecision(evidence, { env: {} });

          // Must be failed — missing rows means incomplete evidence
          expect(decision.outcome).toBe('failed');
          expect(decision.approvalId).toBeNull();
        },
      ),
      { numRuns: 50 },
    );
  });

  it('omitting results for a subset of gates on existing rows causes failure', () => {
    const baseEvidence = buildCompletePassingEvidence();
    const matrix = generateEnvironmentMatrix();

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: matrix.length - 1 }),
        fc.uniqueArray(
          fc.integer({ min: 0, max: ALL_GATE_IDS.length - 1 }),
          { minLength: 1, maxLength: ALL_GATE_IDS.length },
        ),
        (rowIndex, gateIndices) => {
          const targetRow = matrix[rowIndex];
          const targetRowKey = `${targetRow.osBuild}|${targetRow.architecture}|${targetRow.webView2Version}`;
          const targetGateIds = new Set(gateIndices.map(i => ALL_GATE_IDS[i]));

          // Remove specific gate results for the chosen row
          const filteredResults = baseEvidence.results.filter(r => {
            const rowKey = `${r.osBuild}|${r.architecture}|${r.webView2Version}`;
            if (rowKey === targetRowKey && targetGateIds.has(r.gateId)) {
              return false;
            }
            return true;
          });

          const evidence: ReleaseEvidenceSet = {
            ...baseEvidence,
            results: filteredResults,
          };

          const decision = evaluateReleaseDecision(evidence, { env: {} });
          expect(decision.outcome).toBe('failed');
          expect(decision.failures.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// Property Tests: Failed Rows (Req 17.23)
// ────────────────────────────────────────────────────────────────────

describe('Release Decision — Failed Rows Property (Req 17.23)', () => {
  it('any result with verdict "fail" causes decision to be failed', () => {
    const baseEvidence = buildCompletePassingEvidence();
    const totalResults = baseEvidence.results.length;

    fc.assert(
      fc.property(
        arbSubsetIndices(totalResults),
        (failedIndices) => {
          const results = [...baseEvidence.results];

          for (const idx of failedIndices) {
            results[idx] = { ...results[idx], verdict: 'fail' };
          }

          const evidence: ReleaseEvidenceSet = {
            ...baseEvidence,
            results,
          };

          const decision = evaluateReleaseDecision(evidence, { env: {} });
          expect(decision.outcome).toBe('failed');
          expect(decision.failures.some(f => f.reason.includes('failed on environment row'))).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// Property Tests: Tampered Rows (Req 17.23)
// ────────────────────────────────────────────────────────────────────

describe('Release Decision — Tampered Rows Property (Req 17.23)', () => {
  it('mismatched build hashes in results cause decision to be failed', () => {
    const baseEvidence = buildCompletePassingEvidence();
    const totalResults = baseEvidence.results.length;

    fc.assert(
      fc.property(
        arbSubsetIndices(totalResults),
        fc.hexaString({ minLength: 64, maxLength: 64 }).filter(h => h !== TEST_BUILD_HASH),
        (tamperedIndices, fakeBuildHash) => {
          const results = [...baseEvidence.results];

          for (const idx of tamperedIndices) {
            results[idx] = { ...results[idx], buildHash: fakeBuildHash };
          }

          const evidence: ReleaseEvidenceSet = {
            ...baseEvidence,
            results,
          };

          const decision = evaluateReleaseDecision(evidence, { env: {} });
          expect(decision.outcome).toBe('failed');
          expect(
            decision.failures.some(f => f.reason.includes('does not match evidence set buildHash')),
          ).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('empty rawMeasurementSummary in any result causes failure', () => {
    const baseEvidence = buildCompletePassingEvidence();
    const totalResults = baseEvidence.results.length;

    fc.assert(
      fc.property(
        arbSubsetIndices(totalResults),
        (tamperedIndices) => {
          const results = [...baseEvidence.results];

          for (const idx of tamperedIndices) {
            results[idx] = { ...results[idx], rawMeasurementSummary: '' };
          }

          const evidence: ReleaseEvidenceSet = {
            ...baseEvidence,
            results,
          };

          const decision = evaluateReleaseDecision(evidence, { env: {} });
          expect(decision.outcome).toBe('failed');
          expect(
            decision.failures.some(f => f.reason.includes('rawMeasurementSummary')),
          ).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('missing or invalid fields in results cause failure', () => {
    const baseEvidence = buildCompletePassingEvidence();
    const totalResults = baseEvidence.results.length;

    // Fields that can be emptied to trigger validation failure
    const tamperableFields = [
      'appVersion',
      'sidecarVersion',
      'executedAt',
      'osBuild',
      'architecture',
      'webView2Version',
    ] as const;

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: totalResults - 1 }),
        fc.integer({ min: 0, max: tamperableFields.length - 1 }),
        (resultIndex, fieldIndex) => {
          const results = [...baseEvidence.results];
          const fieldName = tamperableFields[fieldIndex];

          results[resultIndex] = { ...results[resultIndex], [fieldName]: '' } as unknown as GateResultRecord;

          const evidence: ReleaseEvidenceSet = {
            ...baseEvidence,
            results,
          };

          const decision = evaluateReleaseDecision(evidence, { env: {} });
          expect(decision.outcome).toBe('failed');
          expect(decision.failures.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// Property Tests: Flag Waiver Attempts (Req 17.26)
// ────────────────────────────────────────────────────────────────────

describe('Release Decision — Flag Waiver Attempts (Req 17.26)', () => {
  it('any non-empty waiver env var causes rejection even with perfect evidence', () => {
    const evidence = buildCompletePassingEvidence();

    fc.assert(
      fc.property(
        arbWaiverVarSubset,
        arbWaiverValue,
        (varNames, value) => {
          const env: Record<string, string> = {};
          for (const name of varNames) {
            env[name] = value;
          }

          const decision = evaluateReleaseDecision(evidence, { env });
          expect(decision.outcome).toBe('failed');

          // Verify each waiver var is mentioned in failures
          for (const name of varNames) {
            expect(
              decision.failures.some(f => f.reason.includes(name)),
            ).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('every individual known waiver env var is rejected', () => {
    const evidence = buildCompletePassingEvidence();

    fc.assert(
      fc.property(
        fc.constantFrom(...WAIVER_ENV_VARS),
        arbWaiverValue,
        (varName, value) => {
          const env: Record<string, string> = { [varName]: value };
          const decision = evaluateReleaseDecision(evidence, { env });

          expect(decision.outcome).toBe('failed');
          expect(
            decision.failures.some(f => f.reason.includes(varName)),
          ).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// Property Tests: Persisted Setting Waivers (Req 17.26)
// ────────────────────────────────────────────────────────────────────

describe('Release Decision — Persisted Setting Waivers (Req 17.26)', () => {
  it('no external configuration key can override a failed decision', () => {
    const baseEvidence = buildCompletePassingEvidence();
    const totalResults = baseEvidence.results.length;

    // Simulate "persisted settings" by providing env vars that look like
    // persisted config keys — these should have zero effect on the decision
    const configStyleEnvVars = [
      'ZULE_CONFIG_STAGE_C_ENABLED',
      'ZULE_SETTINGS_FORCE_APPROVE',
      'ZULE_PERSIST_GATE_OVERRIDE',
      'STAGE_C_CONFIG_APPROVE',
      'RELEASE_GATE_PERSIST_BYPASS',
    ];

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: totalResults - 1 }),
        fc.constantFrom(...configStyleEnvVars),
        arbWaiverValue,
        (failIndex, configKey, configValue) => {
          // Create evidence with one failure
          const results = [...baseEvidence.results];
          results[failIndex] = { ...results[failIndex], verdict: 'fail' };

          const evidence: ReleaseEvidenceSet = { ...baseEvidence, results };
          const env: Record<string, string> = { [configKey]: configValue };

          const decision = evaluateReleaseDecision(evidence, { env });

          // Decision stays failed — no persisted setting can override
          expect(decision.outcome).toBe('failed');
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// Property Tests: Remote Content Waivers (Req 17.26)
// ────────────────────────────────────────────────────────────────────

describe('Release Decision — Remote Content Waivers (Req 17.26)', () => {
  it('evidence must be local and complete — partial evidence never approves', () => {
    const matrix = generateEnvironmentMatrix();

    fc.assert(
      fc.property(
        // Generate random subsets of the complete gate×row space
        fc.integer({ min: 1, max: ALL_GATE_IDS.length * matrix.length - 1 }),
        fc.nat(),
        (resultCount, seed) => {
          // Build only a partial set of results (simulates remote-fetched partial evidence)
          const allPossible: GateResultRecord[] = [];
          for (const gateId of ALL_GATE_IDS) {
            for (const row of matrix) {
              allPossible.push(makePassingRecord(gateId, row));
            }
          }

          // Deterministically select a subset that's smaller than full
          const shuffled = [...allPossible];
          // Simple deterministic shuffle using seed
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = (seed + i * 31) % (i + 1);
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
          }
          const partialResults = shuffled.slice(0, resultCount);

          const evidence: ReleaseEvidenceSet = {
            buildHash: TEST_BUILD_HASH,
            artifactHashes: { 'stage-c/ZuleUI.exe': 'b'.repeat(64) },
            matrix,
            results: partialResults,
            assembledAt: TEST_ASSEMBLED_AT,
          };

          const decision = evaluateReleaseDecision(evidence, { env: {} });

          // Partial evidence can never approve
          expect(decision.outcome).toBe('failed');
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// Property Tests: Diagnostic Retry Waivers (Req 17.26)
// ────────────────────────────────────────────────────────────────────

describe('Release Decision — Diagnostic Retry Waivers (Req 17.26)', () => {
  it('repeated evaluation of failed evidence never becomes approved', () => {
    const baseEvidence = buildCompletePassingEvidence();
    const totalResults = baseEvidence.results.length;

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: totalResults - 1 }),
        fc.integer({ min: 2, max: 10 }),
        (failIndex, retryCount) => {
          // Create evidence with one failure
          const results = [...baseEvidence.results];
          results[failIndex] = { ...results[failIndex], verdict: 'fail' };
          const evidence: ReleaseEvidenceSet = { ...baseEvidence, results };

          // Simulate retries — call evaluateReleaseDecision multiple times
          for (let retry = 0; retry < retryCount; retry++) {
            const decision = evaluateReleaseDecision(evidence, { env: {} });
            expect(decision.outcome).toBe('failed');
            expect(decision.approvalId).toBeNull();
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it('retrying with waiver env vars set never produces approval', () => {
    const evidence = buildCompletePassingEvidence();

    fc.assert(
      fc.property(
        fc.constantFrom(...WAIVER_ENV_VARS),
        arbWaiverValue,
        fc.integer({ min: 2, max: 5 }),
        (varName, value, retryCount) => {
          const env: Record<string, string> = { [varName]: value };

          for (let retry = 0; retry < retryCount; retry++) {
            const decision = evaluateReleaseDecision(evidence, { env });
            expect(decision.outcome).toBe('failed');
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// Property Tests: Combined Scenarios (Req 17.23–17.26)
// ────────────────────────────────────────────────────────────────────

describe('Release Decision — Combined Failures (Req 17.23–17.26)', () => {
  it('multiple simultaneous failures still produce failed outcome', () => {
    const baseEvidence = buildCompletePassingEvidence();
    const totalResults = baseEvidence.results.length;

    fc.assert(
      fc.property(
        // Introduce failed verdicts
        arbSubsetIndices(totalResults),
        // Also tamper build hash on some
        arbSubsetIndices(totalResults),
        // Also set waiver env vars
        arbWaiverVarSubset,
        arbWaiverValue,
        (failedIndices, tamperedIndices, waiverVars, waiverValue) => {
          const results = [...baseEvidence.results];

          // Apply failures
          for (const idx of failedIndices) {
            results[idx] = { ...results[idx], verdict: 'fail' };
          }

          // Apply tampered build hashes
          for (const idx of tamperedIndices) {
            if (!failedIndices.includes(idx)) {
              results[idx] = { ...results[idx], buildHash: 'f'.repeat(64) };
            }
          }

          const evidence: ReleaseEvidenceSet = { ...baseEvidence, results };

          // Build waiver env
          const env: Record<string, string> = {};
          for (const name of waiverVars) {
            env[name] = waiverValue;
          }

          const decision = evaluateReleaseDecision(evidence, { env });
          expect(decision.outcome).toBe('failed');
          expect(decision.failures.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('failed evidence + all waiver vars set + retries = always failed', () => {
    const baseEvidence = buildCompletePassingEvidence();
    const totalResults = baseEvidence.results.length;

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: totalResults - 1 }),
        fc.integer({ min: 1, max: 3 }),
        (failIndex, retries) => {
          const results = [...baseEvidence.results];
          results[failIndex] = { ...results[failIndex], verdict: 'fail' };
          const evidence: ReleaseEvidenceSet = { ...baseEvidence, results };

          // Set ALL waiver env vars
          const env: Record<string, string> = {};
          for (const varName of WAIVER_ENV_VARS) {
            env[varName] = 'true';
          }

          // Retry multiple times
          for (let r = 0; r < retries; r++) {
            const decision = evaluateReleaseDecision(evidence, { env });
            expect(decision.outcome).toBe('failed');
            expect(decision.approvalId).toBeNull();
            // Failures should include both evidence failures and waiver rejections
            expect(decision.failures.length).toBeGreaterThan(1);
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it('empty measurement summary + waiver env vars = failed with multiple reasons', () => {
    const baseEvidence = buildCompletePassingEvidence();
    const totalResults = baseEvidence.results.length;

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: totalResults - 1 }),
        fc.constantFrom(...WAIVER_ENV_VARS),
        (resultIndex, waiverVar) => {
          const results = [...baseEvidence.results];
          results[resultIndex] = { ...results[resultIndex], rawMeasurementSummary: '' };
          const evidence: ReleaseEvidenceSet = { ...baseEvidence, results };

          const env: Record<string, string> = { [waiverVar]: 'yes' };
          const decision = evaluateReleaseDecision(evidence, { env });

          expect(decision.outcome).toBe('failed');
          // Must have both types of failure
          expect(decision.failures.some(f => f.reason.includes('rawMeasurementSummary'))).toBe(true);
          expect(decision.failures.some(f => f.reason.includes(waiverVar))).toBe(true);
        },
      ),
      { numRuns: 30 },
    );
  });
});
