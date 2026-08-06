/**
 * Tests for Stage C Packaging — Fixed resource path resolution and package set validation.
 *
 * Verifies:
 * - All artifact paths are relative to process.resourcesPath
 * - No PATH or CWD lookup is used
 * - Architecture mismatch detection
 * - Layer 0 assets are not disturbed
 * - Missing artifacts are detected
 *
 * Requirements: 14.1–14.4, 14.15–14.16, 18.1
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  StageCArtefact,
  resolveStageCPath,
  resolveLayer0Path,
  validateArchitectureMatch,
  validatePackageSet,
  getArtifactRelativePaths,
  getStageCResourcesDir,
  SIDECAR_METADATA,
  LAYER_0_RELATIVE_PATHS,
  PackageErrorCode,
} from '../stageC/packaging';

// ────────────────────────────────────────────────────────────────────
// Test Helpers
// ────────────────────────────────────────────────────────────────────

/** Creates a temporary resources directory for testing. */
function createTempResourcesDir(): string {
  const base = join(tmpdir(), `zule-packaging-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(base, { recursive: true });
  return base;
}

/** Creates all expected Stage C artifacts in a temp directory. */
function populateStageCArtefacts(basePath: string): void {
  const stageCDir = join(basePath, 'stage-c');
  mkdirSync(stageCDir, { recursive: true });
  mkdirSync(join(stageCDir, 'overlay'), { recursive: true });

  writeFileSync(join(stageCDir, 'ZuleUI.exe'), 'mock-sidecar-binary');
  writeFileSync(join(stageCDir, 'manifest.json'), JSON.stringify({ mock: true }));
  writeFileSync(join(stageCDir, 'dependency-lock.json'), JSON.stringify({ lockVersion: 1 }));
  writeFileSync(join(stageCDir, 'overlay', '.keep'), '');
}

/** Creates Layer 0 assets in a temp directory. */
function populateLayer0Assets(basePath: string): void {
  mkdirSync(join(basePath, 'dist'), { recursive: true });
  mkdirSync(join(basePath, 'dist-electron'), { recursive: true });

  writeFileSync(join(basePath, 'dist', 'index.html'), '<html></html>');
  writeFileSync(join(basePath, 'dist-electron', 'preload.mjs'), 'export default {}');
  writeFileSync(join(basePath, 'dist-electron', 'main.mjs'), 'export default {}');
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

describe('Stage C Packaging — Path Resolution', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempResourcesDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('resolveStageCPath returns absolute paths under resourcesPath for each artifact', () => {
    for (const artifact of Object.values(StageCArtefact)) {
      const resolved = resolveStageCPath(artifact, { resourcesPath: tempDir });
      expect(resolved).not.toBeNull();
      expect(resolved!.startsWith(tempDir)).toBe(true);
      // Must be under stage-c/ subdirectory
      expect(resolved!).toContain('stage-c');
    }
  });

  test('resolveStageCPath resolves sidecar binary to stage-c/ZuleUI.exe', () => {
    const path = resolveStageCPath(StageCArtefact.SIDECAR_BINARY, { resourcesPath: tempDir });
    expect(path).toBe(join(tempDir, 'stage-c', 'ZuleUI.exe'));
  });

  test('resolveStageCPath resolves manifest to stage-c/manifest.json', () => {
    const path = resolveStageCPath(StageCArtefact.MANIFEST, { resourcesPath: tempDir });
    expect(path).toBe(join(tempDir, 'stage-c', 'manifest.json'));
  });

  test('resolveStageCPath resolves dependency lock to stage-c/dependency-lock.json', () => {
    const path = resolveStageCPath(StageCArtefact.DEPENDENCY_LOCK, { resourcesPath: tempDir });
    expect(path).toBe(join(tempDir, 'stage-c', 'dependency-lock.json'));
  });

  test('resolveStageCPath resolves overlay resources to stage-c/overlay/', () => {
    const path = resolveStageCPath(StageCArtefact.OVERLAY_RESOURCES, { resourcesPath: tempDir });
    expect(path).toBe(join(tempDir, 'stage-c', 'overlay'));
  });

  test('resolveStageCPath returns null when resourcesPath is unavailable', () => {
    // Mock process without resourcesPath
    const path = resolveStageCPath(StageCArtefact.SIDECAR_BINARY, { resourcesPath: undefined as unknown as string });
    expect(path).toBeNull();
  });

  test('resolveLayer0Path resolves assets under dist/ and dist-electron/', () => {
    const htmlPath = resolveLayer0Path('rendererHtml', { resourcesPath: tempDir });
    expect(htmlPath).toBe(join(tempDir, 'dist', 'index.html'));

    const preloadPath = resolveLayer0Path('preload', { resourcesPath: tempDir });
    expect(preloadPath).toBe(join(tempDir, 'dist-electron', 'preload.mjs'));

    const mainPath = resolveLayer0Path('mainEntry', { resourcesPath: tempDir });
    expect(mainPath).toBe(join(tempDir, 'dist-electron', 'main.mjs'));
  });

  test('resolveLayer0Path returns null when resourcesPath is unavailable', () => {
    const path = resolveLayer0Path('rendererHtml', { resourcesPath: undefined as unknown as string });
    expect(path).toBeNull();
  });
});

describe('Stage C Packaging — No PATH or CWD Lookup', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempResourcesDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('resolved paths never contain CWD segments', () => {
    const cwd = process.cwd();
    for (const artifact of Object.values(StageCArtefact)) {
      const resolved = resolveStageCPath(artifact, { resourcesPath: tempDir });
      // The resolved path should be under tempDir, never referencing CWD
      // unless tempDir happens to be within CWD (unlikely for tmpdir)
      expect(resolved).not.toBeNull();
      expect(resolved!.startsWith(tempDir)).toBe(true);
    }
  });

  test('relative resourcesPath is rejected (returns null)', () => {
    // A relative path indicates CWD-based resolution, which is prohibited
    const path = resolveStageCPath(StageCArtefact.SIDECAR_BINARY, { resourcesPath: 'relative/path' });
    expect(path).toBeNull();
  });

  test('getArtifactRelativePaths returns only stage-c prefixed paths', () => {
    const paths = getArtifactRelativePaths();
    for (const relativePath of Object.values(paths)) {
      expect(relativePath.startsWith('stage-c/')).toBe(true);
    }
  });

  test('getStageCResourcesDir returns the fixed subdirectory name', () => {
    expect(getStageCResourcesDir()).toBe('stage-c');
  });
});

describe('Stage C Packaging — Architecture Mismatch Detection', () => {
  test('x64 sidecar matches x64 App Core', () => {
    const result = validateArchitectureMatch(['x64'], { arch: 'x64' });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('arm64 sidecar matches arm64 App Core', () => {
    const result = validateArchitectureMatch(['arm64'], { arch: 'arm64' });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('x64-only sidecar does not match arm64 App Core', () => {
    const result = validateArchitectureMatch(['x64'], { arch: 'arm64' });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe(PackageErrorCode.ARCHITECTURE_MISMATCH);
  });

  test('arm64-only sidecar does not match x64 App Core', () => {
    const result = validateArchitectureMatch(['arm64'], { arch: 'x64' });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe(PackageErrorCode.ARCHITECTURE_MISMATCH);
  });

  test('multi-architecture sidecar matches either', () => {
    const resultX64 = validateArchitectureMatch(['x64', 'arm64'], { arch: 'x64' });
    expect(resultX64.valid).toBe(true);

    const resultArm64 = validateArchitectureMatch(['x64', 'arm64'], { arch: 'arm64' });
    expect(resultArm64.valid).toBe(true);
  });

  test('unsupported App Core architecture is rejected', () => {
    const result = validateArchitectureMatch(['x64'], { arch: 'ia32' });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe(PackageErrorCode.ARCHITECTURE_UNSUPPORTED);
  });
});

describe('Stage C Packaging — Layer 0 Asset Retention', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempResourcesDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('validatePackageSet reports missing Layer 0 assets', () => {
    // Create Stage C artifacts but NOT Layer 0 assets
    populateStageCArtefacts(tempDir);

    const result = validatePackageSet({ resourcesPath: tempDir });
    const layer0Errors = result.errors.filter(
      (e) => e.code === PackageErrorCode.LAYER_0_ASSET_MISSING,
    );
    // Should report each missing Layer 0 asset
    expect(layer0Errors.length).toBe(Object.keys(LAYER_0_RELATIVE_PATHS).length);
  });

  test('Layer 0 paths are independent from Stage C paths', () => {
    // Layer 0 is under dist/ and dist-electron/, Stage C is under stage-c/
    for (const relativePath of Object.values(LAYER_0_RELATIVE_PATHS)) {
      expect(relativePath).not.toContain('stage-c');
    }
    const stageCPaths = getArtifactRelativePaths();
    for (const relativePath of Object.values(stageCPaths)) {
      expect(relativePath).not.toContain('dist/');
      expect(relativePath).not.toContain('dist-electron/');
    }
  });

  test('validatePackageSet passes when both Stage C and Layer 0 assets exist', () => {
    populateStageCArtefacts(tempDir);
    populateLayer0Assets(tempDir);

    const result = validatePackageSet({ resourcesPath: tempDir });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

describe('Stage C Packaging — Missing Artifact Detection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempResourcesDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('validatePackageSet detects missing sidecar binary', () => {
    populateLayer0Assets(tempDir);
    // Create some Stage C artifacts but omit the sidecar
    const stageCDir = join(tempDir, 'stage-c');
    mkdirSync(stageCDir, { recursive: true });
    mkdirSync(join(stageCDir, 'overlay'), { recursive: true });
    writeFileSync(join(stageCDir, 'manifest.json'), '{}');
    writeFileSync(join(stageCDir, 'dependency-lock.json'), '{}');
    writeFileSync(join(stageCDir, 'overlay', '.keep'), '');

    const result = validatePackageSet({ resourcesPath: tempDir });
    const sidecarErrors = result.errors.filter(
      (e) => e.artifact === StageCArtefact.SIDECAR_BINARY,
    );
    expect(sidecarErrors).toHaveLength(1);
    expect(sidecarErrors[0].code).toBe(PackageErrorCode.ARTIFACT_MISSING);
  });

  test('validatePackageSet detects missing manifest', () => {
    populateLayer0Assets(tempDir);
    const stageCDir = join(tempDir, 'stage-c');
    mkdirSync(stageCDir, { recursive: true });
    mkdirSync(join(stageCDir, 'overlay'), { recursive: true });
    writeFileSync(join(stageCDir, 'ZuleUI.exe'), 'binary');
    writeFileSync(join(stageCDir, 'dependency-lock.json'), '{}');
    writeFileSync(join(stageCDir, 'overlay', '.keep'), '');

    const result = validatePackageSet({ resourcesPath: tempDir });
    const manifestErrors = result.errors.filter(
      (e) => e.artifact === StageCArtefact.MANIFEST,
    );
    expect(manifestErrors).toHaveLength(1);
    expect(manifestErrors[0].code).toBe(PackageErrorCode.ARTIFACT_MISSING);
  });

  test('validatePackageSet detects missing dependency lock', () => {
    populateLayer0Assets(tempDir);
    const stageCDir = join(tempDir, 'stage-c');
    mkdirSync(stageCDir, { recursive: true });
    mkdirSync(join(stageCDir, 'overlay'), { recursive: true });
    writeFileSync(join(stageCDir, 'ZuleUI.exe'), 'binary');
    writeFileSync(join(stageCDir, 'manifest.json'), '{}');
    writeFileSync(join(stageCDir, 'overlay', '.keep'), '');

    const result = validatePackageSet({ resourcesPath: tempDir });
    const lockErrors = result.errors.filter(
      (e) => e.artifact === StageCArtefact.DEPENDENCY_LOCK,
    );
    expect(lockErrors).toHaveLength(1);
    expect(lockErrors[0].code).toBe(PackageErrorCode.ARTIFACT_MISSING);
  });

  test('validatePackageSet detects missing overlay directory', () => {
    populateLayer0Assets(tempDir);
    const stageCDir = join(tempDir, 'stage-c');
    mkdirSync(stageCDir, { recursive: true });
    writeFileSync(join(stageCDir, 'ZuleUI.exe'), 'binary');
    writeFileSync(join(stageCDir, 'manifest.json'), '{}');
    writeFileSync(join(stageCDir, 'dependency-lock.json'), '{}');
    // No overlay/ directory

    const result = validatePackageSet({ resourcesPath: tempDir });
    const overlayErrors = result.errors.filter(
      (e) => e.artifact === StageCArtefact.OVERLAY_RESOURCES,
    );
    expect(overlayErrors).toHaveLength(1);
    expect(overlayErrors[0].code).toBe(PackageErrorCode.ARTIFACT_MISSING);
  });

  test('validatePackageSet detects all missing artifacts when directory is empty', () => {
    populateLayer0Assets(tempDir);
    // Stage C directory doesn't exist at all

    const result = validatePackageSet({ resourcesPath: tempDir });
    const artifactErrors = result.errors.filter(
      (e) => e.code === PackageErrorCode.ARTIFACT_MISSING,
    );
    // Should detect all 4 Stage C artifacts as missing
    expect(artifactErrors.length).toBe(Object.values(StageCArtefact).length);
  });

  test('validatePackageSet returns RESOURCES_PATH_UNAVAILABLE when resources path is null', () => {
    const result = validatePackageSet({ resourcesPath: undefined as unknown as string });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe(PackageErrorCode.RESOURCES_PATH_UNAVAILABLE);
  });
});

describe('Stage C Packaging — Truthful Metadata Independence', () => {
  test('sidecar metadata uses Zule-owned values', () => {
    expect(SIDECAR_METADATA.originalFilename).toBe('ZuleUI.exe');
    expect(SIDECAR_METADATA.companyName).toBe('Zule AI');
    expect(SIDECAR_METADATA.productName).toBe('Zule AI');
    expect(SIDECAR_METADATA.internalName).toBe('ZuleUI');
  });

  test('sidecar metadata does not reference Electron, Chrome, or Microsoft', () => {
    for (const value of Object.values(SIDECAR_METADATA)) {
      expect(value.toLowerCase()).not.toContain('electron');
      expect(value.toLowerCase()).not.toContain('chrome');
      expect(value.toLowerCase()).not.toContain('microsoft');
      expect(value.toLowerCase()).not.toContain('edge');
    }
  });

  test('sidecar metadata values are stable and non-empty', () => {
    for (const value of Object.values(SIDECAR_METADATA)) {
      expect(value.length).toBeGreaterThan(0);
      expect(typeof value).toBe('string');
    }
  });
});
