// ============================================
// Zule AI — Stage C Package-Set Consistency Property Test
// ============================================
//
// Property 19: Package-set consistency
// Feature: stealth-window-host
//
// **Validates: Requirements 14.1–14.15**
//
// For every package/update artifact set, Stage C is eligible only if
// App Core, sidecar, manifest, architecture, signatures, exact versions,
// protocol, and dependency hashes form one valid bound set and Layer 0
// assets are present.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import {
  StageCArtefact,
  validatePackageSet,
  validateArchitectureMatch,
  PackageErrorCode,
  type PackageValidationResult,
} from '../../stageC/packaging';

import {
  StageCUpdater,
  UpdaterPhase,
  type UpdaterDeps,
  type UpdaterFileSystem,
} from '../../stageC/updater';

import type { SupportedArchitecture } from '../../stageC/types';

// ────────────────────────────────────────────────────────────────────
// Types for Package Set Generation
// ────────────────────────────────────────────────────────────────────

type PackageSetKind =
  | 'complete'           // All artifacts, matching arch, valid hashes, Layer 0 present
  | 'partial_stage_c'    // Missing one or more Stage C artifacts
  | 'partial_layer_0'    // Missing one or more Layer 0 assets
  | 'architecture_mismatch' // Sidecar arch doesn't match App Core
  | 'unsigned'           // Missing or invalid signatures (production context)
  | 'indeterminate'      // Indeterminate signature trust level
  | 'no_resources_path'; // process.resourcesPath unavailable

interface GeneratedPackageSet {
  kind: PackageSetKind;
  /** Which Stage C artifacts are present */
  presentStageCArts: StageCArtefact[];
  /** Which Layer 0 assets are present */
  presentLayer0Keys: string[];
  /** Sidecar architectures declared */
  sidecarArchitectures: SupportedArchitecture[];
  /** App Core architecture */
  appCoreArch: string;
  /** Whether resourcesPath is valid */
  hasResourcesPath: boolean;
}

// ────────────────────────────────────────────────────────────────────
// Arbitraries
// ────────────────────────────────────────────────────────────────────

const ALL_STAGE_C_ARTIFACTS = Object.values(StageCArtefact);

const ALL_LAYER_0_KEYS = ['rendererHtml', 'preload', 'mainEntry'];

const supportedArchArb: fc.Arbitrary<SupportedArchitecture> = fc.constantFrom('x64', 'arm64');

const appCoreArchArb: fc.Arbitrary<string> = fc.constantFrom('x64', 'arm64', 'ia32', 'mips');

/** Generate a complete valid package set */
const completePackageSetArb: fc.Arbitrary<GeneratedPackageSet> = supportedArchArb.map(
  (arch) => ({
    kind: 'complete' as const,
    presentStageCArts: [...ALL_STAGE_C_ARTIFACTS],
    presentLayer0Keys: [...ALL_LAYER_0_KEYS],
    sidecarArchitectures: [arch],
    appCoreArch: arch,
    hasResourcesPath: true,
  }),
);

/** Generate a partial Stage C set (missing at least one artifact) */
const partialStageCArb: fc.Arbitrary<GeneratedPackageSet> = fc.tuple(
  fc.subarray(ALL_STAGE_C_ARTIFACTS, { minLength: 0, maxLength: ALL_STAGE_C_ARTIFACTS.length - 1 }),
  supportedArchArb,
).map(([arts, arch]) => ({
  kind: 'partial_stage_c' as const,
  presentStageCArts: arts,
  presentLayer0Keys: [...ALL_LAYER_0_KEYS],
  sidecarArchitectures: [arch],
  appCoreArch: arch,
  hasResourcesPath: true,
}));

/** Generate a partial Layer 0 set (missing at least one asset) */
const partialLayer0Arb: fc.Arbitrary<GeneratedPackageSet> = fc.tuple(
  fc.subarray(ALL_LAYER_0_KEYS, { minLength: 0, maxLength: ALL_LAYER_0_KEYS.length - 1 }),
  supportedArchArb,
).map(([keys, arch]) => ({
  kind: 'partial_layer_0' as const,
  presentStageCArts: [...ALL_STAGE_C_ARTIFACTS],
  presentLayer0Keys: keys,
  sidecarArchitectures: [arch],
  appCoreArch: arch,
  hasResourcesPath: true,
}));

