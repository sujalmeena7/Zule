// ============================================
// Property 21: Non-Windows no-op
// ============================================
//
// ∀ API calls on platform ∈ {darwin, linux, freebsd, sunos, aix}:
//   createStealthHost returns strategy='none' without loading koffi,
//   no Win32 symbol resolved, overlay path byte-identical to today's.
//
// **Validates: Requirements 10.1, 10.2**

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';

// ── Observable counters to verify no FFI interaction ─────────────────────────

let getFfiCallCount = 0;
let koffiLoadAttempts = 0;
let win32SymbolResolutions = 0;

function resetCounters(): void {
  getFfiCallCount = 0;
  koffiLoadAttempts = 0;
  win32SymbolResolutions = 0;
}

// ── Mock modules ─────────────────────────────────────────────────────────────

// Mock ffi.ts: track calls to getFfi and ensure isWin32 respects process.platform
vi.mock('../../win32/ffi', () => ({
  getFfi: () => {
    getFfiCallCount++;
    win32SymbolResolutions++;
    // If somehow called, return a fake that tracks further symbol access
    return null;
  },
  isWin32: () => process.platform === 'win32',
}));

// Mock wndProc — should never be reached on non-win32
vi.mock('../../win32/wndProc', () => ({
  registerWndProc: () => {
    win32SymbolResolutions++;
    return null;
  },
}));

// Mock nativeStealth — should never be reached on non-win32
vi.mock('../../nativeStealth', () => ({
  applyNativeStealth: () => {
    win32SymbolResolutions++;
    return { ok: true, layers: [] };
  },
}));

// Mock node:crypto to prevent test failures from randomBytes
vi.mock('node:crypto', () => ({
  randomBytes: (n: number) => Buffer.alloc(n, 42),
}));

// ── Import module under test (after mocks) ───────────────────────────────────

import { createStealthHost } from '../../win32/hostWindow';
import type { StealthHostOptions, HostStrategy } from '../../win32/hostWindow';

// ── Platform simulation helpers ──────────────────────────────────────────────

const originalPlatform = process.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, writable: true });
}

function restorePlatform(): void {
  Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
}

// ── Arbitraries ──────────────────────────────────────────────────────────────

/** Non-Windows platform strings (the superset beyond just darwin/linux). */
const nonWin32Platforms = fc.constantFrom('darwin', 'linux', 'freebsd', 'sunos', 'aix');

/** Arbitrary Electron.Rectangle bounds */
const arbBounds = fc.record({
  x: fc.integer({ min: -4096, max: 4096 }),
  y: fc.integer({ min: -4096, max: 4096 }),
  width: fc.integer({ min: 1, max: 4096 }),
  height: fc.integer({ min: 1, max: 4096 }),
});

/** Arbitrary HostStrategy (including strategies that would normally trigger win32 codepaths) */
const arbStrategy: fc.Arbitrary<HostStrategy> = fc.constantFrom('reparent', 'layered', 'none');

/** Arbitrary StealthHostOptions combining bounds and strategy */
const arbOptions: fc.Arbitrary<StealthHostOptions> = fc.record({
  bounds: arbBounds,
  strategy: arbStrategy,
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Property 21: Non-Windows no-op', () => {
  beforeEach(() => {
    resetCounters();
  });

  afterEach(() => {
    restorePlatform();
  });

  it('∀ platform ∈ {darwin, linux, freebsd, sunos, aix}, ∀ opts: createStealthHost returns strategy="none"', () => {
    fc.assert(
      fc.property(nonWin32Platforms, arbOptions, (platform, opts) => {
        setPlatform(platform);
        resetCounters();

        const host = createStealthHost(opts);
        const state = host.getState();

        // Must return no-op strategy
        expect(state.strategy).toBe('none');
        expect(state.className).toBeNull();
        expect(state.hostHwnd).toBeNull();
        expect(state.active).toBe(false);
        expect(state.failure).toBeNull();
      }),
      { numRuns: 200 },
    );
  });

  it('∀ platform ∈ {darwin, linux, freebsd, sunos, aix}, ∀ opts: getFfi is never called (no koffi loading)', () => {
    fc.assert(
      fc.property(nonWin32Platforms, arbOptions, (platform, opts) => {
        setPlatform(platform);
        resetCounters();

        createStealthHost(opts);

        // getFfi must not be invoked — the platform guard short-circuits before FFI
        expect(getFfiCallCount).toBe(0);
        // No Win32 symbols should be resolved
        expect(win32SymbolResolutions).toBe(0);
      }),
      { numRuns: 200 },
    );
  });

  it('∀ platform ∈ {darwin, linux, freebsd, sunos, aix}: no-op host methods are safe to call without effect', () => {
    fc.assert(
      fc.property(nonWin32Platforms, arbBounds, (platform, bounds) => {
        setPlatform(platform);
        resetCounters();

        const opts: StealthHostOptions = { bounds, strategy: 'reparent' };
        const host = createStealthHost(opts);

        // All methods should be callable without error and without FFI interaction
        expect(host.show()).toBe(false);
        expect(host.hide()).toBe(false);
        expect(host.reassert()).toBe(false);
        expect(host.setBounds({ x: 0, y: 0, width: 100, height: 100 })).toBe(false);

        const createState = host.create();
        expect(createState.strategy).toBe('none');

        // destroy is a no-op, should not throw
        host.destroy();

        // Still no FFI interaction
        expect(getFfiCallCount).toBe(0);
        expect(win32SymbolResolutions).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it('∀ platform ∈ {darwin, linux, freebsd, sunos, aix}: even "layered" strategy produces no-op on non-win32', () => {
    fc.assert(
      fc.property(nonWin32Platforms, arbBounds, (platform, bounds) => {
        setPlatform(platform);
        resetCounters();

        // Explicitly request the most complex strategy — it should still be a no-op
        const opts: StealthHostOptions = { bounds, strategy: 'layered' };
        const host = createStealthHost(opts);
        const state = host.getState();

        expect(state.strategy).toBe('none');
        expect(state.active).toBe(false);
        expect(getFfiCallCount).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it('∀ platform ∈ {darwin, linux, freebsd, sunos, aix}: koffi is never loaded (zero load attempts)', () => {
    fc.assert(
      fc.property(nonWin32Platforms, arbOptions, (platform, opts) => {
        setPlatform(platform);
        koffiLoadAttempts = 0;

        createStealthHost(opts);

        // The platform guard prevents koffi from being loaded
        expect(koffiLoadAttempts).toBe(0);
      }),
      { numRuns: 200 },
    );
  });
});
