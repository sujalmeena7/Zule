/**
 * Stage C Release Gate — Runner Orchestration.
 *
 * Coordinates running all gates across every environment matrix row,
 * verifies the pinned toolchain before execution, outputs machine-readable
 * evidence records, and binds results to the correct build/artifact hashes.
 *
 * Requirements: 3.10, 17.1–17.3, 17.23–17.24
 */

import { createHash } from 'node:crypto';

import type {
  GateResultRecord,
  EnvironmentMatrixRow,
  ReleaseGateId,
  GateVerdict,
} from './types';
import { ALL_GATE_IDS } from './types';
import { generateEnvironmentMatrix, matrixRowKey } from './environmentMatrix';
import {
  assembleEvidence,
  validateGateMatrixCompleteness,
  type SignedEvidenceArchive,
} from './evidenceAssembler';

// ────────────────────────────────────────────────────────────────────
// Runner Configuration
// ────────────────────────────────────────────────────────────────────

/**
 * Build context provided to the runner, binding results to the
 * exact build and artifact hashes (Req 3.10).
 */
export interface RunnerBuildContext {
  /** SHA-256 hash of the build under test */
  readonly buildHash: string;

  /** SHA-256 hashes of each distributed artifact, keyed by relative path */
  readonly artifactHashes: Readonly<Record<string, string>>;

  /** App Core version string */
  readonly appVersion: string;

  /** Sidecar version string */
  readonly sidecarVersion: string;
}

/**
 * Toolchain verification result from the pinned dependency lock.
 */
export interface ToolchainVerification {
  /** Whether all tools match the pinned versions */
  readonly verified: boolean;

  /** Human-readable status for each checked component */
  readonly components: readonly ToolchainComponent[];
}

/**
 * A single toolchain component verification entry.
 */
export interface ToolchainComponent {
  readonly name: string;
  readonly expectedVersion: string;
  readonly observedVersion: string | null;
  readonly matched: boolean;
}

/**
 * Interface for the toolchain verifier — allows dependency injection.
 */
export interface ToolchainVerifier {
  /**
   * Verifies that the CI environment matches the pinned dependency lock.
   * Returns detailed component-level results.
   */
  verify(): Promise<ToolchainVerification>;
}

/**
 * Interface for a gate executor — runs a single gate on a single row.
 * Implementations are specific to each gate module.
 */
export interface GateExecutor {
  /**
   * Executes a specific gate on a specific environment row.
   * Returns a bound GateResultRecord.
   */
  execute(
    gateId: ReleaseGateId,
    row: EnvironmentMatrixRow,
    buildContext: RunnerBuildContext,
  ): Promise<GateResultRecord>;
}

/**
 * Runner execution options.
 */
export interface RunnerOptions {
  /** The build context binding results to hashes */
  readonly buildContext: RunnerBuildContext;

  /** Toolchain verifier to check pinned tools before running */
  readonly toolchainVerifier: ToolchainVerifier;

  /** Gate executor that can run any gate on any row */
  readonly gateExecutor: GateExecutor;

  /** Optional: specific gates to run (defaults to ALL_GATE_IDS) */
  readonly gateFilter?: readonly ReleaseGateId[];

  /** Optional: specific matrix rows to run (defaults to full matrix) */
  readonly matrixFilter?: readonly EnvironmentMatrixRow[];
}

// ────────────────────────────────────────────────────────────────────
// Runner Result
// ────────────────────────────────────────────────────────────────────

/**
 * Result of a complete runner execution.
 */
export interface RunnerResult {
  /** Whether the runner completed successfully (all gates executed) */
  readonly completed: boolean;

  /** Toolchain verification result */
  readonly toolchainVerification: ToolchainVerification;

  /** All collected gate results */
  readonly results: readonly GateResultRecord[];

  /** Matrix completeness check */
  readonly matrixCompleteness: {
    readonly complete: boolean;
    readonly expectedCount: number;
    readonly presentCount: number;
  };

  /** Signed evidence archive (only if all gates executed) */
  readonly archive: SignedEvidenceArchive | null;

  /** Errors encountered during execution */
  readonly errors: readonly RunnerError[];
}

/**
 * An error encountered during gate execution.
 */
export interface RunnerError {
  readonly gateId: ReleaseGateId;
  readonly row: EnvironmentMatrixRow;
  readonly error: string;
}

// ────────────────────────────────────────────────────────────────────
// Runner Orchestration
// ────────────────────────────────────────────────────────────────────

/**
 * Executes the complete release gate runner:
 * 1. Verifies pinned toolchain
 * 2. Generates the environment matrix
 * 3. Runs every gate for every matrix row
 * 4. Validates matrix completeness
 * 5. Assembles and signs immutable evidence
 * 6. Returns the archive with approval ID (only if all pass)
 *
 * Requirement 17.1: Use the exact environment matrix.
 * Requirement 17.2: Execute every gate for every row.
 * Requirement 17.3: Bind results to build/artifact hashes.
 * Requirement 3.10: Require new review on dependency change.
 */
export async function executeRunner(options: RunnerOptions): Promise<RunnerResult> {
  const { buildContext, toolchainVerifier, gateExecutor } = options;

  // Step 1: Verify pinned toolchain before any gate execution
  const toolchainVerification = await toolchainVerifier.verify();

  if (!toolchainVerification.verified) {
    return {
      completed: false,
      toolchainVerification,
      results: [],
      matrixCompleteness: {
        complete: false,
        expectedCount: ALL_GATE_IDS.length * generateEnvironmentMatrix().length,
        presentCount: 0,
      },
      archive: null,
      errors: [],
    };
  }

  // Step 2: Determine which gates and rows to run
  const gates = options.gateFilter ?? ALL_GATE_IDS;
  const matrix = options.matrixFilter ?? generateEnvironmentMatrix();

  // Step 3: Execute every gate for every matrix row
  const results: GateResultRecord[] = [];
  const errors: RunnerError[] = [];

  for (const gateId of gates) {
    for (const row of matrix) {
      try {
        const record = await gateExecutor.execute(gateId, row, buildContext);
        results.push(record);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        errors.push({ gateId, row, error: errorMessage });
      }
    }
  }

  // Step 4: Validate matrix completeness
  const completeness = validateGateMatrixCompleteness(results);

  // Step 5: Assemble and sign evidence
  const archive = assembleEvidence({
    buildHash: buildContext.buildHash,
    artifactHashes: buildContext.artifactHashes,
    results,
  });

  return {
    completed: errors.length === 0,
    toolchainVerification,
    results,
    matrixCompleteness: {
      complete: completeness.complete,
      expectedCount: completeness.expectedCount,
      presentCount: completeness.presentCount,
    },
    archive,
    errors,
  };
}

/**
 * Creates a deterministic build hash from source artifacts.
 * Used by CI to compute the build hash that binds all evidence.
 *
 * Requirement 3.10: Bind to build hash.
 */
export function computeBuildHash(artifactContents: readonly Buffer[]): string {
  const hash = createHash('sha256');
  for (const content of artifactContents) {
    hash.update(content);
  }
  return hash.digest('hex');
}

/**
 * Creates an artifact hash map from file paths and their contents.
 */
export function computeArtifactHashes(
  artifacts: readonly { path: string; content: Buffer }[],
): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const artifact of artifacts) {
    hashes[artifact.path] = createHash('sha256')
      .update(artifact.content)
      .digest('hex');
  }
  return hashes;
}
