/**
 * Stage C Release Gate — Packaging Gate
 *
 * Verifies complete package-set presence, architecture equality, hashes,
 * App_Publisher signatures, Stage_C_Manifest bindings, exact versions,
 * protocol, bridge schema, Dependency_Lock, atomic updater behavior,
 * rollback behavior, evidence binding, and Layer_0 availability for every
 * production artifact set.
 *
 * Requirement 17.19
 */

import type { EnvironmentMatrixRow, GateResultRecord } from '../types';
import { ReleaseGateId } from '../types';
import type { StageCManifest, SupportedArchitecture } from '../../types';

// ────────────────────────────────────────────────────────────────────
// Packaging Gate Types
// ────────────────────────────────────────────────────────────────────

/**
 * Signature verification status for a signed artifact.
 */
export type SignatureStatus =
  | 'valid'
  | 'invalid'
  | 'unknown'
  | 'offline'
  | 'warning'
  | 'indeterminate'
  | 'missing';

/**
 * Result of verifying a single artifact's signature.
 */
export interface SignatureVerificationResult {
  readonly artifactPath: string;
  readonly status: SignatureStatus;
  readonly publisher: string | null;
}

/**
 * Represents a production artifact in the package set.
 */
export interface PackageArtifact {
  /** Relative path within the package */
  readonly relativePath: string;
  /** SHA-256 hash of the artifact */
  readonly hash: string;
  /** Architecture the artifact targets */
  readonly architecture: SupportedArchitecture;
  /** Whether the artifact is present on disk */
  readonly present: boolean;
}

/**
 * Updater transaction result for atomic staging/activation/rollback.
 */
export interface UpdaterTransactionResult {
  /** Whether atomic staging succeeded */
  readonly atomicStagingSucceeded: boolean;
  /** Whether activation only occurs while App Core/sidecar are stopped */
  readonly activationWhileStopped: boolean;
  /** Whether rollback to prior verified set works on failure */
  readonly rollbackSucceeded: boolean;
  /** Whether rollback is sidecar-independent */
  readonly rollbackSidecarIndependent: boolean;
}

/**
 * Injectable dependencies for the packaging gate.
 * Allows unit testing without real filesystem/signing infrastructure.
 */
export interface PackagingGateDeps {
  /** Returns the parsed Stage_C_Manifest */
  getManifest(): StageCManifest;

  /** Returns all artifacts found in the production package set */
  getPackageArtifacts(): readonly PackageArtifact[];

  /** Verifies signature for a given artifact path */
  verifySignature(artifactPath: string): SignatureVerificationResult;

  /** Returns the App_Publisher identity expected for signing */
  getExpectedPublisher(): string;

  /** Returns whether the dependency lock file is present and hash-matches manifest */
  verifyDependencyLock(expectedHash: string): boolean;

  /** Tests atomic updater behavior (stage, activate, rollback) */
  testUpdaterTransaction(): UpdaterTransactionResult;

  /** Returns whether the release-gate evidence ID in the manifest is bound to the build */
  verifyEvidenceBinding(evidenceId: string | null): boolean;

  /** Returns whether Layer_0 assets are present and available */
  verifyLayer0Availability(): boolean;
}

// ────────────────────────────────────────────────────────────────────
// Packaging Gate Checks
// ────────────────────────────────────────────────────────────────────

/** All required artifact relative paths in a complete package set. */
const REQUIRED_ARTIFACT_PATHS: readonly string[] = [
  'ZuleUI.exe',
  'manifest.json',
  'dependency-lock.json',
] as const;

/**
 * Executes the packaging gate for a given environment matrix row.
 *
 * Verifies (per Req 17.19):
 * - Complete package-set presence
 * - Architecture equality
 * - Hashes
 * - App_Publisher signatures
 * - Stage_C_Manifest bindings
 * - Exact versions
 * - Protocol
 * - Bridge schema
 * - Dependency_Lock
 * - Atomic updater behavior
 * - Rollback behavior
 * - Evidence binding
 * - Layer_0 availability
 *
 * @param row The environment matrix row under test
 * @param deps Injectable dependencies
 * @param buildHash The SHA-256 build hash for evidence binding
 * @param appVersion The App Core version under test
 * @param sidecarVersion The sidecar version under test
 * @returns A complete GateResultRecord
 */
