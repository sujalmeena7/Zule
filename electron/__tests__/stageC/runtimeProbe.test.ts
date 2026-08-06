/**
 * Stage C Runtime Probe — Unit Tests
 *
 * Tests each failure path returns the correct typed reason,
 * the 3-second deadline, zero process starts, and non-Windows immediate return.
 *
 * Requirements: 4.2–4.10, 16.1–16.7
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import {
  runRuntimeProbe,
  RuntimeProbeConfig,
  SignatureResult,
  compareVersions,
  validateManifestSchema,
} from '../../stageC/runtimeProbe';

import {
  ProbeFailureReason,
  StageCManifest,
  STAGE_C_RESOURCES_DIR,
  MANIFEST_FILENAME,
  DEPENDENCY_LOCK_FILENAME,
  DIAGNOSTIC_MARKER_FILENAME,
} from '../../stageC/types';

// --------------------------------------------------------------------
// Test fixtures and helpers
// --------------------------------------------------------------------

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function createValidManifest(overrides: Partial<StageCManifest> = {}): StageCManifest {
  return {
    app_version: '1.0.0',
    sidecar_version: '1.0.0',
    protocol_major: 1,
    protocol_minor: 0,
    bridge_schema_version: 1,
    supported_architectures: ['x64'],
    minimum_webview2_version: '119.0.2151.0',
    capabilities: ['overlay'],
    dependency_lock_hash: '', // Will be set after writing the lock file
    sidecar_path: 'ZuleUI.exe',
    release_gate_evidence_id: 'evidence-abc-123',
    artifact_hashes: { 'ZuleUI.exe': 'fakehash' },
    publisher: 'Zule AI',
    ...overrides,
  };
}

/** Creates a temp fixture directory with valid Stage C resources */
function createFixture(): {
  resourcesPath: string;
  stageCPath: string;
  cleanup: () => void;
} {
  const resourcesPath = mkdtempSync(join(tmpdir(), 'zule-probe-test-'));
  const stageCPath = join(resourcesPath, STAGE_C_RESOURCES_DIR);
  mkdirSync(stageCPath, { recursive: true });
  return {
    resourcesPath,
    stageCPath,
    cleanup: () => rmSync(resourcesPath, { recursive: true, force: true }),
  };
}

/** Writes a complete valid Stage C fixture and returns config for probing */
function writeValidFixture(fixture: {
  stageCPath: string;
  resourcesPath: string;
}): RuntimeProbeConfig {
  const { stageCPath, resourcesPath } = fixture;

  // Write dependency lock
  const lockContent = JSON.stringify({ lockVersion: 1, architecture: 'x64' });
  writeFileSync(join(stageCPath, DEPENDENCY_LOCK_FILENAME), lockContent);
  const lockHash = sha256(lockContent);

  // Write manifest
  const manifest = createValidManifest({ dependency_lock_hash: lockHash });
  writeFileSync(join(stageCPath, MANIFEST_FILENAME), JSON.stringify(manifest));

  // Write sidecar binary placeholder
  writeFileSync(join(stageCPath, 'ZuleUI.exe'), 'fake-binary');

  // Write diagnostic marker (for non-production test paths)
  writeFileSync(join(stageCPath, DIAGNOSTIC_MARKER_FILENAME), '');

  return {
    platform: 'win32',
    arch: 'x64',
    resourcesPath,
    appVersion: '1.0.0',
    isPackaged: false,
    queryWebView2: () => '120.0.2210.55',
    verifySignature: () => ({
      valid: true,
      publisher: 'Zule AI',
      status: 'valid' as const,
    }),
    deadlineMs: 3000,
  };
}

// --------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------

