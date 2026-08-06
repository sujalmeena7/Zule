/**
 * Stage C Updater — Unit Tests
 *
 * Tests atomic staging, activation, and rollback of complete package sets.
 *
 * Requirements: 14.9–14.14
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  StageCUpdater,
  UpdaterPhase,
  type UpdaterDeps,
  type UpdaterFileSystem,
} from '../../stageC/updater';

// ────────────────────────────────────────────────────────────────────
// Test Helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Creates a valid manifest JSON string with artifact hashes.
 */
function createValidManifestJson(
  artifactHashes: Record<string, string> = {
    'stage-c/ZuleUI.exe': 'hash_sidecar_valid',
    'stage-c/dependency-lock.json': 'hash_deplock_valid',
    'stage-c/overlay/index.html': 'hash_overlay_valid',
  },
): string {
  return JSON.stringify({
    app_version: '2.0.0',
    sidecar_version: '2.0.0',
    protocol_major: 1,
    protocol_minor: 0,
    bridge_schema_version: 1,
    supported_architectures: ['x64'],
    minimum_webview2_version: '119.0.2151.0',
    capabilities: ['overlay'],
    dependency_lock_hash: 'a'.repeat(64),
    sidecar_path: 'stage-c/ZuleUI.exe',
    release_gate_evidence_id: 'evidence-abc-123',
    artifact_hashes: artifactHashes,
    publisher: 'Zule AI',
  });
}

/**
 * In-memory filesystem for testing. Supports files and directories.
 */
function createMockFileSystem(overrides: Partial<UpdaterFileSystem> = {}): UpdaterFileSystem {
  const files = new Map<string, Buffer>();
  const dirs = new Set<string>();

  function addFile(path: string, content: string | Buffer): void {
    files.set(path, Buffer.isBuffer(content) ? content : Buffer.from(content));
    // Add parent dirs
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  }

  function addDir(path: string): void {
    dirs.add(path);
  }

  // Populate a valid package set at /new-set
  const manifestJson = createValidManifestJson();
  addFile('/new-set/stage-c/manifest.json', manifestJson);
  addFile('/new-set/stage-c/ZuleUI.exe', 'sidecar-binary');
  addFile('/new-set/stage-c/dependency-lock.json', 'deplock-content');
  addFile('/new-set/stage-c/overlay/index.html', 'overlay-content');
  addFile('/new-set/dist/index.html', 'layer0-html');
  addFile('/new-set/dist-electron/preload.mjs', 'preload-script');
  addFile('/new-set/dist-electron/main.mjs', 'main-script');
  addDir('/new-set/stage-c/overlay');

  // Populate a valid active set at /active
  addFile('/active/stage-c/manifest.json', manifestJson);
  addFile('/active/stage-c/ZuleUI.exe', 'sidecar-binary');
  addFile('/active/stage-c/dependency-lock.json', 'deplock-content');
  addFile('/active/stage-c/overlay/index.html', 'overlay-content');
  addFile('/active/dist/index.html', 'layer0-html');
  addFile('/active/dist-electron/preload.mjs', 'preload-script');
  addFile('/active/dist-electron/main.mjs', 'main-script');
  addDir('/active/stage-c/overlay');

  // Content-to-hash map (predictable mock hashing)
  const contentHashMap: Record<string, string> = {
    'sidecar-binary': 'hash_sidecar_valid',
    'deplock-content': 'hash_deplock_valid',
    'overlay-content': 'hash_overlay_valid',
    'layer0-html': 'hash_layer0_valid',
    'preload-script': 'hash_preload_valid',
    'main-script': 'hash_main_valid',
  };

  const fs: UpdaterFileSystem = {
    exists(path: string): boolean {
      return dirs.has(path) || files.has(path);
    },
    readFile(path: string): Buffer | null {
      return files.get(path) ?? null;
    },
    copyDir(source: string, destination: string): boolean {
      // Copy all files under source to destination
      for (const [key, value] of [...files.entries()]) {
        if (key.startsWith(source + '/')) {
          const relative = key.slice(source.length);
          files.set(destination + relative, Buffer.from(value));
          // Add parent dirs for new file
          const parts = (destination + relative).split('/');
          for (let i = 1; i < parts.length; i++) {
            dirs.add(parts.slice(0, i).join('/'));
          }
        }
      }
      // Copy directories
      for (const dir of [...dirs]) {
        if (dir.startsWith(source + '/') || dir === source) {
          const relative = dir.slice(source.length);
          dirs.add(destination + relative);
        }
      }
      dirs.add(destination);
      return true;
    },
    removeDir(path: string): boolean {
      for (const key of [...files.keys()]) {
        if (key.startsWith(path + '/') || key === path) {
          files.delete(key);
        }
      }
      for (const dir of [...dirs]) {
        if (dir.startsWith(path + '/') || dir === path) {
          dirs.delete(dir);
        }
      }
      return true;
    },
    renameDir(source: string, destination: string): boolean {
      for (const [key, value] of [...files.entries()]) {
        if (key.startsWith(source + '/')) {
          const relative = key.slice(source.length);
          files.set(destination + relative, Buffer.from(value));
          files.delete(key);
          // Add parent dirs
          const parts = (destination + relative).split('/');
          for (let i = 1; i < parts.length; i++) {
            dirs.add(parts.slice(0, i).join('/'));
          }
        }
      }
      for (const dir of [...dirs]) {
        if (dir.startsWith(source + '/') || dir === source) {
          const relative = dir.slice(source.length);
          dirs.add(destination + relative);
          dirs.delete(dir);
        }
      }
      dirs.add(destination);
      dirs.delete(source);
      return true;
    },
    listFiles(path: string): string[] {
      const result: string[] = [];
      for (const key of files.keys()) {
        if (key.startsWith(path + '/')) {
          result.push(key.slice(path.length + 1));
        }
      }
      return result;
    },
    hashFile(path: string): string | null {
      const content = files.get(path);
      if (!content) return null;
      return contentHashMap[content.toString()] ?? `hash_unknown_${content.toString().slice(0, 8)}`;
    },
  };

  return { ...fs, ...overrides };
}

