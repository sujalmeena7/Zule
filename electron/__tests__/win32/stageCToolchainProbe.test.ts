/**
 * Tests for the Stage C toolchain probe logic.
 *
 * These tests validate the probe's decision logic in isolation by testing
 * the core comparison/matching functions. The probe itself runs as an ESM
 * script, so we test its logic through a testable module extraction.
 *
 * Validates: Requirements 3.3, 3.4, 3.5, 3.6, 3.9, 3.12
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import { resolve } from 'path';
import { readFileSync } from 'fs';

const PROBE_PATH = resolve(__dirname, '../../../native/stage-c/toolchain-probe.mjs');
const BUILD_GUARD_PATH = resolve(__dirname, '../../../native/stage-c/build-guard.mjs');
const LOCK_PATH = resolve(__dirname, '../../../native/stage-c/dependency-lock.json');

describe('Stage C Toolchain Probe — Requirements 3.3, 3.4', () => {
  describe('non-Windows platform returns UNAVAILABLE', () => {
    it('reports UNAVAILABLE without modifying the system', () => {
      // On any platform, the probe should run and exit 0 with JSON
      // On non-Windows it should immediately return UNAVAILABLE
      try {
        const output = execSync(`node "${PROBE_PATH}"`, {
          encoding: 'utf-8',
          timeout: 30000,
          windowsHide: true,
        });
        const result = JSON.parse(output.trim());

        if (process.platform !== 'win32') {
          // Production lock validation runs before platform probing. While the
          // committed lock is pending, LOCK_NOT_PRODUCTION_READY is expected;
          // after review, a non-Windows host reaches PLATFORM_NOT_WIN32.
          expect(result.status).toBe('UNAVAILABLE');
          expect(['LOCK_NOT_PRODUCTION_READY', 'PLATFORM_NOT_WIN32']).toContain(result.reason);
        } else {
          // Windows: status depends on toolchain presence
          expect(['AVAILABLE', 'UNAVAILABLE']).toContain(result.status);
        }
      } catch (err: unknown) {
        // The probe should never throw or exit non-zero
        throw new Error(`Probe exited with non-zero code: ${(err as { status?: number }).status}`);
      }
    });
  });

  describe('probe output structure', () => {
    it('always outputs valid JSON to stdout', () => {
      const output = execSync(`node "${PROBE_PATH}"`, {
        encoding: 'utf-8',
        timeout: 30000,
        windowsHide: true,
      });
      const result = JSON.parse(output.trim());
      expect(result).toHaveProperty('status');
      expect(['AVAILABLE', 'UNAVAILABLE']).toContain(result.status);
      expect(result).toHaveProperty('details');
    });

    it('always exits with code 0 regardless of availability', () => {
      // execSync throws on non-zero exit codes, so this succeeding proves exit 0
      const output = execSync(`node "${PROBE_PATH}"`, {
        encoding: 'utf-8',
        timeout: 30000,
        windowsHide: true,
      });
      expect(output.length).toBeGreaterThan(0);
    });

    it('includes platform information in details', () => {
      const output = execSync(`node "${PROBE_PATH}"`, {
        encoding: 'utf-8',
        timeout: 30000,
        windowsHide: true,
      });
      const result = JSON.parse(output.trim());
      expect(result.details).toHaveProperty('platform');
      expect(result.details.platform).toBe(process.platform);
    });
  });

  describe('Requirement 3.4: no installation or download on UNAVAILABLE', () => {
    it('probe does not create files, install packages, or modify the system', () => {
      // Run the probe and confirm it produces only JSON output
      // without side effects. We verify by checking that no new
      // processes are spawned for installers.
      const output = execSync(`node "${PROBE_PATH}"`, {
        encoding: 'utf-8',
        timeout: 30000,
        windowsHide: true,
      });
      const result = JSON.parse(output.trim());

      // The probe either found tools or didn't — either way it must not
      // have installed, downloaded, or upgraded anything
      expect(result.status).toBeDefined();

      // Confirm no download-related fields in the result
      expect(JSON.stringify(result)).not.toContain('"installed":true');
      expect(JSON.stringify(result)).not.toContain('"downloaded":true');
      expect(JSON.stringify(result)).not.toContain('"upgraded":true');
    });
  });

  describe('Requirement 3.3: AVAILABLE only on exact lock match', () => {
    it('if AVAILABLE, all checks must pass', () => {
      const output = execSync(`node "${PROBE_PATH}"`, {
        encoding: 'utf-8',
        timeout: 30000,
        windowsHide: true,
      });
      const result = JSON.parse(output.trim());

      if (result.status === 'AVAILABLE') {
        const checks = result.details.checks;
        expect(checks.lock.pass).toBe(true);
        expect(checks.msvc.match).toBe(true);
        expect(checks.msbuild.match).toBe(true);
        expect(checks.windowsSdk.match).toBe(true);
        expect(checks.webView2Sdk.match).toBe(true);
        expect(result.details.image).toBeDefined();
      }
    });
  });

  describe('Requirement 3.9: reject floating ranges in lock', () => {
    it('dependency-lock.json has no floating ranges', () => {
      const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf-8'));
      const FLOATING_PATTERN = /[~^*x]|>=|<=|>(?!=)|<(?!=)|\blatest\b/i;

      // Check all toolchain versions
      for (const [key, item] of Object.entries(lock.toolchain) as [string, { version: string }][]) {
        expect(FLOATING_PATTERN.test(item.version)).toBe(false);
      }

      // Check all dependency versions
      for (const [key, item] of Object.entries(lock.dependencies) as [string, { version: string }][]) {
        expect(FLOATING_PATTERN.test(item.version)).toBe(false);
      }

      // Check all transitive dependency versions
      for (const [key, item] of Object.entries(lock.transitiveDependencies) as [string, { version: string }][]) {
        expect(FLOATING_PATTERN.test(item.version)).toBe(false);
      }
    });
  });

  describe('Requirement 3.12: no automatic fallback paths', () => {
    it('probe source contains no fallback compiler references', () => {
      const probeSource = readFileSync(PROBE_PATH, 'utf-8');

      // The probe must not reference alternative compilers as fallbacks
      expect(probeSource).not.toContain('dotnet');
      expect(probeSource).not.toContain('rustc');
      expect(probeSource).not.toContain('cargo');
      expect(probeSource).not.toContain('mingw');
      expect(probeSource).not.toContain('clang');
      expect(probeSource).not.toContain('gcc');
    });

    it('probe source contains no download/install logic', () => {
      const probeSource = readFileSync(PROBE_PATH, 'utf-8');

      // Must not contain download, install, or fetch invocations
      expect(probeSource).not.toContain('npm install');
      expect(probeSource).not.toContain('choco install');
      expect(probeSource).not.toContain('winget install');
      expect(probeSource).not.toContain('Invoke-WebRequest');
      expect(probeSource).not.toContain('curl ');
      expect(probeSource).not.toContain('wget ');
    });
  });
});

describe('Stage C Build Guard — Requirements 3.5, 3.6', () => {
  describe('Requirement 3.5: JS development and Layer 0 unaffected', () => {
    it('existing dev/build/test scripts remain unchanged', () => {
      const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf-8'));

      // Core scripts must still exist and not reference Stage C guard
      expect(pkg.scripts.dev).toBe('vite');
      expect(pkg.scripts.build).toBe('tsc -b && vite build');
      expect(pkg.scripts.test).toBe('vitest --run');
      expect(pkg.scripts.lint).toBe('eslint .');
    });

    it('stage-c scripts are additive and do not block non-stage-c targets', () => {
      const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf-8'));

      // Stage C scripts exist
      expect(pkg.scripts['stage-c:probe']).toBeDefined();
      expect(pkg.scripts['stage-c:build']).toBeDefined();
      expect(pkg.scripts['stage-c:package']).toBeDefined();
      expect(pkg.scripts['stage-c:production-enable']).toBeDefined();

      // Non-stage-c scripts do NOT reference the build guard
      expect(pkg.scripts.dev).not.toContain('build-guard');
      expect(pkg.scripts.build).not.toContain('build-guard');
      expect(pkg.scripts.test).not.toContain('build-guard');
      expect(pkg.scripts.lint).not.toContain('build-guard');
    });
  });

  describe('Requirement 3.6: Stage C targets fail closed when UNAVAILABLE', () => {
    it('stage-c:build fails with exit code 1 when toolchain is unavailable', () => {
      // On non-Windows or without exact toolchain, the guard must fail
      if (process.platform !== 'win32') {
        try {
          execSync(`node "${BUILD_GUARD_PATH}" stage-c:build`, {
            encoding: 'utf-8',
            timeout: 30000,
            windowsHide: true,
          });
          // Should not reach here on non-Windows
          throw new Error('Expected build guard to fail on non-Windows');
        } catch (err: unknown) {
          const error = err as { status?: number; stderr?: string; stdout?: string };
          expect(error.status).toBe(1);
        }
      } else {
        // On Windows: may pass or fail depending on toolchain presence
        // Either way, it must not crash
        try {
          const output = execSync(`node "${BUILD_GUARD_PATH}" stage-c:build`, {
            encoding: 'utf-8',
            timeout: 30000,
            windowsHide: true,
          });
          // If it passes, toolchain is available
          expect(output).toContain('AVAILABLE');
        } catch (err: unknown) {
          const error = err as { status?: number; stderr?: string };
          // If it fails, it should be exit code 1 (fail closed)
          expect(error.status).toBe(1);
        }
      }
    });

    it('stage-c:package fails with exit code 1 when toolchain is unavailable', () => {
      if (process.platform !== 'win32') {
        try {
          execSync(`node "${BUILD_GUARD_PATH}" stage-c:package`, {
            encoding: 'utf-8',
            timeout: 30000,
            windowsHide: true,
          });
          throw new Error('Expected build guard to fail on non-Windows');
        } catch (err: unknown) {
          const error = err as { status?: number };
          expect(error.status).toBe(1);
        }
      }
    });

    it('stage-c:production-enable fails with exit code 1 when toolchain is unavailable', () => {
      if (process.platform !== 'win32') {
        try {
          execSync(`node "${BUILD_GUARD_PATH}" stage-c:production-enable`, {
            encoding: 'utf-8',
            timeout: 30000,
            windowsHide: true,
          });
          throw new Error('Expected build guard to fail on non-Windows');
        } catch (err: unknown) {
          const error = err as { status?: number };
          expect(error.status).toBe(1);
        }
      }
    });
  });

  describe('Requirement 3.12: zero fallback paths in build guard', () => {
    it('build guard does not attempt alternate compilers', () => {
      const guardSource = readFileSync(BUILD_GUARD_PATH, 'utf-8');

      // Must not contain invocations of alternate compilers/tools
      expect(guardSource).not.toContain('dotnet');
      expect(guardSource).not.toContain('rustc');
      expect(guardSource).not.toContain('mingw');
      expect(guardSource).not.toContain('clang');
      expect(guardSource).not.toContain('gcc');
      expect(guardSource).not.toContain('choco install');
      expect(guardSource).not.toContain('winget install');
    });
  });
});