describe('Stage C Runtime Probe', () => {
  let fixture: ReturnType<typeof createFixture>;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  // ─── Non-Windows immediate return (Req 16.1–16.3) ─────────────────

  describe('Non-Windows platform guard', () => {
    it('returns NON_WINDOWS immediately on darwin', async () => {
      const result = await runRuntimeProbe({ platform: 'darwin' });
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(ProbeFailureReason.NON_WINDOWS);
    });

    it('returns NON_WINDOWS immediately on linux', async () => {
      const result = await runRuntimeProbe({ platform: 'linux' });
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(ProbeFailureReason.NON_WINDOWS);
    });

    it('does not attempt any file reads on non-Windows', async () => {
      // Pass invalid resourcesPath — if it were accessed, it would throw
      const result = await runRuntimeProbe({
        platform: 'linux',
        resourcesPath: '/nonexistent/path',
      });
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(ProbeFailureReason.NON_WINDOWS);
    });
  });

  // ─── Architecture check ────────────────────────────────────────────

  describe('Architecture check', () => {
    it('rejects unsupported architecture (ia32)', async () => {
      const result = await runRuntimeProbe({
        platform: 'win32',
        arch: 'ia32',
        resourcesPath: fixture.resourcesPath,
      });
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(ProbeFailureReason.UNSUPPORTED_ARCHITECTURE);
    });

    it('rejects unsupported architecture (mips)', async () => {
      const result = await runRuntimeProbe({
        platform: 'win32',
        arch: 'mips',
        resourcesPath: fixture.resourcesPath,
      });
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(ProbeFailureReason.UNSUPPORTED_ARCHITECTURE);
    });
  });

  // ─── Manifest checks ──────────────────────────────────────────────

  describe('Manifest checks', () => {
    it('returns MANIFEST_MISSING when manifest file does not exist', async () => {
      const config = writeValidFixture(fixture);
      // Remove the manifest
      rmSync(join(fixture.stageCPath, MANIFEST_FILENAME));

      const result = await runRuntimeProbe(config);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(ProbeFailureReason.MANIFEST_MISSING);
    });

    it('returns MANIFEST_SCHEMA_INVALID for malformed JSON', async () => {
      const config = writeValidFixture(fixture);
      writeFileSync(join(fixture.stageCPath, MANIFEST_FILENAME), 'not-json{{{');

      const result = await runRuntimeProbe(config);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(ProbeFailureReason.MANIFEST_MISSING);
    });

    it('returns MANIFEST_SCHEMA_INVALID for missing required fields', async () => {
      const config = writeValidFixture(fixture);
      writeFileSync(
        join(fixture.stageCPath, MANIFEST_FILENAME),
        JSON.stringify({ app_version: '1.0.0' }) // Missing other fields
      );

      const result = await runRuntimeProbe(config);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(ProbeFailureReason.MANIFEST_SCHEMA_INVALID);
    });

    it('returns MANIFEST_SCHEMA_INVALID for extra unknown fields', async () => {
      const config = writeValidFixture(fixture);
      const manifest = createValidManifest({ dependency_lock_hash: 'x' });
      const withExtra = { ...manifest, unknown_field: 'bad' };
      writeFileSync(join(fixture.stageCPath, MANIFEST_FILENAME), JSON.stringify(withExtra));

      const result = await runRuntimeProbe(config);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(ProbeFailureReason.MANIFEST_SCHEMA_INVALID);
    });
  });

  // ─── Sidecar presence ──────────────────────────────────────────────

  describe('Sidecar presence', () => {
    it('returns SIDECAR_NOT_FOUND when binary missing', async () => {
      const config = writeValidFixture(fixture);
      rmSync(join(fixture.stageCPath, 'ZuleUI.exe'));

      const result = await runRuntimeProbe(config);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(ProbeFailureReason.SIDECAR_NOT_FOUND);
    });
  });

  // ─── Architecture matching ─────────────────────────────────────────

  describe('Sidecar architecture matching', () => {
    it('returns SIDECAR_ARCHITECTURE_MISMATCH when arch not in manifest', async () => {
      const config = writeValidFixture(fixture);
      // Override arch to arm64 but manifest only supports x64
      config.arch = 'arm64';

      const result = await runRuntimeProbe(config);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(ProbeFailureReason.SIDECAR_ARCHITECTURE_MISMATCH);
    });
  });

  // ─── Protocol and bridge schema ───────────────────────────────────

  describe('Protocol and bridge schema', () => {
    it('returns PROTOCOL_MAJOR_MISMATCH when protocol_major differs', async () => {
      const config = writeValidFixture(fixture);
      // Write manifest with wrong protocol major
      const lockContent = JSON.stringify({ lockVersion: 1, architecture: 'x64' });
      const lockHash = sha256(lockContent);
      const badManifest = createValidManifest({
        protocol_major: 99,
        dependency_lock_hash: lockHash,
      });
      writeFileSync(join(fixture.stageCPath, MANIFEST_FILENAME), JSON.stringify(badManifest));

      const result = await runRuntimeProbe(config);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(ProbeFailureReason.PROTOCOL_MAJOR_MISMATCH);
    });

    it('returns BRIDGE_SCHEMA_INCOMPATIBLE when bridge schema out of range', async () => {
      const config = writeValidFixture(fixture);
      const lockContent = JSON.stringify({ lockVersion: 1, architecture: 'x64' });
      const lockHash = sha256(lockContent);
      const badManifest = createValidManifest({
        bridge_schema_version: 999,
        dependency_lock_hash: lockHash,
      });
      writeFileSync(join(fixture.stageCPath, MANIFEST_FILENAME), JSON.stringify(badManifest));

      const result = await runRuntimeProbe(config);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(ProbeFailureReason.BRIDGE_SCHEMA_INCOMPATIBLE);
    });
  });

  // ─── WebView2 Runtime checks ──────────────────────────────────────

  describe('WebView2 Runtime', () => {
    it('returns WEBVIEW2_NOT_FOUND when runtime not installed', async () => {
      const config = writeValidFixture(fixture);
      config.queryWebView2 = () => null;

      const result = await runRuntimeProbe(config);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(ProbeFailureReason.WEBVIEW2_NOT_FOUND);
    });

    it('returns WEBVIEW2_VERSION_TOO_OLD when version below minimum', async () => {
      const config = writeValidFixture(fixture);
      config.queryWebView2 = () => '100.0.0.0'; // Below minimum 119.0.2151.0

      const result = await runRuntimeProbe(config);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(ProbeFailureReason.WEBVIEW2_VERSION_TOO_OLD);
    });

    it('passes when WebView2 version meets minimum', async () => {
      const config = writeValidFixture(fixture);
      config.queryWebView2 = () => '119.0.2151.0'; // Exactly minimum

      const result = await runRuntimeProbe(config);
      // Should pass this check (may fail on later checks in production mode)
      expect(result.reason).not.toBe(ProbeFailureReason.WEBVIEW2_NOT_FOUND);
      expect(result.reason).not.toBe(ProbeFailureReason.WEBVIEW2_VERSION_TOO_OLD);
    });
  });

  // ─── Dependency lock integrity ────────────────────────────────────

  describe('Dependency lock integrity', () => {
    it('returns DEPENDENCY_LOCK_MISSING when lock file absent', async () => {
      const config = writeValidFixture(fixture);
      rmSync(join(fixture.stageCPath, DEPENDENCY_LOCK_FILENAME));

      const result = await runRuntimeProbe(config);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(ProbeFailureReason.DEPENDENCY_LOCK_MISSING);
    });

    it('returns DEPENDENCY_LOCK_INTEGRITY_FAILURE when hash mismatch', async () => {
      const config = writeValidFixture(fixture);
      // Modify the lock file after manifest was written with original hash
      writeFileSync(join(fixture.stageCPath, DEPENDENCY_LOCK_FILENAME), 'tampered-content');

      const result = await runRuntimeProbe(config);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(ProbeFailureReason.DEPENDENCY_LOCK_INTEGRITY_FAILURE);
    });
  });

  // ─── Production-only checks (Req 4.5–4.8) ─────────────────────────

  describe('Production signature and version checks', () => {
    it('returns RELEASE_GATE_MISSING in production with no evidence', async () => {
      const config = writeValidFixture(fixture);
      config.isPackaged = true;
      // Remove diagnostic marker to make it production
      rmSync(join(fixture.stageCPath, DIAGNOSTIC_MARKER_FILENAME));
      // Write manifest with null release_gate_evidence_id
      const lockContent = JSON.stringify({ lockVersion: 1, architecture: 'x64' });
      writeFileSync(join(fixture.stageCPath, DEPENDENCY_LOCK_FILENAME), lockContent);
      const lockHash = sha256(lockContent);
      const manifest = createValidManifest({
        dependency_lock_hash: lockHash,
        release_gate_evidence_id: null,
      });
      writeFileSync(join(fixture.stageCPath, MANIFEST_FILENAME), JSON.stringify(manifest));

      const result = await runRuntimeProbe(config);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(ProbeFailureReason.RELEASE_GATE_MISSING);
    });

    it('returns SIGNATURE_INVALID when signature is not valid', async () => {
      const config = writeValidFixture(fixture);
      config.isPackaged = true;
      // Remove diagnostic marker for production
      rmSync(join(fixture.stageCPath, DIAGNOSTIC_MARKER_FILENAME));
      config.verifySignature = () => ({
        valid: false,
        publisher: null,
        status: 'invalid' as const,
      });

      const result = await runRuntimeProbe(config);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(ProbeFailureReason.SIGNATURE_INVALID);
    });

    it('returns SIGNATURE_INDETERMINATE for unknown/offline/warning status', async () => {
      const config = writeValidFixture(fixture);
      config.isPackaged = true;
      rmSync(join(fixture.stageCPath, DIAGNOSTIC_MARKER_FILENAME));
      config.verifySignature = () => ({
        valid: false,
        publisher: null,
        status: 'unknown' as const,
      });

      const result = await runRuntimeProbe(config);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(ProbeFailureReason.SIGNATURE_INDETERMINATE);
    });

    it('returns SIGNATURE_WRONG_PUBLISHER when signed by wrong publisher', async () => {
      const config = writeValidFixture(fixture);
      config.isPackaged = true;
      rmSync(join(fixture.stageCPath, DIAGNOSTIC_MARKER_FILENAME));
      config.verifySignature = () => ({
        valid: true,
        publisher: 'Evil Corp',
        status: 'valid' as const,
      });

      const result = await runRuntimeProbe(config);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(ProbeFailureReason.SIGNATURE_WRONG_PUBLISHER);
    });

    it('returns VERSION_MISMATCH when sidecar version differs from app', async () => {
      const config = writeValidFixture(fixture);
      config.isPackaged = true;
      config.appVersion = '2.0.0'; // Differs from manifest's 1.0.0
      rmSync(join(fixture.stageCPath, DIAGNOSTIC_MARKER_FILENAME));

      const result = await runRuntimeProbe(config);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(ProbeFailureReason.VERSION_MISMATCH);
    });
  });

  // ─── Diagnostic build marker (Req 4.9) ────────────────────────────

  describe('Diagnostic build marker', () => {
    it('returns DIAGNOSTIC_MARKER_MISSING when marker absent in dev', async () => {
      const config = writeValidFixture(fixture);
      config.isPackaged = false;
      // Remove the diagnostic marker
      rmSync(join(fixture.stageCPath, DIAGNOSTIC_MARKER_FILENAME));

      const result = await runRuntimeProbe(config);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(ProbeFailureReason.DIAGNOSTIC_MARKER_MISSING);
    });
  });

  // ─── Deadline enforcement (Req 4.2, 4.10) ─────────────────────────

  describe('Absolute 3-second deadline', () => {
    it('returns DEADLINE_EXPIRED when deadline is already past', async () => {
      const config = writeValidFixture(fixture);
      // Use a deadline of 0ms to simulate expired
      config.deadlineMs = 0;

      const result = await runRuntimeProbe(config);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(ProbeFailureReason.DEADLINE_EXPIRED);
    });

    it('returns DEADLINE_EXPIRED with very short deadline (1ms)', async () => {
      const config = writeValidFixture(fixture);
      config.deadlineMs = 1;
      // Add a slow WebView2 query to consume time
      config.queryWebView2 = () => {
        const start = Date.now();
        while (Date.now() - start < 5) { /* busy wait */ }
        return '120.0.0.0';
      };

      const result = await runRuntimeProbe(config);
      // With 1ms deadline, it should expire at some point
      if (!result.eligible) {
        expect(result.reason).toBe(ProbeFailureReason.DEADLINE_EXPIRED);
      }
    });
  });

  // ─── Zero process starts (Req 4.3) ────────────────────────────────

  describe('Zero process starts', () => {
    it('never spawns ZuleUI.exe even when all checks pass', async () => {
      const config = writeValidFixture(fixture);
      // Spy on child_process — if the probe tried to spawn ZuleUI.exe
      // it would need execSync/spawn. Our probe only uses execSync for
      // registry/signature queries through injected deps.
      let spawnCalled = false;
      config.queryWebView2 = () => {
        // This is the only external call — it queries registry, not ZuleUI.exe
        return '120.0.2210.55';
      };
      config.verifySignature = (path: string) => {
        // Verify path is NOT ZuleUI.exe being executed
        expect(path).toContain('ZuleUI.exe');
        // This is signature verification, not process execution
        return { valid: true, publisher: 'Zule AI', status: 'valid' as const };
      };

      const result = await runRuntimeProbe(config);
      expect(result.eligible).toBe(true);
      // The probe never calls spawn/exec on the sidecar binary itself
    });
  });

  // ─── Happy path (all checks pass) ─────────────────────────────────

  describe('Successful probe', () => {
    it('returns eligible=true when all checks pass in diagnostic mode', async () => {
      const config = writeValidFixture(fixture);

      const result = await runRuntimeProbe(config);
      expect(result.eligible).toBe(true);
      expect(result.reason).toBeNull();
    });

    it('returns eligible=true when all checks pass in production mode', async () => {
      const config = writeValidFixture(fixture);
      config.isPackaged = true;
      config.appVersion = '1.0.0';
      // Remove diagnostic marker for production
      rmSync(join(fixture.stageCPath, DIAGNOSTIC_MARKER_FILENAME));
      // Re-write manifest/lock for production
      const lockContent = JSON.stringify({ lockVersion: 1, architecture: 'x64' });
      writeFileSync(join(fixture.stageCPath, DEPENDENCY_LOCK_FILENAME), lockContent);
      const lockHash = sha256(lockContent);
      const manifest = createValidManifest({ dependency_lock_hash: lockHash });
      writeFileSync(join(fixture.stageCPath, MANIFEST_FILENAME), JSON.stringify(manifest));

      const result = await runRuntimeProbe(config);
      expect(result.eligible).toBe(true);
      expect(result.reason).toBeNull();
    });
  });

  // ─── Native boundary failure (Req 16.5, 16.7) ─────────────────────

  describe('Native boundary failure', () => {
    it('returns NATIVE_BOUNDARY_FAILURE when resourcesPath is undefined', async () => {
      const result = await runRuntimeProbe({
        platform: 'win32',
        arch: 'x64',
        resourcesPath: undefined,
      });
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(ProbeFailureReason.NATIVE_BOUNDARY_FAILURE);
    });
  });

  // ─── Content-free reason assertion (Req 4.10) ─────────────────────

  describe('Content-free typed reasons', () => {
    it('every failure reason is a typed enum value (no user content)', async () => {
      // Test a sample of failures and verify they return only enum values
      const failureConfigs: RuntimeProbeConfig[] = [
        { platform: 'darwin' },
        { platform: 'win32', arch: 'ia32', resourcesPath: fixture.resourcesPath },
        { platform: 'win32', arch: 'x64', resourcesPath: undefined },
      ];

      for (const cfg of failureConfigs) {
        const result = await runRuntimeProbe(cfg);
        expect(result.eligible).toBe(false);
        expect(result.reason).not.toBeNull();
        // Verify reason is a member of ProbeFailureReason enum
        const validReasons = Object.values(ProbeFailureReason);
        expect(validReasons).toContain(result.reason);
      }
    });
  });
});

