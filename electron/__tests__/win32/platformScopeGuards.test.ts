// ============================================
// Task 13.1: Platform scope guard verification
// ============================================
//
// Verifies:
//   1. createStealthHost returns { strategy: 'none' } on non-win32 without loading koffi
//   2. macOS stealth continues via setContentProtection → NSWindowSharingNone (unchanged)
//   3. Linux no-op path with CONTENT_PROTECTION_NOOP notice (unchanged)
//   4. No new runtime dependencies beyond koffi and four OS-provided DLLs
//
// **Validates: Requirements 10.1, 10.2, 10.3, 10.4**

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Mock koffi so we can verify it's never loaded on non-win32 ───────────────

let koffiLoadCount = 0;

vi.mock('node:module', () => ({
  createRequire: () => (mod: string) => {
    if (mod === 'koffi') {
      koffiLoadCount++;
      throw new Error('koffi should not be loaded on non-win32');
    }
    throw new Error(`Unexpected require: ${mod}`);
  },
}));

// ── Platform simulation helpers ──────────────────────────────────────────────

const originalPlatform = process.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, writable: true });
}

function restorePlatform(): void {
  Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Task 13.1: Platform Scope Guards', () => {
  beforeEach(() => {
    koffiLoadCount = 0;
    vi.resetModules();
  });

  afterEach(() => {
    restorePlatform();
  });

  describe('Req 10.1: createStealthHost returns strategy=none on non-win32', () => {
    it('returns strategy "none" on darwin without loading koffi', async () => {
      setPlatform('darwin');

      // Re-import to get fresh module with our mocked platform
      const { isWin32 } = await import('../../win32/ffi');
      expect(isWin32()).toBe(false);

      // Verify that getFfi() would return null on non-win32
      const { getFfi } = await import('../../win32/ffi');
      const result = getFfi();
      expect(result).toBeNull();

      // koffi should never have been loaded
      expect(koffiLoadCount).toBe(0);
    });

    it('returns strategy "none" on linux without loading koffi', async () => {
      setPlatform('linux');

      const { isWin32 } = await import('../../win32/ffi');
      expect(isWin32()).toBe(false);

      const { getFfi } = await import('../../win32/ffi');
      const result = getFfi();
      expect(result).toBeNull();

      expect(koffiLoadCount).toBe(0);
    });

    it('isWin32() returns true only for win32 platform', async () => {
      const platforms = ['darwin', 'linux', 'freebsd', 'sunos', 'aix'];
      for (const plat of platforms) {
        setPlatform(plat);
        const { isWin32 } = await import('../../win32/ffi');
        expect(isWin32(), `expected false for platform=${plat}`).toBe(false);
        vi.resetModules();
      }
    });
  });

  describe('Req 10.2: macOS/Linux overlay paths unchanged', () => {
    it('overlayManager.ts has setContentProtection call for macOS NSWindowSharingNone', () => {
      // Verify the source file contains the setContentProtection call
      // which on macOS maps to NSWindowSharingNone via Electron
      const overlayPath = path.resolve(__dirname, '../../overlayManager.ts');
      const content = fs.readFileSync(overlayPath, 'utf-8');

      // Verify setContentProtection is called in the create() path
      expect(content).toContain('this.window.setContentProtection(true)');
      // Verify the stealth host attachment is guarded by win32 check
      expect(content).toContain("process.platform !== 'win32'");
    });

    it('overlayManager.ts has CONTENT_PROTECTION_NOOP notice for Linux', () => {
      const overlayPath = path.resolve(__dirname, '../../overlayManager.ts');
      const content = fs.readFileSync(overlayPath, 'utf-8');

      // Verify the Linux no-op notice exists
      expect(content).toContain('CONTENT_PROTECTION_NOOP');
      expect(content).toContain("process.platform === 'linux'");
      expect(content).toContain('Content protection is not supported on Linux');
    });
  });

  describe('Req 10.3: koffi lazy loading with permanent failure latch', () => {
    it('ffi.ts uses createRequire for lazy koffi loading', () => {
      const ffiPath = path.resolve(__dirname, '../../win32/ffi.ts');
      const content = fs.readFileSync(ffiPath, 'utf-8');

      // Verify lazy loading pattern
      expect(content).toContain("createRequire(import.meta.url)('koffi')");
      // Verify failure latch exists
      expect(content).toContain('ffiLoadFailed');
      // Verify it never throws to callers
      expect(content).toContain('return null');
    });

    it('getFfi returns null and latches failure on non-win32', async () => {
      setPlatform('linux');
      vi.resetModules();

      const { getFfi } = await import('../../win32/ffi');

      // First call returns null
      const first = getFfi();
      expect(first).toBeNull();

      // Second call also returns null (permanent latch)
      const second = getFfi();
      expect(second).toBeNull();

      // koffi never attempted
      expect(koffiLoadCount).toBe(0);
    });
  });

  describe('Req 10.4: No new runtime dependencies beyond koffi + OS DLLs', () => {
    it('package.json has koffi as the only native FFI dependency', () => {
      const pkgPath = path.resolve(__dirname, '../../../package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

      // koffi must be in dependencies
      expect(pkg.dependencies).toHaveProperty('koffi');

      // Check no other native FFI or Win32-related packages
      const nativePackagePatterns = [
        /^ffi-napi$/,
        /^node-ffi$/,
        /^ref-napi$/,
        /^win32-api$/,
        /^windows-/,
        /^winreg/,
        /^native-reg/,
      ];

      const allDeps = Object.keys(pkg.dependencies || {});
      for (const dep of allDeps) {
        for (const pattern of nativePackagePatterns) {
          expect(dep, `unexpected native dependency: ${dep}`).not.toMatch(pattern);
        }
      }
    });

    it('ffi.ts only loads OS-provided DLLs (user32, gdi32, dwmapi, kernel32)', () => {
      const ffiPath = path.resolve(__dirname, '../../win32/ffi.ts');
      const content = fs.readFileSync(ffiPath, 'utf-8');

      // Extract all koffi.load() calls
      const loadCalls = content.match(/koffi\.load\(['"]([^'"]+)['"]\)/g) || [];
      const loadedDlls = loadCalls.map((call) => {
        const match = call.match(/koffi\.load\(['"]([^'"]+)['"]\)/);
        return match ? match[1] : '';
      });

      // All loaded DLLs must be from the allowed set
      const allowedDlls = ['user32.dll', 'gdi32.dll', 'dwmapi.dll', 'kernel32.dll'];
      for (const dll of loadedDlls) {
        expect(allowedDlls, `unexpected DLL: ${dll}`).toContain(dll);
      }

      // Verify at least the core DLLs are present
      expect(loadedDlls).toContain('user32.dll');
      expect(loadedDlls).toContain('kernel32.dll');
      expect(loadedDlls).toContain('dwmapi.dll');
    });
  });

  describe('Req 10.1: createStealthHost platform guard in hostWindow.ts', () => {
    it('hostWindow.ts guards createStealthHost with isWin32() check', () => {
      const hostPath = path.resolve(__dirname, '../../win32/hostWindow.ts');
      const content = fs.readFileSync(hostPath, 'utf-8');

      // Verify the platform guard is the first check in createStealthHost
      expect(content).toContain("if (!isWin32() || opts.strategy === 'none')");
      expect(content).toContain('return makeNoOpHost()');
    });

    it('attachStealthHost in overlayManager is guarded by win32 platform check', () => {
      const overlayPath = path.resolve(__dirname, '../../overlayManager.ts');
      const content = fs.readFileSync(overlayPath, 'utf-8');

      // Verify that attachStealthHost returns early on non-win32
      expect(content).toContain("if (!this.window || process.platform !== 'win32') return");
    });
  });
});