export function executePackagingGate(
  row: EnvironmentMatrixRow,
  deps: PackagingGateDeps,
  buildHash: string,
  appVersion: string,
  sidecarVersion: string,
): GateResultRecord {
  const failures: string[] = [];

  // 1. Retrieve and verify manifest
  let manifest: StageCManifest;
  try {
    manifest = deps.getManifest();
  } catch {
    failures.push('Stage_C_Manifest: missing or unreadable');
    return buildResult(row, buildHash, appVersion, sidecarVersion, 'fail', failures);
  }

  // 2. Complete package-set presence
  const artifacts = deps.getPackageArtifacts();
  for (const requiredPath of REQUIRED_ARTIFACT_PATHS) {
    const found = artifacts.find((a) => a.relativePath === requiredPath);
    if (!found || !found.present) {
      failures.push(`Package-set missing required artifact: ${requiredPath}`);
    }
  }

  // Check all manifest-declared artifacts are present
  for (const [declaredPath] of Object.entries(manifest.artifact_hashes)) {
    const found = artifacts.find((a) => a.relativePath === declaredPath);
    if (!found || !found.present) {
      failures.push(`Package-set missing manifest-declared artifact: ${declaredPath}`);
    }
  }

  // 3. Architecture equality
  for (const artifact of artifacts) {
    if (artifact.present && artifact.architecture !== row.architecture) {
      failures.push(
        `Architecture mismatch for '${artifact.relativePath}': expected '${row.architecture}', got '${artifact.architecture}'`,
      );
    }
  }

  if (!manifest.supported_architectures.includes(row.architecture)) {
    failures.push(
      `Manifest does not declare architecture '${row.architecture}' in supported_architectures`,
    );
  }

  // 4. Hash verification
  for (const artifact of artifacts) {
    if (!artifact.present) continue;
    const expectedHash = manifest.artifact_hashes[artifact.relativePath];
    if (expectedHash === undefined) {
      failures.push(`Artifact '${artifact.relativePath}' has no declared hash in manifest`);
    } else if (expectedHash !== artifact.hash) {
      failures.push(
        `Hash mismatch for '${artifact.relativePath}': manifest='${expectedHash.slice(0, 16)}...', actual='${artifact.hash.slice(0, 16)}...'`,
      );
    }
  }

  // 5. App_Publisher signatures
  const expectedPublisher = deps.getExpectedPublisher();
  for (const artifact of artifacts) {
    if (!artifact.present) continue;
    const sigResult = deps.verifySignature(artifact.relativePath);
    if (sigResult.status !== 'valid') {
      failures.push(
        `Signature for '${artifact.relativePath}' is '${sigResult.status}' (must be 'valid')`,
      );
    } else if (sigResult.publisher !== expectedPublisher) {
      failures.push(
        `Signature publisher for '${artifact.relativePath}': expected '${expectedPublisher}', got '${sigResult.publisher}'`,
      );
    }
  }

  // 6. Exact versions in manifest
  if (manifest.app_version !== appVersion) {
    failures.push(
      `Manifest app_version '${manifest.app_version}' does not match expected '${appVersion}'`,
    );
  }
  if (manifest.sidecar_version !== sidecarVersion) {
    failures.push(
      `Manifest sidecar_version '${manifest.sidecar_version}' does not match expected '${sidecarVersion}'`,
    );
  }

  // 7. Protocol binding
  if (typeof manifest.protocol_major !== 'number' || manifest.protocol_major < 1) {
    failures.push('Manifest protocol_major is missing or invalid');
  }
  if (typeof manifest.protocol_minor !== 'number' || manifest.protocol_minor < 0) {
    failures.push('Manifest protocol_minor is missing or invalid');
  }

  // 8. Bridge schema binding
  if (typeof manifest.bridge_schema_version !== 'number' || manifest.bridge_schema_version < 1) {
    failures.push('Manifest bridge_schema_version is missing or invalid');
  }

  // 9. Dependency_Lock verification
  if (!deps.verifyDependencyLock(manifest.dependency_lock_hash)) {
    failures.push('Dependency_Lock integrity check failed or file missing');
  }

  // 10 & 11. Atomic updater behavior and rollback
  const updaterResult = deps.testUpdaterTransaction();
  if (!updaterResult.atomicStagingSucceeded) {
    failures.push('Atomic updater staging failed');
  }
  if (!updaterResult.activationWhileStopped) {
    failures.push('Updater activation did not wait for App Core/sidecar stop');
  }
  if (!updaterResult.rollbackSucceeded) {
    failures.push('Updater rollback to prior verified set failed');
  }
  if (!updaterResult.rollbackSidecarIndependent) {
    failures.push('Updater rollback depends on older sidecar (must be independent)');
  }

  // 12. Evidence binding
  if (!deps.verifyEvidenceBinding(manifest.release_gate_evidence_id)) {
    failures.push('Release-gate evidence binding invalid or missing');
  }

  // 13. Layer_0 availability
  if (!deps.verifyLayer0Availability()) {
    failures.push('Layer_0 assets are not available in the package set');
  }

  const verdict = failures.length === 0 ? 'pass' : 'fail';
  return buildResult(row, buildHash, appVersion, sidecarVersion, verdict, failures);
}

// ────────────────────────────────────────────────────────────────────
// Helper
// ────────────────────────────────────────────────────────────────────

function buildResult(
  row: EnvironmentMatrixRow,
  buildHash: string,
  appVersion: string,
  sidecarVersion: string,
  verdict: 'pass' | 'fail',
  failures: readonly string[],
): GateResultRecord {
  return {
    gateId: ReleaseGateId.PACKAGING,
    buildHash,
    osBuild: row.osBuild,
    architecture: row.architecture,
    webView2Version: row.webView2Version,
    appVersion,
    sidecarVersion,
    rawMeasurementSummary: JSON.stringify({
      checks: REQUIRED_ARTIFACT_PATHS.length + 10, // approximate check count
      failures,
    }),
    verdict,
    executedAt: new Date().toISOString(),
  };
}