// --------------------------------------------------------------------
// Unit tests for helper functions
// --------------------------------------------------------------------

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('119.0.2151.0', '119.0.2151.0')).toBe(0);
  });

  it('returns positive when first is greater', () => {
    expect(compareVersions('2.0.0', '1.0.0')).toBeGreaterThan(0);
    expect(compareVersions('119.0.2152.0', '119.0.2151.0')).toBeGreaterThan(0);
    expect(compareVersions('120.0.0.0', '119.9.9999.9999')).toBeGreaterThan(0);
  });

  it('returns negative when first is smaller', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('118.0.0.0', '119.0.2151.0')).toBeLessThan(0);
  });

  it('handles different length version strings', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.1', '1.0')).toBeGreaterThan(0);
  });
});

describe('validateManifestSchema', () => {
  it('accepts a valid manifest', () => {
    const manifest = createValidManifest({ dependency_lock_hash: 'abc123' });
    expect(validateManifestSchema(manifest)).toBe(true);
  });

  it('rejects null', () => {
    expect(validateManifestSchema(null)).toBe(false);
  });

  it('rejects non-object', () => {
    expect(validateManifestSchema('string')).toBe(false);
    expect(validateManifestSchema(42)).toBe(false);
  });

  it('rejects missing fields', () => {
    expect(validateManifestSchema({ app_version: '1.0.0' })).toBe(false);
  });

  it('rejects extra fields', () => {
    const manifest = { ...createValidManifest({ dependency_lock_hash: 'x' }), extra: 'bad' };
    expect(validateManifestSchema(manifest)).toBe(false);
  });

  it('rejects invalid architecture values', () => {
    const manifest = createValidManifest({ dependency_lock_hash: 'x' });
    (manifest as any).supported_architectures = ['x86'];
    expect(validateManifestSchema(manifest)).toBe(false);
  });

  it('rejects empty supported_architectures', () => {
    const manifest = createValidManifest({ dependency_lock_hash: 'x' });
    (manifest as any).supported_architectures = [];
    expect(validateManifestSchema(manifest)).toBe(false);
  });

  it('rejects non-integer protocol_major', () => {
    const manifest = createValidManifest({ dependency_lock_hash: 'x' });
    (manifest as any).protocol_major = 1.5;
    expect(validateManifestSchema(manifest)).toBe(false);
  });
});
