/**
 * Stage C Manifest — Unit Tests
 *
 * Tests strict serialization, deserialization, schema validation,
 * and binding validation for the Stage C manifest module.
 *
 * Requirements: 4.4–4.9, 14.5–14.8
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import {
  serializeManifest,
  deserializeManifest,
  validateManifestObject,
  validateManifestBindings,
  loadAndValidateManifest,
  ManifestErrorCode,
  ManifestSerializationInput,
  ManifestBindingContext,
} from '../../stageC/manifest';

import { StageCManifest } from '../../stageC/types';

// ────────────────────────────────────────────────────────────────────
// Test Helpers
// ────────────────────────────────────────────────────────────────────

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function createValidManifestObj(overrides: Partial<StageCManifest> = {}): StageCManifest {
  return {
    app_version: '1.0.0',
    sidecar_version: '1.0.0',
    protocol_major: 1,
    protocol_minor: 0,
    bridge_schema_version: 1,
    supported_architectures: ['x64'],
    minimum_webview2_version: '119.0.2151.0',
    capabilities: ['overlay'],
    dependency_lock_hash: 'a'.repeat(64),
    sidecar_path: 'ZuleUI.exe',
    release_gate_evidence_id: 'evidence-abc-123',
    artifact_hashes: { 'ZuleUI.exe': 'b'.repeat(64) },
    publisher: 'Zule AI',
    ...overrides,
  };
}

function createValidSerializationInput(): ManifestSerializationInput {
  return {
    appVersion: '1.0.0',
    sidecarVersion: '1.0.0',
    supportedArchitectures: ['x64'],
    minimumWebview2Version: '119.0.2151.0',
    capabilities: ['overlay'],
    sidecarPath: 'ZuleUI.exe',
    releaseGateEvidenceId: 'evidence-abc-123',
    artifactHashes: { 'ZuleUI.exe': 'b'.repeat(64) },
    publisher: 'Zule AI',
    dependencyLockHash: 'a'.repeat(64),
  };
}

interface TestFixture {
  resourcesPath: string;
  stageCPath: string;
  cleanup: () => void;
}

function createFixture(): TestFixture {
  const resourcesPath = mkdtempSync(join(tmpdir(), 'zule-manifest-test-'));
  const stageCPath = join(resourcesPath, 'stage-c');
  mkdirSync(stageCPath, { recursive: true });
  return {
    resourcesPath,
    stageCPath,
    cleanup: () => rmSync(resourcesPath, { recursive: true, force: true }),
  };
}

function createBindingContext(
  fixture: TestFixture,
  overrides: Partial<ManifestBindingContext> = {},
): ManifestBindingContext {
  return {
    appArchitecture: 'x64',
    stageCResourcesPath: fixture.stageCPath,
    actualDependencyLockHash: 'a'.repeat(64),
    webView2Version: '120.0.2210.55',
    isProduction: false,
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────
// Serialization Tests (Req 14.5, 14.6)
// ────────────────────────────────────────────────────────────────────

describe('serializeManifest', () => {
  it('produces valid JSON with all required fields', () => {
    const input = createValidSerializationInput();
    const raw = serializeManifest(input);
    const parsed = JSON.parse(raw);

    expect(parsed.app_version).toBe('1.0.0');
    expect(parsed.sidecar_version).toBe('1.0.0');
    expect(parsed.protocol_major).toBe(1);
    expect(parsed.protocol_minor).toBe(0);
    expect(parsed.bridge_schema_version).toBe(1);
    expect(parsed.supported_architectures).toEqual(['x64']);
    expect(parsed.minimum_webview2_version).toBe('119.0.2151.0');
    expect(parsed.capabilities).toEqual(['overlay']);
    expect(parsed.dependency_lock_hash).toBe('a'.repeat(64));
    expect(parsed.sidecar_path).toBe('ZuleUI.exe');
    expect(parsed.release_gate_evidence_id).toBe('evidence-abc-123');
    expect(parsed.artifact_hashes).toEqual({ 'ZuleUI.exe': 'b'.repeat(64) });
    expect(parsed.publisher).toBe('Zule AI');
  });

  it('binds protocol version from canonical schema source', () => {
    const input = createValidSerializationInput();
    const raw = serializeManifest(input);
    const parsed = JSON.parse(raw);

    // Protocol constants come from protocol/schema.ts, not from input
    expect(parsed.protocol_major).toBe(1);
    expect(parsed.protocol_minor).toBe(0);
    expect(parsed.bridge_schema_version).toBe(1);
  });

  it('produces no extra fields beyond the schema', () => {
    const input = createValidSerializationInput();
    const raw = serializeManifest(input);
    const parsed = JSON.parse(raw);
    const keys = Object.keys(parsed).sort();
    const expected = [
      'app_version', 'artifact_hashes', 'bridge_schema_version',
      'capabilities', 'dependency_lock_hash', 'minimum_webview2_version',
      'protocol_major', 'protocol_minor', 'publisher',
      'release_gate_evidence_id', 'sidecar_path', 'sidecar_version',
      'supported_architectures',
    ].sort();

    expect(keys).toEqual(expected);
  });

  it('round-trips through serialize → deserialize preserving all bindings (Req 14.8)', () => {
    const input = createValidSerializationInput();
    const raw1 = serializeManifest(input);
    const result1 = deserializeManifest(raw1);
    expect(result1.valid).toBe(true);
    if (!result1.valid) return;

    // Serialize the parsed manifest again
    const raw2 = serializeManifest({
      appVersion: result1.manifest.app_version,
      sidecarVersion: result1.manifest.sidecar_version,
      supportedArchitectures: result1.manifest.supported_architectures,
      minimumWebview2Version: result1.manifest.minimum_webview2_version,
      capabilities: result1.manifest.capabilities,
      sidecarPath: result1.manifest.sidecar_path,
      releaseGateEvidenceId: result1.manifest.release_gate_evidence_id,
      artifactHashes: result1.manifest.artifact_hashes,
      publisher: result1.manifest.publisher,
      dependencyLockHash: result1.manifest.dependency_lock_hash,
    });

    const result2 = deserializeManifest(raw2);
    expect(result2.valid).toBe(true);
    if (!result2.valid) return;

    // Semantic equivalence: all fields match
    expect(result2.manifest).toEqual(result1.manifest);
  });

  it('handles null release_gate_evidence_id for diagnostic builds', () => {
    const input = createValidSerializationInput();
    input.releaseGateEvidenceId = null;
    const raw = serializeManifest(input);
    const parsed = JSON.parse(raw);
    expect(parsed.release_gate_evidence_id).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
// Deserialization / Schema Validation Tests (Req 14.7)
// ────────────────────────────────────────────────────────────────────

describe('deserializeManifest', () => {
  it('accepts a valid manifest', () => {
    const manifest = createValidManifestObj();
    const raw = JSON.stringify(manifest);
    const result = deserializeManifest(raw);
    expect(result.valid).toBe(true);
  });

  it('rejects invalid JSON', () => {
    const result = deserializeManifest('not-json{{{');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0].code).toBe(ManifestErrorCode.SCHEMA_MISMATCH);
    }
  });

  it('rejects null', () => {
    const result = deserializeManifest('null');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0].code).toBe(ManifestErrorCode.SCHEMA_MISMATCH);
    }
  });

  it('rejects arrays', () => {
    const result = deserializeManifest('[]');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0].code).toBe(ManifestErrorCode.SCHEMA_MISMATCH);
    }
  });

  it('rejects unknown/extra fields', () => {
    const manifest = { ...createValidManifestObj(), extra_field: 'bad' };
    const result = deserializeManifest(JSON.stringify(manifest));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.code === ManifestErrorCode.UNKNOWN_FIELD)).toBe(true);
      expect(result.errors.some(e => e.field === 'extra_field')).toBe(true);
    }
  });

  it('rejects missing required fields', () => {
    const { publisher, ...incomplete } = createValidManifestObj();
    const result = deserializeManifest(JSON.stringify(incomplete));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.code === ManifestErrorCode.MISSING_FIELD)).toBe(true);
      expect(result.errors.some(e => e.field === 'publisher')).toBe(true);
    }
  });

  it('rejects non-string app_version', () => {
    const manifest = createValidManifestObj();
    (manifest as any).app_version = 123;
    const result = deserializeManifest(JSON.stringify(manifest));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.field === 'app_version' && e.code === ManifestErrorCode.INVALID_TYPE)).toBe(true);
    }
  });

  it('rejects empty app_version', () => {
    const manifest = createValidManifestObj({ app_version: '' });
    const result = deserializeManifest(JSON.stringify(manifest));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.field === 'app_version')).toBe(true);
    }
  });

  it('rejects non-integer protocol_major', () => {
    const manifest = createValidManifestObj();
    (manifest as any).protocol_major = 1.5;
    const result = deserializeManifest(JSON.stringify(manifest));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.field === 'protocol_major')).toBe(true);
    }
  });

  it('rejects negative protocol_major', () => {
    const manifest = createValidManifestObj({ protocol_major: -1 });
    const result = deserializeManifest(JSON.stringify(manifest));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.field === 'protocol_major')).toBe(true);
    }
  });

  it('rejects invalid architecture values', () => {
    const manifest = createValidManifestObj();
    (manifest as any).supported_architectures = ['x86'];
    const result = deserializeManifest(JSON.stringify(manifest));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.field?.startsWith('supported_architectures'))).toBe(true);
    }
  });

  it('rejects empty supported_architectures', () => {
    const manifest = createValidManifestObj();
    (manifest as any).supported_architectures = [];
    const result = deserializeManifest(JSON.stringify(manifest));
    expect(result.valid).toBe(false);
  });

  it('rejects non-array capabilities', () => {
    const manifest = createValidManifestObj();
    (manifest as any).capabilities = 'overlay';
    const result = deserializeManifest(JSON.stringify(manifest));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.field === 'capabilities')).toBe(true);
    }
  });

  it('rejects non-string capability items', () => {
    const manifest = createValidManifestObj();
    (manifest as any).capabilities = [123];
    const result = deserializeManifest(JSON.stringify(manifest));
    expect(result.valid).toBe(false);
  });

  it('rejects artifact_hashes that is not an object', () => {
    const manifest = createValidManifestObj();
    (manifest as any).artifact_hashes = ['bad'];
    const result = deserializeManifest(JSON.stringify(manifest));
    expect(result.valid).toBe(false);
  });

  it('rejects artifact_hashes with non-string values', () => {
    const manifest = createValidManifestObj();
    (manifest as any).artifact_hashes = { 'ZuleUI.exe': 123 };
    const result = deserializeManifest(JSON.stringify(manifest));
    expect(result.valid).toBe(false);
  });

  it('rejects release_gate_evidence_id that is neither null nor string', () => {
    const manifest = createValidManifestObj();
    (manifest as any).release_gate_evidence_id = 42;
    const result = deserializeManifest(JSON.stringify(manifest));
    expect(result.valid).toBe(false);
  });

  it('rejects empty string release_gate_evidence_id', () => {
    const manifest = createValidManifestObj();
    (manifest as any).release_gate_evidence_id = '';
    const result = deserializeManifest(JSON.stringify(manifest));
    expect(result.valid).toBe(false);
  });

  it('accepts null release_gate_evidence_id', () => {
    const manifest = createValidManifestObj({ release_gate_evidence_id: null });
    const result = deserializeManifest(JSON.stringify(manifest));
    expect(result.valid).toBe(true);
  });

  it('rejects bridge_schema_version < 1', () => {
    const manifest = createValidManifestObj({ bridge_schema_version: 0 });
    const result = deserializeManifest(JSON.stringify(manifest));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.field === 'bridge_schema_version')).toBe(true);
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// Binding Validation Tests (Req 4.4–4.9)
// ────────────────────────────────────────────────────────────────────

describe('validateManifestBindings', () => {
  let fixture: TestFixture;

  beforeEach(() => {
    fixture = createFixture();
    // Write sidecar binary for path validation
    writeFileSync(join(fixture.stageCPath, 'ZuleUI.exe'), 'fake-binary');
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('accepts valid bindings', () => {
    const manifest = createValidManifestObj({
      artifact_hashes: { 'ZuleUI.exe': sha256('fake-binary') },
    });
    const context = createBindingContext(fixture);
    const result = validateManifestBindings(manifest, context);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects architecture mismatch', () => {
    const manifest = createValidManifestObj({ supported_architectures: ['arm64'] });
    const context = createBindingContext(fixture, { appArchitecture: 'x64' });
    const result = validateManifestBindings(manifest, context);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === ManifestErrorCode.ARCHITECTURE_MISMATCH)).toBe(true);
  });

  it('rejects protocol major mismatch', () => {
    const manifest = createValidManifestObj({ protocol_major: 99 });
    const context = createBindingContext(fixture);
    const result = validateManifestBindings(manifest, context);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === ManifestErrorCode.PROTOCOL_MISMATCH)).toBe(true);
  });

  it('rejects bridge schema below minimum', () => {
    const manifest = createValidManifestObj({ bridge_schema_version: 0 });
    const context = createBindingContext(fixture);
    const result = validateManifestBindings(manifest, context);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === ManifestErrorCode.BRIDGE_SCHEMA_INCOMPATIBLE)).toBe(true);
  });

  it('rejects bridge schema above maximum', () => {
    const manifest = createValidManifestObj({ bridge_schema_version: 999 });
    const context = createBindingContext(fixture);
    const result = validateManifestBindings(manifest, context);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === ManifestErrorCode.BRIDGE_SCHEMA_INCOMPATIBLE)).toBe(true);
  });

  it('rejects missing sidecar file', () => {
    rmSync(join(fixture.stageCPath, 'ZuleUI.exe'));
    const manifest = createValidManifestObj();
    const context = createBindingContext(fixture);
    const result = validateManifestBindings(manifest, context);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === ManifestErrorCode.ARTIFACT_MISSING)).toBe(true);
  });

  it('rejects sidecar hash mismatch', () => {
    const manifest = createValidManifestObj({
      artifact_hashes: { 'ZuleUI.exe': 'c'.repeat(64) }, // Wrong hash
    });
    const context = createBindingContext(fixture);
    const result = validateManifestBindings(manifest, context);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === ManifestErrorCode.ARTIFACT_HASH_MISMATCH)).toBe(true);
  });

  it('rejects when WebView2 is not found', () => {
    const manifest = createValidManifestObj();
    const context = createBindingContext(fixture, { webView2Version: null });
    const result = validateManifestBindings(manifest, context);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === ManifestErrorCode.WEBVIEW2_VERSION_INVALID)).toBe(true);
  });

  it('rejects when WebView2 version is too old', () => {
    const manifest = createValidManifestObj({ minimum_webview2_version: '120.0.0.0' });
    const context = createBindingContext(fixture, { webView2Version: '119.0.2151.0' });
    const result = validateManifestBindings(manifest, context);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === ManifestErrorCode.WEBVIEW2_VERSION_INVALID)).toBe(true);
  });

  it('accepts when WebView2 version meets minimum', () => {
    const manifest = createValidManifestObj({
      minimum_webview2_version: '119.0.2151.0',
      artifact_hashes: { 'ZuleUI.exe': sha256('fake-binary') },
    });
    const context = createBindingContext(fixture, { webView2Version: '119.0.2151.0' });
    const result = validateManifestBindings(manifest, context);
    expect(result.errors.some(e => e.code === ManifestErrorCode.WEBVIEW2_VERSION_INVALID)).toBe(false);
  });

  it('rejects dependency lock hash mismatch', () => {
    const manifest = createValidManifestObj({ dependency_lock_hash: 'wrong-hash' });
    const context = createBindingContext(fixture, {
      actualDependencyLockHash: 'a'.repeat(64),
    });
    const result = validateManifestBindings(manifest, context);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === ManifestErrorCode.DEPENDENCY_LOCK_MISMATCH)).toBe(true);
  });

  describe('Production-specific checks', () => {
    it('rejects missing release_gate_evidence_id in production', () => {
      const manifest = createValidManifestObj({
        release_gate_evidence_id: null,
        artifact_hashes: { 'ZuleUI.exe': sha256('fake-binary') },
      });
      const context = createBindingContext(fixture, { isProduction: true });
      const result = validateManifestBindings(manifest, context);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === ManifestErrorCode.EVIDENCE_INVALID)).toBe(true);
    });

    it('rejects app_version mismatch in production (Req 4.8)', () => {
      const manifest = createValidManifestObj({
        app_version: '1.0.0',
        sidecar_version: '1.0.0',
        artifact_hashes: { 'ZuleUI.exe': sha256('fake-binary') },
      });
      const context = createBindingContext(fixture, {
        isProduction: true,
        appVersion: '2.0.0',
      });
      const result = validateManifestBindings(manifest, context);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.code === ManifestErrorCode.BINDING_MISMATCH && e.field === 'app_version'
      )).toBe(true);
    });

    it('rejects sidecar_version mismatch in production (Req 4.8)', () => {
      const manifest = createValidManifestObj({
        app_version: '2.0.0',
        sidecar_version: '1.0.0',
        artifact_hashes: { 'ZuleUI.exe': sha256('fake-binary') },
      });
      const context = createBindingContext(fixture, {
        isProduction: true,
        appVersion: '2.0.0',
      });
      const result = validateManifestBindings(manifest, context);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.code === ManifestErrorCode.BINDING_MISMATCH && e.field === 'sidecar_version'
      )).toBe(true);
    });

    it('rejects empty artifact_hashes in production', () => {
      const manifest = createValidManifestObj({
        artifact_hashes: {},
      });
      const context = createBindingContext(fixture, { isProduction: true });
      const result = validateManifestBindings(manifest, context);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.code === ManifestErrorCode.BINDING_MISMATCH && e.field === 'artifact_hashes'
      )).toBe(true);
    });

    it('accepts matching versions in production', () => {
      const manifest = createValidManifestObj({
        app_version: '2.0.0',
        sidecar_version: '2.0.0',
        artifact_hashes: { 'ZuleUI.exe': sha256('fake-binary') },
      });
      const context = createBindingContext(fixture, {
        isProduction: true,
        appVersion: '2.0.0',
      });
      const result = validateManifestBindings(manifest, context);
      // Should not have version or evidence errors
      expect(result.errors.some(e => e.code === ManifestErrorCode.BINDING_MISMATCH)).toBe(false);
      expect(result.errors.some(e => e.code === ManifestErrorCode.EVIDENCE_INVALID)).toBe(false);
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// loadAndValidateManifest — full pipeline (Req 14.7)
// ────────────────────────────────────────────────────────────────────

describe('loadAndValidateManifest', () => {
  let fixture: TestFixture;

  beforeEach(() => {
    fixture = createFixture();
    writeFileSync(join(fixture.stageCPath, 'ZuleUI.exe'), 'fake-binary');
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('succeeds with valid manifest and matching bindings', () => {
    const manifest = createValidManifestObj({
      artifact_hashes: { 'ZuleUI.exe': sha256('fake-binary') },
    });
    const raw = JSON.stringify(manifest);
    const context = createBindingContext(fixture);
    const result = loadAndValidateManifest(raw, context);
    expect(result.valid).toBe(true);
  });

  it('fails on schema error before checking bindings', () => {
    const raw = 'not-json';
    const context = createBindingContext(fixture);
    const result = loadAndValidateManifest(raw, context);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0].code).toBe(ManifestErrorCode.SCHEMA_MISMATCH);
    }
  });

  it('fails on binding error after schema passes', () => {
    const manifest = createValidManifestObj({
      protocol_major: 99,
    });
    const raw = JSON.stringify(manifest);
    const context = createBindingContext(fixture);
    const result = loadAndValidateManifest(raw, context);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.code === ManifestErrorCode.PROTOCOL_MISMATCH)).toBe(true);
    }
  });

  it('rejects all mismatches before probe use', () => {
    // Multiple binding issues at once
    const manifest = createValidManifestObj({
      protocol_major: 99,
      supported_architectures: ['arm64'],
      dependency_lock_hash: 'wrong-hash',
    });
    const raw = JSON.stringify(manifest);
    const context = createBindingContext(fixture, { appArchitecture: 'x64' });
    const result = loadAndValidateManifest(raw, context);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      // Should report all binding errors
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// validateManifestObject — additional edge cases
// ────────────────────────────────────────────────────────────────────

describe('validateManifestObject', () => {
  it('rejects primitive types', () => {
    expect(validateManifestObject(42).valid).toBe(false);
    expect(validateManifestObject('string').valid).toBe(false);
    expect(validateManifestObject(true).valid).toBe(false);
    expect(validateManifestObject(undefined).valid).toBe(false);
  });

  it('rejects when multiple fields are both missing and extra', () => {
    const data = {
      app_version: '1.0.0',
      unknown_1: 'x',
      unknown_2: 'y',
    };
    const result = validateManifestObject(data);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const unknowns = result.errors.filter(e => e.code === ManifestErrorCode.UNKNOWN_FIELD);
      const missing = result.errors.filter(e => e.code === ManifestErrorCode.MISSING_FIELD);
      expect(unknowns.length).toBe(2);
      expect(missing.length).toBeGreaterThan(0);
    }
  });

  it('detects all field type errors in one pass', () => {
    const manifest: Record<string, unknown> = {
      app_version: 123,
      sidecar_version: null,
      protocol_major: 'one',
      protocol_minor: [],
      bridge_schema_version: false,
      supported_architectures: 'x64',
      minimum_webview2_version: 0,
      capabilities: 'overlay',
      dependency_lock_hash: null,
      sidecar_path: 42,
      release_gate_evidence_id: [],
      artifact_hashes: 'bad',
      publisher: 0,
    };
    const result = validateManifestObject(manifest);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      // Should report type errors for each invalid field
      expect(result.errors.length).toBeGreaterThanOrEqual(5);
    }
  });
});
