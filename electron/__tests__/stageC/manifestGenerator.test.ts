/**
 * Stage C Manifest Generator — Unit Tests
 *
 * Tests final manifest generation (hash computation, binding completeness)
 * and verification (hash matching, signature trust, production checks).
 *
 * Requirements: 4.5–4.9, 14.4–14.8
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import {
  generateFinalManifest,
  verifyManifest,
  SignatureTrustLevel,
  ManifestGenerationConfig,
  ManifestVerificationConfig,
  SignatureVerificationResult,
} from '../../stageC/manifestGenerator';

// ────────────────────────────────────────────────────────────────────
// Test Helpers
// ────────────────────────────────────────────────────────────────────

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

interface TestFixture {
  basePath: string;
  cleanup: () => void;
}

function createFixture(): TestFixture {
  const basePath = mkdtempSync(join(tmpdir(), 'zule-manifest-gen-test-'));
  return {
    basePath,
    cleanup: () => rmSync(basePath, { recursive: true, force: true }),
  };
}

function writeArtifact(basePath: string, relativePath: string, content: string): void {
  const dir = join(basePath, relativePath, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(basePath, relativePath), content);
}

function createDefaultGenerationConfig(basePath: string): ManifestGenerationConfig {
  return {
    artifactsBasePath: basePath,
    artifactRelativePaths: ['ZuleUI.exe', 'overlay/index.html', 'dependency-lock.json'],
    appVersion: '2.1.0',
    sidecarVersion: '2.1.0',
    supportedArchitectures: ['x64'],
    minimumWebview2Version: '119.0.2151.0',
    capabilities: ['overlay', 'ai'],
    sidecarPath: 'ZuleUI.exe',
    releaseGateEvidenceId: 'evidence-release-2.1.0-abc',
    publisher: 'Zule AI',
    dependencyLockHash: sha256('lock-content'),
  };
}

function validSignatureVerifier(expectedPublisher: string) {
  return (_path: string): SignatureVerificationResult => ({
    trustLevel: SignatureTrustLevel.VALID,
    publisher: expectedPublisher,
  });
}

function failingSignatureVerifier(trustLevel: SignatureTrustLevel, publisher: string | null = null) {
  return (_path: string): SignatureVerificationResult => ({
    trustLevel,
    publisher,
  });
}

// ────────────────────────────────────────────────────────────────────
// generateFinalManifest Tests (Req 14.5, 14.6)
// ────────────────────────────────────────────────────────────────────

describe('generateFinalManifest', () => {
  let fixture: TestFixture;

  beforeEach(() => {
    fixture = createFixture();
    // Create artifacts
    writeArtifact(fixture.basePath, 'ZuleUI.exe', 'sidecar-binary-content');
    writeArtifact(fixture.basePath, 'overlay/index.html', '<html>overlay</html>');
    writeArtifact(fixture.basePath, 'dependency-lock.json', '{"locked":true}');
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('computes correct SHA-256 hashes for all artifacts', () => {
    const config = createDefaultGenerationConfig(fixture.basePath);
    const result = generateFinalManifest(config);

    expect(result.success).toBe(true);
    expect(result.manifestJson).toBeDefined();

    const manifest = JSON.parse(result.manifestJson!);
    expect(manifest.artifact_hashes['ZuleUI.exe']).toBe(sha256('sidecar-binary-content'));
    expect(manifest.artifact_hashes['overlay/index.html']).toBe(sha256('<html>overlay</html>'));
    expect(manifest.artifact_hashes['dependency-lock.json']).toBe(sha256('{"locked":true}'));
  });

  it('binds all required fields from config', () => {
    const config = createDefaultGenerationConfig(fixture.basePath);
    const result = generateFinalManifest(config);

    expect(result.success).toBe(true);
    const manifest = JSON.parse(result.manifestJson!);

    expect(manifest.app_version).toBe('2.1.0');
    expect(manifest.sidecar_version).toBe('2.1.0');
    expect(manifest.supported_architectures).toEqual(['x64']);
    expect(manifest.minimum_webview2_version).toBe('119.0.2151.0');
    expect(manifest.capabilities).toEqual(['overlay', 'ai']);
    expect(manifest.sidecar_path).toBe('ZuleUI.exe');
    expect(manifest.release_gate_evidence_id).toBe('evidence-release-2.1.0-abc');
    expect(manifest.publisher).toBe('Zule AI');
    expect(manifest.dependency_lock_hash).toBe(sha256('lock-content'));
  });

  it('binds protocol and bridge schema from canonical source', () => {
    const config = createDefaultGenerationConfig(fixture.basePath);
    const result = generateFinalManifest(config);

    expect(result.success).toBe(true);
    const manifest = JSON.parse(result.manifestJson!);

    expect(manifest.protocol_major).toBe(1);
    expect(manifest.protocol_minor).toBe(0);
    expect(manifest.bridge_schema_version).toBe(1);
  });

  it('fails when artifact file is missing', () => {
    const config = createDefaultGenerationConfig(fixture.basePath);
    config.artifactRelativePaths.push('nonexistent.dll');
    const result = generateFinalManifest(config);

    expect(result.success).toBe(false);
    expect(result.errors.some(e => e.includes('nonexistent.dll'))).toBe(true);
  });

  it('fails when appVersion is empty', () => {
    const config = createDefaultGenerationConfig(fixture.basePath);
    config.appVersion = '';
    const result = generateFinalManifest(config);

    expect(result.success).toBe(false);
    expect(result.errors.some(e => e.includes('appVersion'))).toBe(true);
  });

  it('fails when publisher is empty', () => {
    const config = createDefaultGenerationConfig(fixture.basePath);
    config.publisher = '';
    const result = generateFinalManifest(config);

    expect(result.success).toBe(false);
    expect(result.errors.some(e => e.includes('publisher'))).toBe(true);
  });

  it('fails when no artifact paths provided', () => {
    const config = createDefaultGenerationConfig(fixture.basePath);
    config.artifactRelativePaths = [];
    const result = generateFinalManifest(config);

    expect(result.success).toBe(false);
    expect(result.errors.some(e => e.includes('artifact'))).toBe(true);
  });

  it('fails when supportedArchitectures is empty', () => {
    const config = createDefaultGenerationConfig(fixture.basePath);
    config.supportedArchitectures = [];
    const result = generateFinalManifest(config);

    expect(result.success).toBe(false);
    expect(result.errors.some(e => e.includes('architecture'))).toBe(true);
  });

  it('handles null releaseGateEvidenceId for diagnostic builds', () => {
    const config = createDefaultGenerationConfig(fixture.basePath);
    config.releaseGateEvidenceId = null;
    const result = generateFinalManifest(config);

    expect(result.success).toBe(true);
    const manifest = JSON.parse(result.manifestJson!);
    expect(manifest.release_gate_evidence_id).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
// verifyManifest Tests (Req 4.5–4.9, 14.4, 14.7)
// ────────────────────────────────────────────────────────────────────

describe('verifyManifest', () => {
  let fixture: TestFixture;

  beforeEach(() => {
    fixture = createFixture();
    writeArtifact(fixture.basePath, 'ZuleUI.exe', 'sidecar-binary-content');
    writeArtifact(fixture.basePath, 'overlay/index.html', '<html>overlay</html>');
    writeArtifact(fixture.basePath, 'dependency-lock.json', '{"locked":true}');
  });

  afterEach(() => {
    fixture.cleanup();
  });

  function generateTestManifest(): string {
    const config = createDefaultGenerationConfig(fixture.basePath);
    const result = generateFinalManifest(config);
    return result.manifestJson!;
  }

  describe('artifact hash verification', () => {
    it('passes when all artifact hashes match', () => {
      const manifestJson = generateTestManifest();
      const verifyConfig: ManifestVerificationConfig = {
        artifactsBasePath: fixture.basePath,
        isProduction: false,
        expectedPublisher: 'Zule AI',
      };

      const result = verifyManifest(manifestJson, verifyConfig);
      expect(result.valid).toBe(true);
      expect(result.manifest).toBeDefined();
    });

    it('fails when artifact hash does not match (file was modified)', () => {
      const manifestJson = generateTestManifest();

      // Modify the actual file after manifest was generated
      writeArtifact(fixture.basePath, 'ZuleUI.exe', 'MODIFIED-content');

      const verifyConfig: ManifestVerificationConfig = {
        artifactsBasePath: fixture.basePath,
        isProduction: false,
        expectedPublisher: 'Zule AI',
      };

      const result = verifyManifest(manifestJson, verifyConfig);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'ARTIFACT_HASH_MISMATCH')).toBe(true);
    });

    it('fails when artifact file is missing', () => {
      const manifestJson = generateTestManifest();

      // Remove the actual file
      rmSync(join(fixture.basePath, 'ZuleUI.exe'));

      const verifyConfig: ManifestVerificationConfig = {
        artifactsBasePath: fixture.basePath,
        isProduction: false,
        expectedPublisher: 'Zule AI',
      };

      const result = verifyManifest(manifestJson, verifyConfig);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'ARTIFACT_NOT_FOUND')).toBe(true);
    });
  });

  describe('signature trust verification (production, Req 4.6, 4.7)', () => {
    it('passes with VALID trust level and matching publisher', () => {
      const manifestJson = generateTestManifest();
      const verifyConfig: ManifestVerificationConfig = {
        artifactsBasePath: fixture.basePath,
        isProduction: true,
        expectedPublisher: 'Zule AI',
        signatureVerifier: validSignatureVerifier('Zule AI'),
        expectedAppVersion: '2.1.0',
      };

      const result = verifyManifest(manifestJson, verifyConfig);
      expect(result.valid).toBe(true);
    });

    it('fails with INVALID trust level', () => {
      const manifestJson = generateTestManifest();
      const verifyConfig: ManifestVerificationConfig = {
        artifactsBasePath: fixture.basePath,
        isProduction: true,
        expectedPublisher: 'Zule AI',
        signatureVerifier: failingSignatureVerifier(SignatureTrustLevel.INVALID),
        expectedAppVersion: '2.1.0',
      };

      const result = verifyManifest(manifestJson, verifyConfig);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'SIGNATURE_INVALID')).toBe(true);
    });

    it('fails with UNKNOWN trust level', () => {
      const manifestJson = generateTestManifest();
      const verifyConfig: ManifestVerificationConfig = {
        artifactsBasePath: fixture.basePath,
        isProduction: true,
        expectedPublisher: 'Zule AI',
        signatureVerifier: failingSignatureVerifier(SignatureTrustLevel.UNKNOWN),
        expectedAppVersion: '2.1.0',
      };

      const result = verifyManifest(manifestJson, verifyConfig);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'SIGNATURE_UNKNOWN')).toBe(true);
    });

    it('fails with OFFLINE trust level', () => {
      const manifestJson = generateTestManifest();
      const verifyConfig: ManifestVerificationConfig = {
        artifactsBasePath: fixture.basePath,
        isProduction: true,
        expectedPublisher: 'Zule AI',
        signatureVerifier: failingSignatureVerifier(SignatureTrustLevel.OFFLINE),
        expectedAppVersion: '2.1.0',
      };

      const result = verifyManifest(manifestJson, verifyConfig);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'SIGNATURE_OFFLINE')).toBe(true);
    });

    it('fails with WARNING trust level', () => {
      const manifestJson = generateTestManifest();
      const verifyConfig: ManifestVerificationConfig = {
        artifactsBasePath: fixture.basePath,
        isProduction: true,
        expectedPublisher: 'Zule AI',
        signatureVerifier: failingSignatureVerifier(SignatureTrustLevel.WARNING),
        expectedAppVersion: '2.1.0',
      };

      const result = verifyManifest(manifestJson, verifyConfig);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'SIGNATURE_WARNING')).toBe(true);
    });

    it('fails with INDETERMINATE trust level', () => {
      const manifestJson = generateTestManifest();
      const verifyConfig: ManifestVerificationConfig = {
        artifactsBasePath: fixture.basePath,
        isProduction: true,
        expectedPublisher: 'Zule AI',
        signatureVerifier: failingSignatureVerifier(SignatureTrustLevel.INDETERMINATE),
        expectedAppVersion: '2.1.0',
      };

      const result = verifyManifest(manifestJson, verifyConfig);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'SIGNATURE_INDETERMINATE')).toBe(true);
    });

    it('fails with OTHER_PUBLISHER trust level', () => {
      const manifestJson = generateTestManifest();
      const verifyConfig: ManifestVerificationConfig = {
        artifactsBasePath: fixture.basePath,
        isProduction: true,
        expectedPublisher: 'Zule AI',
        signatureVerifier: failingSignatureVerifier(SignatureTrustLevel.OTHER_PUBLISHER, 'Evil Corp'),
        expectedAppVersion: '2.1.0',
      };

      const result = verifyManifest(manifestJson, verifyConfig);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'SIGNATURE_WRONG_PUBLISHER')).toBe(true);
    });

    it('fails when VALID but publisher does not match', () => {
      const manifestJson = generateTestManifest();
      const verifyConfig: ManifestVerificationConfig = {
        artifactsBasePath: fixture.basePath,
        isProduction: true,
        expectedPublisher: 'Zule AI',
        signatureVerifier: validSignatureVerifier('Some Other Publisher'),
        expectedAppVersion: '2.1.0',
      };

      const result = verifyManifest(manifestJson, verifyConfig);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'SIGNATURE_WRONG_PUBLISHER')).toBe(true);
    });
  });

  describe('production version equality (Req 4.8)', () => {
    it('fails when app_version does not match expected', () => {
      const manifestJson = generateTestManifest(); // generates with 2.1.0
      const verifyConfig: ManifestVerificationConfig = {
        artifactsBasePath: fixture.basePath,
        isProduction: true,
        expectedPublisher: 'Zule AI',
        signatureVerifier: validSignatureVerifier('Zule AI'),
        expectedAppVersion: '3.0.0', // different from manifest's 2.1.0
      };

      const result = verifyManifest(manifestJson, verifyConfig);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'VERSION_MISMATCH')).toBe(true);
    });
  });

  describe('release-gate evidence (Req 4.5)', () => {
    it('fails when release_gate_evidence_id is null in production', () => {
      // Generate manifest with null evidence
      const genConfig = createDefaultGenerationConfig(fixture.basePath);
      genConfig.releaseGateEvidenceId = null;
      const genResult = generateFinalManifest(genConfig);
      const manifestJson = genResult.manifestJson!;

      const verifyConfig: ManifestVerificationConfig = {
        artifactsBasePath: fixture.basePath,
        isProduction: true,
        expectedPublisher: 'Zule AI',
        signatureVerifier: validSignatureVerifier('Zule AI'),
        expectedAppVersion: '2.1.0',
      };

      const result = verifyManifest(manifestJson, verifyConfig);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'EVIDENCE_MISSING')).toBe(true);
    });
  });

  describe('binding completeness', () => {
    it('detects missing bindings from malformed manifest', () => {
      // Manually construct a manifest with empty critical fields
      const badManifest = {
        app_version: '',
        sidecar_version: '2.1.0',
        protocol_major: 1,
        protocol_minor: 0,
        bridge_schema_version: 1,
        supported_architectures: ['x64'],
        minimum_webview2_version: '119.0.2151.0',
        capabilities: [],
        dependency_lock_hash: sha256('lock-content'),
        sidecar_path: 'ZuleUI.exe',
        release_gate_evidence_id: 'evidence-123',
        artifact_hashes: { 'ZuleUI.exe': sha256('sidecar-binary-content') },
        publisher: 'Zule AI',
      };

      const verifyConfig: ManifestVerificationConfig = {
        artifactsBasePath: fixture.basePath,
        isProduction: false,
        expectedPublisher: 'Zule AI',
      };

      // The schema validation in deserializeManifest will reject empty app_version
      const result = verifyManifest(JSON.stringify(badManifest), verifyConfig);
      expect(result.valid).toBe(false);
    });

    it('detects protocol mismatch as a binding issue', () => {
      const badManifest = {
        app_version: '2.1.0',
        sidecar_version: '2.1.0',
        protocol_major: 99,
        protocol_minor: 0,
        bridge_schema_version: 1,
        supported_architectures: ['x64'],
        minimum_webview2_version: '119.0.2151.0',
        capabilities: [],
        dependency_lock_hash: sha256('lock-content'),
        sidecar_path: 'ZuleUI.exe',
        release_gate_evidence_id: 'evidence-123',
        artifact_hashes: { 'ZuleUI.exe': sha256('sidecar-binary-content') },
        publisher: 'Zule AI',
      };

      const verifyConfig: ManifestVerificationConfig = {
        artifactsBasePath: fixture.basePath,
        isProduction: false,
        expectedPublisher: 'Zule AI',
      };

      const result = verifyManifest(JSON.stringify(badManifest), verifyConfig);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'PROTOCOL_MISMATCH')).toBe(true);
    });

    it('detects architecture mismatch', () => {
      const manifestJson = generateTestManifest(); // x64 only

      const verifyConfig: ManifestVerificationConfig = {
        artifactsBasePath: fixture.basePath,
        isProduction: false,
        expectedPublisher: 'Zule AI',
        expectedArchitecture: 'arm64',
      };

      const result = verifyManifest(manifestJson, verifyConfig);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'ARCHITECTURE_MISMATCH')).toBe(true);
    });
  });

  describe('non-production verification', () => {
    it('passes without signature check for non-production builds', () => {
      const manifestJson = generateTestManifest();
      const verifyConfig: ManifestVerificationConfig = {
        artifactsBasePath: fixture.basePath,
        isProduction: false,
        expectedPublisher: 'Zule AI',
      };

      const result = verifyManifest(manifestJson, verifyConfig);
      expect(result.valid).toBe(true);
    });

    it('does not require release evidence for non-production', () => {
      const genConfig = createDefaultGenerationConfig(fixture.basePath);
      genConfig.releaseGateEvidenceId = null;
      const genResult = generateFinalManifest(genConfig);
      const manifestJson = genResult.manifestJson!;

      const verifyConfig: ManifestVerificationConfig = {
        artifactsBasePath: fixture.basePath,
        isProduction: false,
        expectedPublisher: 'Zule AI',
      };

      const result = verifyManifest(manifestJson, verifyConfig);
      expect(result.valid).toBe(true);
    });
  });

  describe('schema validation', () => {
    it('rejects invalid JSON', () => {
      const verifyConfig: ManifestVerificationConfig = {
        artifactsBasePath: fixture.basePath,
        isProduction: false,
        expectedPublisher: 'Zule AI',
      };

      const result = verifyManifest('not valid json {{', verifyConfig);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('rejects manifest with unknown fields', () => {
      const genConfig = createDefaultGenerationConfig(fixture.basePath);
      const genResult = generateFinalManifest(genConfig);
      const parsed = JSON.parse(genResult.manifestJson!);
      parsed.unknown_field = 'bad';

      const verifyConfig: ManifestVerificationConfig = {
        artifactsBasePath: fixture.basePath,
        isProduction: false,
        expectedPublisher: 'Zule AI',
      };

      const result = verifyManifest(JSON.stringify(parsed), verifyConfig);
      expect(result.valid).toBe(false);
    });
  });
});
