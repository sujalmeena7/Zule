/**
 * Stage C Release Gate — Immutable Evidence Assembly.
 *
 * Collects all GateResultRecord outputs from gate executions, validates
 * matrix completeness, signs and archives evidence by build hash, and
 * emits an approval identifier ONLY when every result passes.
 *
 * Requirements: 3.10, 17.1–17.3, 17.23–17.24
 */

import { createHash } from 'node:crypto';

import type {
  GateResultRecord,
  ReleaseEvidenceSet,
  ReleaseDecision,
  EnvironmentMatrixRow,
  ReleaseGateId,
} from './types';
import { ALL_GATE_IDS } from './types';
import {
  generateEnvironmentMatrix,
  matrixRowKey,
  validateMatrixCompleteness,
} from './environmentMatrix';
import { evaluateReleaseDecision } from './decision';

// ────────────────────────────────────────────────────────────────────
// Evidence Assembly Types
// ────────────────────────────────────────────────────────────────────

/**
 * Input for evidence assembly: the build context and collected results.
 */
export interface EvidenceAssemblyInput {
  /** SHA-256 hash of the build under test (Req 3.10) */
  readonly buildHash: string;

  /** SHA-256 hashes of each distributed artifact, keyed by relative path */
  readonly artifactHashes: Readonly<Record<string, string>>;

  /** All collected gate result records from runner execution */
  readonly results: readonly GateResultRecord[];
}

/**
 * Signed evidence archive record, bound to the build hash.
 */
export interface SignedEvidenceArchive {
  /** The assembled evidence set */
  readonly evidence: ReleaseEvidenceSet;

  /** SHA-256 signature of the serialized evidence (deterministic) */
  readonly evidenceSignature: string;

  /** The release decision produced from the evidence */
  readonly decision: ReleaseDecision;

  /** ISO-8601 timestamp of archive creation */
  readonly archivedAt: string;
}

/**
 * Matrix completeness validation result.
 */
export interface MatrixCompletenessResult {
  /** Whether the matrix is complete */
  readonly complete: boolean;

  /** Missing gate × row combinations */
  readonly missingCombinations: readonly MatrixGap[];

  /** Total expected combinations (gates × rows) */
  readonly expectedCount: number;

  /** Total present combinations */
  readonly presentCount: number;
}

/**
 * A missing gate × environment-row combination.
 */
export interface MatrixGap {
  readonly gateId: ReleaseGateId;
  readonly row: EnvironmentMatrixRow;
}

// ────────────────────────────────────────────────────────────────────
// Matrix Completeness Validation
// ────────────────────────────────────────────────────────────────────

/**
 * Validates that every gate has been executed for every matrix row.
 * Returns detailed information about any gaps.
 *
 * Requirement 17.2: Execute every applicable gate for every row.
 * Requirement 17.23: Missing row or gate result → failed.
 */
export function validateGateMatrixCompleteness(
  results: readonly GateResultRecord[],
): MatrixCompletenessResult {
  const expectedMatrix = generateEnvironmentMatrix();
  const expectedCount = ALL_GATE_IDS.length * expectedMatrix.length;

  // Build lookup set of present combinations
  const presentKeys = new Set<string>();
  for (const result of results) {
    const rowKey = `${result.osBuild}|${result.architecture}|${result.webView2Version}`;
    const compositeKey = `${result.gateId}|${rowKey}`;
    presentKeys.add(compositeKey);
  }

  // Find missing combinations
  const missingCombinations: MatrixGap[] = [];
  for (const gateId of ALL_GATE_IDS) {
    for (const row of expectedMatrix) {
      const rowKey = matrixRowKey(row);
      const compositeKey = `${gateId}|${rowKey}`;
      if (!presentKeys.has(compositeKey)) {
        missingCombinations.push({ gateId, row });
      }
    }
  }

  return {
    complete: missingCombinations.length === 0,
    missingCombinations,
    expectedCount,
    presentCount: presentKeys.size,
  };
}

// ────────────────────────────────────────────────────────────────────
// Evidence Signing
// ────────────────────────────────────────────────────────────────────

/**
 * Computes a deterministic SHA-256 signature over the serialized evidence.
 * The signature is bound to the build hash, artifact hashes, and all results.
 *
 * Requirement 3.10: Bind evidence to build/artifact hashes.
 */
export function computeEvidenceSignature(evidence: ReleaseEvidenceSet): string {
  // Recursively canonicalize all object keys; a top-level replacer would omit
  // nested gate measurements and would not bind the complete evidence record.
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, canonicalize(nested)]),
      );
    }
    return value;
  };

  return createHash('sha256')
    .update(JSON.stringify(canonicalize(evidence)))
    .digest('hex');
}

// ────────────────────────────────────────────────────────────────────
// Evidence Assembly
// ────────────────────────────────────────────────────────────────────

/**
 * Assembles immutable evidence from collected gate results, validates
 * matrix completeness, signs the evidence by build hash, and evaluates
 * the fail-closed release decision.
 *
 * Emits an approval identifier ONLY when every result passes for every
 * matrix row and distributed artifact.
 *
 * Requirement 17.1: Enumerate exact environment matrix.
 * Requirement 17.2: Execute every gate for every row.
 * Requirement 17.3: Bind results to build/artifact hashes.
 * Requirement 17.23: Missing evidence → failed.
 * Requirement 17.24: Approve only when all pass.
 * Requirement 3.10: Bind to build hash on dependency/tool change.
 */
export function assembleEvidence(input: EvidenceAssemblyInput): SignedEvidenceArchive {
  const assembledAt = new Date().toISOString();
  const matrix = generateEnvironmentMatrix();

  // Build the complete evidence set
  const evidence: ReleaseEvidenceSet = {
    buildHash: input.buildHash,
    artifactHashes: input.artifactHashes,
    matrix,
    results: input.results,
    assembledAt,
  };

  // Sign the evidence (deterministic hash over canonical form)
  const evidenceSignature = computeEvidenceSignature(evidence);

  // Evaluate the fail-closed release decision
  const decision = evaluateReleaseDecision(evidence);

  const archivedAt = new Date().toISOString();

  return {
    evidence,
    evidenceSignature,
    decision,
    archivedAt,
  };
}

/**
 * Assembles evidence with a specific timestamp (for deterministic testing).
 */
export function assembleEvidenceAt(
  input: EvidenceAssemblyInput,
  assembledAt: string,
): SignedEvidenceArchive {
  const matrix = generateEnvironmentMatrix();

  const evidence: ReleaseEvidenceSet = {
    buildHash: input.buildHash,
    artifactHashes: input.artifactHashes,
    matrix,
    results: input.results,
    assembledAt,
  };

  const evidenceSignature = computeEvidenceSignature(evidence);
  const decision = evaluateReleaseDecision(evidence);

  return {
    evidence,
    evidenceSignature,
    decision,
    archivedAt: assembledAt,
  };
}