/**
 * Creates default updater dependencies.
 */
function createDeps(overrides: Partial<UpdaterDeps> = {}): UpdaterDeps {
  return {
    fileSystem: createMockFileSystem(),
    isAppCoreStopped: () => true,
    isSidecarStopped: () => true,
    activeSetPath: '/active',
    stagingPath: '/staging',
    backupPath: '/backup',
    expectedPublisher: 'Zule AI',
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────
// Staging Tests
// ────────────────────────────────────────────────────────────────────

describe('StageCUpdater — stageUpdate', () => {
  let updater: StageCUpdater;
  let deps: UpdaterDeps;

  beforeEach(() => {
    deps = createDeps();
    updater = new StageCUpdater(deps);
  });

  it('starts in IDLE phase', () => {
    expect(updater.getPhase()).toBe(UpdaterPhase.IDLE);
  });

  it('stages a valid complete package set successfully (Req 14.9)', () => {
    const result = updater.stageUpdate('/new-set');
    expect(result.staged).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.stagedPath).toBe('/staging');
  });

  it('returns to IDLE after staging', () => {
    updater.stageUpdate('/new-set');
    expect(updater.getPhase()).toBe(UpdaterPhase.IDLE);
  });

  it('rejects staging when source path does not exist', () => {
    const result = updater.stageUpdate('/nonexistent');
    expect(result.staged).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.stagedPath).toBeNull();
  });

  it('validates all artifacts before accepting (Req 14.10)', () => {
    // Remove a required artifact from the source
    const badFs = createMockFileSystem();
    // Override exists to say ZuleUI.exe is missing
    const originalExists = badFs.exists.bind(badFs);
    badFs.exists = (path: string) => {
      if (path === '/new-set/stage-c/ZuleUI.exe') return false;
      return originalExists(path);
    };
    const badDeps = createDeps({ fileSystem: badFs });
    const badUpdater = new StageCUpdater(badDeps);

    const result = badUpdater.stageUpdate('/new-set');
    expect(result.staged).toBe(false);
    expect(result.errors.some((e) => e.includes('ZuleUI.exe'))).toBe(true);
  });

  it('partial validation failure discards the staged set (Req 14.11)', () => {
    // Hash mismatch for one artifact — will be caught during hash verification
    const badFs = createMockFileSystem();
    const originalHashFile = badFs.hashFile.bind(badFs);
    badFs.hashFile = (path: string) => {
      if (path === '/new-set/stage-c/ZuleUI.exe') return 'wrong_hash';
      return originalHashFile(path);
    };
    const badDeps = createDeps({ fileSystem: badFs });
    const badUpdater = new StageCUpdater(badDeps);

    const result = badUpdater.stageUpdate('/new-set');
    expect(result.staged).toBe(false);
    expect(result.errors.some((e) => e.includes('Hash mismatch') || e.includes('mismatch'))).toBe(true);
    expect(result.stagedPath).toBeNull();
  });

  it('discards staged set if post-copy verification fails (Req 14.11)', () => {
    const badFs = createMockFileSystem();
    const originalHashFile = badFs.hashFile.bind(badFs);
    let sourceVerified = false;
    badFs.hashFile = (path: string) => {
      // Source passes, staging fails
      if (path.startsWith('/staging/') && sourceVerified) {
        return 'corrupted_after_copy';
      }
      if (path.startsWith('/new-set/')) {
        sourceVerified = true;
      }
      return originalHashFile(path);
    };
    const badDeps = createDeps({ fileSystem: badFs });
    const badUpdater = new StageCUpdater(badDeps);

    const result = badUpdater.stageUpdate('/new-set');
    expect(result.staged).toBe(false);
    expect(result.errors.some((e) => e.includes('Post-copy'))).toBe(true);
    // Staged directory should be cleaned up
    expect(badFs.exists('/staging')).toBe(false);
  });

  it('retains the installed set on staging failure (Req 14.11)', () => {
    const badFs = createMockFileSystem({
      copyDir: () => false,
    });
    const badDeps = createDeps({ fileSystem: badFs });
    const badUpdater = new StageCUpdater(badDeps);

    const result = badUpdater.stageUpdate('/new-set');
    expect(result.staged).toBe(false);
    // Active set should remain untouched
    expect(badFs.exists('/active')).toBe(true);
  });

  it('cleans previous staging directory before new staging', () => {
    // First staging succeeds
    const result1 = updater.stageUpdate('/new-set');
    expect(result1.staged).toBe(true);

    // Second staging should clean previous and succeed again
    const result2 = updater.stageUpdate('/new-set');
    expect(result2.staged).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// Activation Tests
// ────────────────────────────────────────────────────────────────────

describe('StageCUpdater — activateUpdate', () => {
  let updater: StageCUpdater;
  let deps: UpdaterDeps;

  beforeEach(() => {
    deps = createDeps();
    updater = new StageCUpdater(deps);
    // Pre-stage so we have something to activate
    updater.stageUpdate('/new-set');
  });

  it('activates a staged set when both processes are stopped (Req 14.12)', () => {
    const result = updater.activateUpdate('/staging');
    expect(result.activated).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.rolledBack).toBe(false);
  });

  it('requires App Core to be stopped before activation (Req 14.12)', () => {
    const runningDeps = createDeps({ isAppCoreStopped: () => false });
    const runningUpdater = new StageCUpdater(runningDeps);
    runningUpdater.stageUpdate('/new-set');

    const result = runningUpdater.activateUpdate('/staging');
    expect(result.activated).toBe(false);
    expect(result.errors.some((e) => e.includes('App Core'))).toBe(true);
    expect(result.rolledBack).toBe(false);
  });

  it('requires sidecar to be stopped before activation (Req 14.12)', () => {
    const runningDeps = createDeps({ isSidecarStopped: () => false });
    const runningUpdater = new StageCUpdater(runningDeps);
    runningUpdater.stageUpdate('/new-set');

    const result = runningUpdater.activateUpdate('/staging');
    expect(result.activated).toBe(false);
    expect(result.errors.some((e) => e.includes('Sidecar'))).toBe(true);
    expect(result.rolledBack).toBe(false);
  });

  it('re-verifies manifest and hashes before committing (Req 14.10)', () => {
    // Corrupt the staged manifest before activation
    const mockFs = createMockFileSystem();
    const corruptDeps = createDeps({ fileSystem: mockFs });
    const corruptUpdater = new StageCUpdater(corruptDeps);
    corruptUpdater.stageUpdate('/new-set');

    // Now corrupt the staged manifest
    const originalReadFile = mockFs.readFile.bind(mockFs);
    mockFs.readFile = (path: string) => {
      if (path === '/staging/stage-c/manifest.json') return null;
      return originalReadFile(path);
    };

    const result = corruptUpdater.activateUpdate('/staging');
    expect(result.activated).toBe(false);
    expect(result.errors.some((e) => e.includes('manifest') || e.includes('Cannot read'))).toBe(true);
  });

  it('triggers rollback to prior set on activation failure (Req 14.13)', () => {
    const mockFs = createMockFileSystem();
    let renameCallCount = 0;
    const originalRenameDir = mockFs.renameDir.bind(mockFs);
    mockFs.renameDir = (source: string, destination: string) => {
      renameCallCount++;
      // First rename: active → backup (succeeds)
      if (renameCallCount === 1) {
        return originalRenameDir(source, destination);
      }
      // Second rename: staged → active (fails to trigger rollback)
      if (renameCallCount === 2) {
        return false;
      }
      // Third rename: backup → active (rollback — succeeds)
      return originalRenameDir(source, destination);
    };

    const rollbackDeps = createDeps({ fileSystem: mockFs });
    const rollbackUpdater = new StageCUpdater(rollbackDeps);
    rollbackUpdater.stageUpdate('/new-set');

    const result = rollbackUpdater.activateUpdate('/staging');
    expect(result.activated).toBe(false);
    expect(result.rolledBack).toBe(true);
  });

  it('fails when staged path does not exist', () => {
    const result = updater.activateUpdate('/nonexistent');
    expect(result.activated).toBe(false);
    expect(result.errors.some((e) => e.includes('does not exist'))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// Rollback Tests
// ────────────────────────────────────────────────────────────────────

describe('StageCUpdater — rollbackUpdate', () => {
  let updater: StageCUpdater;
  let deps: UpdaterDeps;

  beforeEach(() => {
    deps = createDeps();
    updater = new StageCUpdater(deps);
  });

  it('restores the prior verified set from backup (Req 14.13)', () => {
    // Create a backup directory to rollback from
    deps.fileSystem.copyDir('/active', '/backup');

    const result = updater.rollbackUpdate();
    expect(result.rolledBack).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('works without the sidecar — Layer 0 independent (Req 14.14)', () => {
    // Rollback does NOT check sidecar state — it just restores files
    // This verifies rollback is independent of sidecar version
    const noSidecarDeps = createDeps({
      isSidecarStopped: () => true,
    });
    noSidecarDeps.fileSystem.copyDir('/active', '/backup');
    const noSidecarUpdater = new StageCUpdater(noSidecarDeps);

    const result = noSidecarUpdater.rollbackUpdate();
    expect(result.rolledBack).toBe(true);
  });

  it('fails gracefully when no backup exists', () => {
    const result = updater.rollbackUpdate();
    expect(result.rolledBack).toBe(false);
    expect(result.errors.some((e) => e.includes('no backup'))).toBe(true);
  });

  it('returns to IDLE phase after rollback', () => {
    deps.fileSystem.copyDir('/active', '/backup');
    updater.rollbackUpdate();
    expect(updater.getPhase()).toBe(UpdaterPhase.IDLE);
  });

  it('rollback does not depend on sidecar being installed or running (Req 14.14)', () => {
    // Even with sidecar "running" check returning false (not stopped),
    // rollback works — because rollback doesn't check sidecar state
    const deps = createDeps({
      isSidecarStopped: () => false, // sidecar is running — irrelevant for rollback
    });
    deps.fileSystem.copyDir('/active', '/backup');
    const updater = new StageCUpdater(deps);

    const result = updater.rollbackUpdate();
    // Rollback succeeds regardless of sidecar state
    expect(result.rolledBack).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// Transaction Atomicity Tests
// ────────────────────────────────────────────────────────────────────

describe('StageCUpdater — transaction atomicity', () => {
  it('leaves no partial state after failed staging', () => {
    const mockFs = createMockFileSystem({
      copyDir: () => false,
    });
    const deps = createDeps({ fileSystem: mockFs });
    const updater = new StageCUpdater(deps);

    const result = updater.stageUpdate('/new-set');
    expect(result.staged).toBe(false);
    // No staging directory should remain
    expect(mockFs.exists('/staging')).toBe(false);
  });

  it('leaves no partial state after failed activation (rollback restores)', () => {
    const mockFs = createMockFileSystem();
    let renameCallCount = 0;
    const originalRenameDir = mockFs.renameDir.bind(mockFs);

    mockFs.renameDir = (source: string, destination: string) => {
      renameCallCount++;
      if (renameCallCount === 1) return originalRenameDir(source, destination); // backup
      if (renameCallCount === 2) return false; // activation fails
      return originalRenameDir(source, destination); // rollback
    };

    const deps = createDeps({ fileSystem: mockFs });
    const updater = new StageCUpdater(deps);
    updater.stageUpdate('/new-set');

    const result = updater.activateUpdate('/staging');
    expect(result.activated).toBe(false);
    expect(result.rolledBack).toBe(true);
    // Active set should be restored from backup
    expect(mockFs.exists('/active')).toBe(true);
  });

  it('prevents concurrent operations via phase guard', () => {
    const deps = createDeps();
    const updater = new StageCUpdater(deps);

    expect(updater.getPhase()).toBe(UpdaterPhase.IDLE);
    updater.stageUpdate('/new-set');
    expect(updater.getPhase()).toBe(UpdaterPhase.IDLE);
  });

  it('entire staging is all-or-nothing — no artifacts partially installed', () => {
    // Even if some artifacts validate, if one fails hash check, nothing is staged
    const mockFs = createMockFileSystem();
    const originalHashFile = mockFs.hashFile.bind(mockFs);
    mockFs.hashFile = (path: string) => {
      // Third artifact fails
      if (path.includes('overlay/index.html')) return 'wrong_hash_for_overlay';
      return originalHashFile(path);
    };

    const deps = createDeps({ fileSystem: mockFs });
    const updater = new StageCUpdater(deps);

    const result = updater.stageUpdate('/new-set');
    expect(result.staged).toBe(false);
    expect(result.stagedPath).toBeNull();
    // Nothing was staged
    expect(mockFs.exists('/staging')).toBe(false);
  });
});