/** Generate an architecture-mismatched set */
const archMismatchArb: fc.Arbitrary<GeneratedPackageSet> = fc.tuple(
  supportedArchArb,
  supportedArchArb,
).filter(([sidecar, appCore]) => sidecar !== appCore)
  .map(([sidecarArch, appCoreArch]) => ({
    kind: 'architecture_mismatch' as const,
    presentStageCArts: [...ALL_STAGE_C_ARTIFACTS],
    presentLayer0Keys: [...ALL_LAYER_0_KEYS],
    sidecarArchitectures: [sidecarArch],
    appCoreArch,
    hasResourcesPath: true,
  }));

/** Generate a set with unsupported App Core architecture */
const unsupportedArchArb: fc.Arbitrary<GeneratedPackageSet> = fc.constantFrom('ia32', 'mips')
  .map((arch) => ({
    kind: 'architecture_mismatch' as const,
    presentStageCArts: [...ALL_STAGE_C_ARTIFACTS],
    presentLayer0Keys: [...ALL_LAYER_0_KEYS],
    sidecarArchitectures: ['x64' as SupportedArchitecture],
    appCoreArch: arch,
    hasResourcesPath: true,
  }));

/** Generate a set with no resources path */
const noResourcesPathArb: fc.Arbitrary<GeneratedPackageSet> = supportedArchArb.map(
  (arch) => ({
    kind: 'no_resources_path' as const,
    presentStageCArts: [...ALL_STAGE_C_ARTIFACTS],
    presentLayer0Keys: [...ALL_LAYER_0_KEYS],
    sidecarArchitectures: [arch],
    appCoreArch: arch,
    hasResourcesPath: false,
  }),
);

/** Combined arbitrary for all invalid package set kinds */
const invalidPackageSetArb: fc.Arbitrary<GeneratedPackageSet> = fc.oneof(
  partialStageCArb,
  partialLayer0Arb,
  archMismatchArb,
  unsupportedArchArb,
  noResourcesPathArb,
);

// ────────────────────────────────────────────────────────────────────
// Updater Types for Property Test
// ────────────────────────────────────────────────────────────────────

type UpdateSetKind =
  | 'valid'           // Complete and valid update set
  | 'partial'         // Missing artifacts
  | 'hash_mismatch'   // Artifact hashes don't match manifest
  | 'invalid_manifest' // Manifest is unparseable or missing fields
  | 'wrong_publisher'; // Publisher doesn't match expected

interface GeneratedUpdateSet {
  kind: UpdateSetKind;
  /** Files and their content at the source path */
  files: Record<string, string>;
  /** Expected staging result */
  expectStaged: boolean;
}

// ────────────────────────────────────────────────────────────────────
// Test Helpers
// ────────────────────────────────────────────────────────────────────

