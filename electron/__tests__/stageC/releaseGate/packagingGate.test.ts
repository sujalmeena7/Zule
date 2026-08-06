/**
 * Stage C Release Gate — Packaging Gate Unit Tests
 *
 * Verifies the packaging gate logic for complete package-set presence,
 * architecture equality, hashes, signatures, manifest bindings, versions,
 * protocol, bridge schema, Dependency_Lock, updater, rollback, evidence,
 * and Layer_0 availability.
 *
 * Requirement 17.19
 */

import { describe, it, expect } from 'vitest';

import {
  executePackagingGate,
  type PackagingGateDeps,
  type PackageArtifact,
  type SignatureVerificationResult,
  type UpdaterTransactionResult,
} from '../../../stageC/releaseGate/gates/packagingGate';
import type { EnvironmentMatrixRow } from '../../../stageC/releaseGate/types';
import type { StageCManifest } from '../../../stageC/types';

// ────────────────────────────────────────────────────────────────────
// Test Fixtures
// ────────────────────────────────────────────────────────────────────

const TEST_ROW: EnvironmentMatrixRow = {
  osBuild: 'win10_22h2',
  architecture: 'x64',
  webView2Version: '119.0.2151.0',
};

const TEST_BUILD_HASH = 'a'.repeat(64);
const TEST_APP_VERSION = '1.0.0';
const TEST_SIDECAR_VERSION = '1.0.0';
const TEST_PUBLISHER = 'Zule AI';

function validManifest(): StageCManifest {
  return {
    app_version: TEST_APP_VERSION,
    sidecar_version: TEST_SIDECAR_VERSION,
    protocol_major: 1,
    protocol_minor: 0,
    bridge_schema_version: 1,
    supported_architectures: ['x64'],
    minimum_webview2_version: '119.0.2151.0',
    capabilities: ['overlay'],
    dependency_lock_hash: 'b'.repeat(64),
    sidecar_path: 'ZuleUI.exe',
    release_gate_evidence_id: 'evidence-123',
    artifact_hashes: {
      'ZuleUI.exe': 'c'.repeat(64),
      'manifest.json': 'd'.repeat(64),
      'dependency-lock.json': 'e'.repeat(64),
    },
    publisher: TEST_PUBLISHER,
  };
}

function validArtifacts(): PackageArtifact[] {
  return [
    { relativePath: 'ZuleUI.exe', hash: 'c'.repeat(64), architecture: 'x64', present: true },
    { relativePath: 'manifest.json', hash: 'd'.repeat(64), architecture: 'x64', present: true },
    { relativePath: 'dependency-lock.json', hash: 'e'.repeat(64), architecture: 'x64', present: true },
  ];
}

function validSignature(artifactPath: string): SignatureVerificationResult {
  return { artifactPath, status: 'valid', publisher: TEST_PUBLISHER };
}

function validUpdater(): UpdaterTransactionResult {
  return {
    atomicStagingSucceeded: true,
    activationWhileStopped: true,
    rollbackSucceeded: true,
    rollbackSidecarIndependent: true,
  };
}