function createTempDir(): string {
  const base = join(
    tmpdir(),
    `zule-pkg-prop-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(base, { recursive: true });
  return base;
}

const LAYER_0_PATHS: Record<string, string> = {
  rendererHtml: 'dist/index.html',
  preload: 'dist-electron/preload.mjs',
  mainEntry: 'dist-electron/main.mjs',
};

const STAGE_C_ARTIFACT_PATHS: Record<string, string> = {
  [StageCArtefact.SIDECAR_BINARY]: 'stage-c/ZuleUI.exe',
  [StageCArtefact.MANIFEST]: 'stage-c/manifest.json',
  [StageCArtefact.DEPENDENCY_LOCK]: 'stage-c/dependency-lock.json',
  [StageCArtefact.OVERLAY_RESOURCES]: 'stage-c/overlay',
};

/**
 * Materializes a generated package set as actual files on disk.
 */
function materializePackageSet(basePath: string, set: GeneratedPackageSet): void {
  // Create Stage C artifacts that are present
  for (const art of set.presentStageCArts) {
    const relPath = STAGE_C_ARTIFACT_PATHS[art];
    const fullPath = join(basePath, relPath);
    if (art === StageCArtefact.OVERLAY_RESOURCES) {
      mkdirSync(fullPath, { recursive: true });
      writeFileSync(join(fullPath, '.keep'), '');
    } else {
      mkdirSync(join(basePath, 'stage-c'), { recursive: true });
      writeFileSync(fullPath, `mock-${art}`);
    }
  }

  // Create Layer 0 assets that are present
  for (const key of set.presentLayer0Keys) {
    const relPath = LAYER_0_PATHS[key];
    const fullPath = join(basePath, relPath);
    const dir = fullPath.substring(0, fullPath.lastIndexOf('\\') > -1
      ? fullPath.lastIndexOf('\\') : fullPath.lastIndexOf('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, `mock-layer0-${key}`);
  }
}

/**
 * Determines if a generated package set should pass validatePackageSet.
 * Only complete sets with all artifacts AND all Layer 0 assets pass.
 */
function isCompleteSet(set: GeneratedPackageSet): boolean {
  if (!set.hasResourcesPath) return false;
  const hasAllStageC = ALL_STAGE_C_ARTIFACTS.every(
    (a) => set.presentStageCArts.includes(a),
  );
  const hasAllLayer0 = ALL_LAYER_0_KEYS.every(
    (k) => set.presentLayer0Keys.includes(k),
  );
  return hasAllStageC && hasAllLayer0;
}

/**
 * Determines if the architecture match should pass.
 */
function isArchitectureValid(set: GeneratedPackageSet): boolean {
  const supported = ['x64', 'arm64'];
  if (!supported.includes(set.appCoreArch)) return false;
  return set.sidecarArchitectures.includes(set.appCoreArch as SupportedArchitecture);
}

/**
 * Creates an in-memory filesystem for updater testing.
 */
function createInMemoryFS(
  fileMap: Map<string, Buffer>,
  dirSet: Set<string>,
): UpdaterFileSystem {
  // Content-based hashing for predictable test behavior
  function hashContent(content: Buffer): string {
    return createHash('sha256').update(content).digest('hex');
  }

  return {
    exists(path: string): boolean {
      return dirSet.has(path) || fileMap.has(path);
    },
    readFile(path: string): Buffer | null {
      return fileMap.get(path) ?? null;
    },
    copyDir(source: string, destination: string): boolean {
      for (const [key, value] of [...fileMap.entries()]) {
        if (key.startsWith(source + '/')) {
          const relative = key.slice(source.length);
          fileMap.set(destination + relative, Buffer.from(value));
        }
      }
      for (const dir of [...dirSet]) {
        if (dir.startsWith(source + '/') || dir === source) {
          dirSet.add(destination + dir.slice(source.length));
        }
      }
      dirSet.add(destination);
      return true;
    },

    removeDir(path: string): boolean {
      for (const key of [...fileMap.keys()]) {
        if (key.startsWith(path + '/') || key === path) {
          fileMap.delete(key);
        }
      }
      for (const dir of [...dirSet]) {
        if (dir.startsWith(path + '/') || dir === path) {
          dirSet.delete(dir);
        }
      }
      return true;
    },
    renameDir(source: string, destination: string): boolean {
      for (const [key, value] of [...fileMap.entries()]) {
        if (key.startsWith(source + '/') || key === source) {
          const newKey = destination + key.slice(source.length);
          fileMap.set(newKey, value);
          fileMap.delete(key);
        }
      }
      for (const dir of [...dirSet]) {
        if (dir.startsWith(source + '/') || dir === source) {
          dirSet.add(destination + dir.slice(source.length));
          dirSet.delete(dir);
        }
      }
      return true;
    },
    listFiles(path: string): string[] {
      return [...fileMap.keys()].filter((k) => k.startsWith(path + '/'));
    },
    hashFile(path: string): string | null {
      const content = fileMap.get(path);
      return content ? hashContent(content) : null;
    },
  };
}

/**
 * Populates an in-memory filesystem with a valid complete package set.
 * Returns the artifact hashes for manifest binding.
 */
function populateValidSet(
  fileMap: Map<string, Buffer>,
  dirSet: Set<string>,
  basePath: string,
): Record<string, string> {
  const artifacts: Record<string, string> = {};

  const files: [string, string][] = [
    ['stage-c/ZuleUI.exe', 'sidecar-binary-content'],
    ['stage-c/dependency-lock.json', '{"lockVersion":1}'],
    ['stage-c/overlay/index.html', '<html>overlay</html>'],
    ['dist/index.html', '<html>layer0</html>'],
    ['dist-electron/preload.mjs', 'export default {}'],
    ['dist-electron/main.mjs', 'export default {}'],
  ];

  for (const [rel, content] of files) {
    const fullPath = `${basePath}/${rel}`;
    const buf = Buffer.from(content);
    fileMap.set(fullPath, buf);
    // Track hashes for Stage C artifacts (for manifest binding)
    if (rel.startsWith('stage-c/') && rel !== 'stage-c/manifest.json') {
      artifacts[rel] = createHash('sha256').update(buf).digest('hex');
    }
    // Add parent dirs
    const parts = fullPath.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirSet.add(parts.slice(0, i).join('/'));
    }
  }

  dirSet.add(`${basePath}/stage-c/overlay`);
  dirSet.add(`${basePath}/stage-c`);
  dirSet.add(`${basePath}/dist`);
  dirSet.add(`${basePath}/dist-electron`);
  dirSet.add(basePath);

  return artifacts;
}

/**
 * Creates a valid manifest JSON for binding into an in-memory filesystem.
 */
function createManifestJson(
  artifactHashes: Record<string, string>,
  overrides: Partial<{
    publisher: string;
    app_version: string;
    sidecar_version: string;
    supported_architectures: SupportedArchitecture[];
    protocol_major: number;
    bridge_schema_version: number;
  }> = {},
): string {
  return JSON.stringify({
    app_version: overrides.app_version ?? '1.0.0',
    sidecar_version: overrides.sidecar_version ?? '1.0.0',
    protocol_major: overrides.protocol_major ?? 1,
    protocol_minor: 0,
    bridge_schema_version: overrides.bridge_schema_version ?? 1,
    supported_architectures: overrides.supported_architectures ?? ['x64'],
    minimum_webview2_version: '119.0.2151.0',
    capabilities: ['overlay'],
    dependency_lock_hash: 'a'.repeat(64),
    sidecar_path: 'stage-c/ZuleUI.exe',
    release_gate_evidence_id: 'evidence-123',
    artifact_hashes: artifactHashes,
    publisher: overrides.publisher ?? 'Zule AI',
  });
}

// ────────────────────────────────────────────────────────────────────
// Property Tests
// ────────────────────────────────────────────────────────────────────

describe('Property 19: Package-set consistency', () => {
  let tempDirs: string[] = [];

  beforeEach(() => {
    tempDirs = [];
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('validates only complete sets with all Stage C artifacts and Layer 0 assets (Req 14.1–14.2, 14.15, 18.1)', () => {
    fc.assert(
      fc.property(
        fc.oneof(completePackageSetArb, invalidPackageSetArb),
        (set) => {
          if (!set.hasResourcesPath) {
            // No resources path → must fail (Req 14.2)
            const result = validatePackageSet({ resourcesPath: undefined as unknown as string });
            expect(result.valid).toBe(false);
            expect(result.errors[0].code).toBe(PackageErrorCode.RESOURCES_PATH_UNAVAILABLE);
            return;
          }

          const tempDir = createTempDir();
          tempDirs.push(tempDir);
          materializePackageSet(tempDir, set);

          const result = validatePackageSet({ resourcesPath: tempDir });
          const complete = isCompleteSet(set);

          if (complete) {
            // Only a complete set passes validation (Req 14.1)
            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
          } else {
            // Any incomplete set must fail (Req 14.11)
            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it('rejects architecture mismatch — sidecar must match App Core (Req 14.3)', () => {
    fc.assert(
      fc.property(
        fc.oneof(archMismatchArb, unsupportedArchArb),
        (set) => {
          const result = validateArchitectureMatch(
            set.sidecarArchitectures,
            { arch: set.appCoreArch },
          );
          expect(result.valid).toBe(false);
          expect(result.errors.length).toBeGreaterThan(0);
          const codes = result.errors.map((e) => e.code);
          expect(
            codes.includes(PackageErrorCode.ARCHITECTURE_MISMATCH) ||
            codes.includes(PackageErrorCode.ARCHITECTURE_UNSUPPORTED),
          ).toBe(true);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('accepts matching architecture only (Req 14.3)', () => {
    fc.assert(
      fc.property(
        completePackageSetArb,
        (set) => {
          const result = validateArchitectureMatch(
            set.sidecarArchitectures,
            { arch: set.appCoreArch },
          );
          expect(result.valid).toBe(true);
          expect(result.errors).toHaveLength(0);
        },
      ),
      { numRuns: 20 },
    );
  });

  it('updater rejects partial/missing/mismatched sets — installed set stays active (Req 14.9–14.11)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<UpdateSetKind>('partial', 'hash_mismatch', 'invalid_manifest', 'wrong_publisher'),
        (defectKind) => {
          const fileMap = new Map<string, Buffer>();
          const dirSet = new Set<string>();

          // Populate a valid active set
          const activeHashes = populateValidSet(fileMap, dirSet, '/active');
          const activeManifest = createManifestJson(activeHashes);
          fileMap.set('/active/stage-c/manifest.json', Buffer.from(activeManifest));

          // Populate the new set path with defects
          if (defectKind === 'partial') {
            // Missing sidecar binary
            const partialHashes = populateValidSet(fileMap, dirSet, '/new-set');
            fileMap.delete('/new-set/stage-c/ZuleUI.exe');
            const manifest = createManifestJson(partialHashes);
            fileMap.set('/new-set/stage-c/manifest.json', Buffer.from(manifest));
          } else if (defectKind === 'hash_mismatch') {
            // Valid files but manifest declares wrong hashes
            populateValidSet(fileMap, dirSet, '/new-set');
            const badHashes: Record<string, string> = {
              'stage-c/ZuleUI.exe': 'wrong_hash_value',
              'stage-c/dependency-lock.json': 'wrong_hash_value',
            };
            const manifest = createManifestJson(badHashes);
            fileMap.set('/new-set/stage-c/manifest.json', Buffer.from(manifest));
          } else if (defectKind === 'invalid_manifest') {
            // Manifest is not valid JSON
            populateValidSet(fileMap, dirSet, '/new-set');
            fileMap.set('/new-set/stage-c/manifest.json', Buffer.from('not-json'));
          } else if (defectKind === 'wrong_publisher') {
            // Publisher doesn't match expected
            const hashes = populateValidSet(fileMap, dirSet, '/new-set');
            const manifest = createManifestJson(hashes, { publisher: 'Evil Corp' });
            fileMap.set('/new-set/stage-c/manifest.json', Buffer.from(manifest));
          }

          dirSet.add('/new-set');

          const fs = createInMemoryFS(fileMap, dirSet);

          const deps: UpdaterDeps = {
            fileSystem: fs,
            isAppCoreStopped: () => true,
            isSidecarStopped: () => true,
            activeSetPath: '/active',
            stagingPath: '/staging',
            backupPath: '/backup',
            expectedPublisher: 'Zule AI',
          };

          const updater = new StageCUpdater(deps);
          const result = updater.stageUpdate('/new-set');

          // Defective sets must NOT be staged (Req 14.11)
          expect(result.staged).toBe(false);
          expect(result.errors.length).toBeGreaterThan(0);
          // The installed active set must still be present
          expect(fs.exists('/active/stage-c/manifest.json')).toBe(true);
        },
      ),
      { numRuns: 20 },
    );
  });

  it('updater accepts valid complete set for staging (Req 14.9–14.10)', () => {
    fc.assert(
      fc.property(
        supportedArchArb,
        (arch) => {
          const fileMap = new Map<string, Buffer>();
          const dirSet = new Set<string>();

          // Populate a valid active set
          const activeHashes = populateValidSet(fileMap, dirSet, '/active');
          const activeManifest = createManifestJson(activeHashes);
          fileMap.set('/active/stage-c/manifest.json', Buffer.from(activeManifest));

          // Populate a valid new set
          const newHashes = populateValidSet(fileMap, dirSet, '/new-set');
          const newManifest = createManifestJson(newHashes, {
            supported_architectures: [arch],
          });
          fileMap.set('/new-set/stage-c/manifest.json', Buffer.from(newManifest));

          const fs = createInMemoryFS(fileMap, dirSet);
          const deps: UpdaterDeps = {
            fileSystem: fs,
            isAppCoreStopped: () => true,
            isSidecarStopped: () => true,
            activeSetPath: '/active',
            stagingPath: '/staging',
            backupPath: '/backup',
            expectedPublisher: 'Zule AI',
          };

          const updater = new StageCUpdater(deps);
          const result = updater.stageUpdate('/new-set');

          // Valid set must be staged successfully (Req 14.9)
          expect(result.staged).toBe(true);
          expect(result.errors).toHaveLength(0);
          expect(result.stagedPath).toBe('/staging');
        },
      ),
      { numRuns: 10 },
    );
  });

  it('activation requires both App Core and sidecar stopped (Req 14.12)', () => {
    fc.assert(
      fc.property(
        fc.record({
          appCoreStopped: fc.boolean(),
          sidecarStopped: fc.boolean(),
        }).filter((r) => !r.appCoreStopped || !r.sidecarStopped),
        ({ appCoreStopped, sidecarStopped }) => {
          const fileMap = new Map<string, Buffer>();
          const dirSet = new Set<string>();

          // Populate valid staged set
          const stagedHashes = populateValidSet(fileMap, dirSet, '/staging');
          const stagedManifest = createManifestJson(stagedHashes);
          fileMap.set('/staging/stage-c/manifest.json', Buffer.from(stagedManifest));

          // Populate active set
          const activeHashes = populateValidSet(fileMap, dirSet, '/active');
          const activeManifest = createManifestJson(activeHashes);
          fileMap.set('/active/stage-c/manifest.json', Buffer.from(activeManifest));

          const fs = createInMemoryFS(fileMap, dirSet);
          const deps: UpdaterDeps = {
            fileSystem: fs,
            isAppCoreStopped: () => appCoreStopped,
            isSidecarStopped: () => sidecarStopped,
            activeSetPath: '/active',
            stagingPath: '/staging',
            backupPath: '/backup',
            expectedPublisher: 'Zule AI',
          };

          const updater = new StageCUpdater(deps);
          const result = updater.activateUpdate('/staging');

          // If either is still running, activation must fail
          expect(result.activated).toBe(false);
          expect(result.errors.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 10 },
    );
  });

  it('rollback restores prior set without depending on sidecar (Req 14.13–14.14)', () => {
    fc.assert(
      fc.property(
        supportedArchArb,
        (arch) => {
          const fileMap = new Map<string, Buffer>();
          const dirSet = new Set<string>();

          // Populate only a backup set (simulating failed activation)
          const backupHashes = populateValidSet(fileMap, dirSet, '/backup');
          const backupManifest = createManifestJson(backupHashes, {
            supported_architectures: [arch],
          });
          fileMap.set('/backup/stage-c/manifest.json', Buffer.from(backupManifest));

          const fs = createInMemoryFS(fileMap, dirSet);
          const deps: UpdaterDeps = {
            fileSystem: fs,
            isAppCoreStopped: () => true,
            isSidecarStopped: () => true,
            activeSetPath: '/active',
            stagingPath: '/staging',
            backupPath: '/backup',
            expectedPublisher: 'Zule AI',
          };

          const updater = new StageCUpdater(deps);
          const result = updater.rollbackUpdate();

          // Rollback must succeed and restore backup to active
          expect(result.rolledBack).toBe(true);
          expect(fs.exists('/active/stage-c/manifest.json')).toBe(true);
          // Layer 0 assets must be restored (rollback independent of sidecar)
          expect(fs.exists('/active/dist/index.html')).toBe(true);
          expect(fs.exists('/active/dist-electron/preload.mjs')).toBe(true);
          expect(fs.exists('/active/dist-electron/main.mjs')).toBe(true);
        },
      ),
      { numRuns: 10 },
    );
  });

  it('eligibility requires exactly one valid bound set — invalid sets never pass (Req 14.1–14.15)', () => {
    // This is the core property: only a COMPLETE, VALID, MATCHING set
    // passes both package validation AND architecture check.
    fc.assert(
      fc.property(
        fc.oneof(
          { weight: 3, arbitrary: invalidPackageSetArb },
          { weight: 1, arbitrary: completePackageSetArb },
        ),
        (set) => {
          if (!set.hasResourcesPath) {
            const pkgResult = validatePackageSet({
              resourcesPath: undefined as unknown as string,
            });
            expect(pkgResult.valid).toBe(false);
            return;
          }

          const tempDir = createTempDir();
          tempDirs.push(tempDir);
          materializePackageSet(tempDir, set);

          const pkgResult = validatePackageSet({ resourcesPath: tempDir });
          const archResult = validateArchitectureMatch(
            set.sidecarArchitectures,
            { arch: set.appCoreArch },
          );

          const complete = isCompleteSet(set);
          const archValid = isArchitectureValid(set);

          // Stage C eligibility = package validation passes AND architecture matches
          const eligible = complete && archValid;

          if (eligible) {
            expect(pkgResult.valid).toBe(true);
            expect(archResult.valid).toBe(true);
          } else {
            // At least one of the two checks must fail
            expect(pkgResult.valid === false || archResult.valid === false).toBe(true);
          }
        },
      ),
      { numRuns: 80 },
    );
  });
});