function createPassingDeps(overrides?: Partial<PackagingGateDeps>): PackagingGateDeps {
  return {
    getManifest: () => validManifest(),
    getPackageArtifacts: () => validArtifacts(),
    verifySignature: (path) => validSignature(path),
    getExpectedPublisher: () => TEST_PUBLISHER,
    verifyDependencyLock: () => true,
    testUpdaterTransaction: () => validUpdater(),
    verifyEvidenceBinding: () => true,
    verifyLayer0Availability: () => true,
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

describe('Packaging Gate (Req 17.19)', () => {
  it('passes when all checks succeed', () => {
    const result = executePackagingGate(
      TEST_ROW,
      createPassingDeps(),
      TEST_BUILD_HASH,
      TEST_APP_VERSION,
      TEST_SIDECAR_VERSION,
    );

    expect(result.verdict).toBe('pass');
    expect(result.gateId).toBe('packaging');
    expect(result.buildHash).toBe(TEST_BUILD_HASH);
    expect(result.osBuild).toBe('win10_22h2');
    expect(result.architecture).toBe('x64');
  });

  it('fails when manifest is unreadable', () => {
    const deps = createPassingDeps({
      getManifest: () => { throw new Error('file not found'); },
    });

    const result = executePackagingGate(
      TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION,
    );

    expect(result.verdict).toBe('fail');
    const summary = JSON.parse(result.rawMeasurementSummary);
    expect(summary.failures).toContain('Stage_C_Manifest: missing or unreadable');
  });

  it('fails when required artifact is missing', () => {
    const artifacts = validArtifacts().filter((a) => a.relativePath !== 'ZuleUI.exe');
    const deps = createPassingDeps({ getPackageArtifacts: () => artifacts });

    const result = executePackagingGate(
      TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION,
    );

    expect(result.verdict).toBe('fail');
    const summary = JSON.parse(result.rawMeasurementSummary);
    expect(summary.failures.some((f: string) => f.includes('ZuleUI.exe'))).toBe(true);
  });

  it('fails when artifact architecture does not match row', () => {
    const artifacts = validArtifacts().map((a) =>
      a.relativePath === 'ZuleUI.exe'
        ? { ...a, architecture: 'arm64' as const }
        : a,
    );
    const deps = createPassingDeps({ getPackageArtifacts: () => artifacts });

    const result = executePackagingGate(
      TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION,
    );

    expect(result.verdict).toBe('fail');
    const summary = JSON.parse(result.rawMeasurementSummary);
    expect(summary.failures.some((f: string) => f.includes('Architecture mismatch'))).toBe(true);
  });

  it('fails when artifact hash does not match manifest', () => {
    const artifacts = validArtifacts().map((a) =>
      a.relativePath === 'ZuleUI.exe'
        ? { ...a, hash: 'f'.repeat(64) }
        : a,
    );
    const deps = createPassingDeps({ getPackageArtifacts: () => artifacts });

    const result = executePackagingGate(
      TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION,
    );

    expect(result.verdict).toBe('fail');
    const summary = JSON.parse(result.rawMeasurementSummary);
    expect(summary.failures.some((f: string) => f.includes('Hash mismatch'))).toBe(true);
  });

  it('fails when artifact signature is invalid', () => {
    const deps = createPassingDeps({
      verifySignature: (path) => ({ artifactPath: path, status: 'invalid', publisher: null }),
    });

    const result = executePackagingGate(
      TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION,
    );

    expect(result.verdict).toBe('fail');
    const summary = JSON.parse(result.rawMeasurementSummary);
    expect(summary.failures.some((f: string) => f.includes("'invalid'"))).toBe(true);
  });

  it('fails when signature publisher does not match expected', () => {
    const deps = createPassingDeps({
      verifySignature: (path) => ({ artifactPath: path, status: 'valid', publisher: 'Unknown Corp' }),
    });

    const result = executePackagingGate(
      TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION,
    );

    expect(result.verdict).toBe('fail');
    const summary = JSON.parse(result.rawMeasurementSummary);
    expect(summary.failures.some((f: string) => f.includes('publisher'))).toBe(true);
  });

  it('fails when manifest app_version does not match', () => {
    const manifest = validManifest();
    manifest.app_version = '2.0.0';
    const deps = createPassingDeps({ getManifest: () => manifest });

    const result = executePackagingGate(
      TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION,
    );

    expect(result.verdict).toBe('fail');
    const summary = JSON.parse(result.rawMeasurementSummary);
    expect(summary.failures.some((f: string) => f.includes('app_version'))).toBe(true);
  });

  it('fails when manifest sidecar_version does not match', () => {
    const manifest = validManifest();
    manifest.sidecar_version = '2.0.0';
    const deps = createPassingDeps({ getManifest: () => manifest });

    const result = executePackagingGate(
      TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION,
    );

    expect(result.verdict).toBe('fail');
    const summary = JSON.parse(result.rawMeasurementSummary);
    expect(summary.failures.some((f: string) => f.includes('sidecar_version'))).toBe(true);
  });

  it('fails when dependency lock verification fails', () => {
    const deps = createPassingDeps({ verifyDependencyLock: () => false });

    const result = executePackagingGate(
      TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION,
    );

    expect(result.verdict).toBe('fail');
    const summary = JSON.parse(result.rawMeasurementSummary);
    expect(summary.failures.some((f: string) => f.includes('Dependency_Lock'))).toBe(true);
  });

  it('fails when atomic updater staging fails', () => {
    const deps = createPassingDeps({
      testUpdaterTransaction: () => ({
        ...validUpdater(),
        atomicStagingSucceeded: false,
      }),
    });

    const result = executePackagingGate(
      TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION,
    );

    expect(result.verdict).toBe('fail');
    const summary = JSON.parse(result.rawMeasurementSummary);
    expect(summary.failures.some((f: string) => f.includes('staging failed'))).toBe(true);
  });

  it('fails when rollback is not sidecar-independent', () => {
    const deps = createPassingDeps({
      testUpdaterTransaction: () => ({
        ...validUpdater(),
        rollbackSidecarIndependent: false,
      }),
    });

    const result = executePackagingGate(
      TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION,
    );

    expect(result.verdict).toBe('fail');
    const summary = JSON.parse(result.rawMeasurementSummary);
    expect(summary.failures.some((f: string) => f.includes('sidecar'))).toBe(true);
  });

  it('fails when evidence binding is invalid', () => {
    const deps = createPassingDeps({ verifyEvidenceBinding: () => false });

    const result = executePackagingGate(
      TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION,
    );

    expect(result.verdict).toBe('fail');
    const summary = JSON.parse(result.rawMeasurementSummary);
    expect(summary.failures.some((f: string) => f.includes('evidence binding'))).toBe(true);
  });

  it('fails when Layer_0 is not available', () => {
    const deps = createPassingDeps({ verifyLayer0Availability: () => false });

    const result = executePackagingGate(
      TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION,
    );

    expect(result.verdict).toBe('fail');
    const summary = JSON.parse(result.rawMeasurementSummary);
    expect(summary.failures.some((f: string) => f.includes('Layer_0'))).toBe(true);
  });

  it('records executedAt timestamp in ISO-8601', () => {
    const result = executePackagingGate(
      TEST_ROW,
      createPassingDeps(),
      TEST_BUILD_HASH,
      TEST_APP_VERSION,
      TEST_SIDECAR_VERSION,
    );

    expect(result.executedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
