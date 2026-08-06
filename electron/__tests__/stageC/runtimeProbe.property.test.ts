// ============================================
// Zule AI — Runtime Probe Property-Based Tests
// ============================================
//
// Feature: stealth-window-host, Property 3: Probe failure has no launch side effect
//
// For every runtime-probe failure injection point, the sidecar spawn count
// remains zero, Layer 0 remains usable, and the reported reason identifies
// that point without content fields.
//
// **Validates: Requirements 4.3, 4.10**

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  runRuntimeProbe,
  RuntimeProbeConfig,
  SignatureResult,
} from '../../stageC/runtimeProbe';

import { ProbeFailureReason } from '../../stageC/types';

// --------------------------------------------------------------------
// Generators for failure-inducing RuntimeProbeConfig values
// --------------------------------------------------------------------

/** All valid ProbeFailureReason enum values (for assertion) */
const ALL_FAILURE_REASONS = Object.values(ProbeFailureReason);

/**
 * Generates a config that triggers NON_WINDOWS by using a non-win32 platform.
 */
const nonWindowsPlatformArb = fc.constantFrom('darwin', 'linux', 'freebsd', 'sunos', 'aix').map(
  (platform): RuntimeProbeConfig => ({
    platform,
    arch: 'x64',
    resourcesPath: '/fake/resources',
    deadlineMs: 3000,
  }),
);

/**
 * Generates a config that triggers UNSUPPORTED_ARCHITECTURE with an invalid arch.
 */
const unsupportedArchArb = fc.constantFrom('ia32', 'mips', 's390x', 'ppc64', 'riscv64').map(
  (arch): RuntimeProbeConfig => ({
    platform: 'win32',
    arch,
    resourcesPath: '/fake/resources',
    deadlineMs: 3000,
  }),
);

/**
 * Generates a config that triggers NATIVE_BOUNDARY_FAILURE when resourcesPath is undefined.
 */
const noBoundaryArb = fc.constant<RuntimeProbeConfig>({
  platform: 'win32',
  arch: 'x64',
  resourcesPath: undefined,
  deadlineMs: 3000,
});

/**
 * Generates a config that triggers MANIFEST_MISSING by pointing to a non-existent path.
 */
const missingManifestArb = fc.uuid().map(
  (id): RuntimeProbeConfig => ({
    platform: 'win32',
    arch: 'x64',
    resourcesPath: `/nonexistent-path-${id}`,
    isPackaged: false,
    deadlineMs: 3000,
  }),
);

/**
 * Generates a config that triggers DEADLINE_EXPIRED with a zero-ms deadline.
 * The deadline expires immediately after the platform/arch checks pass but
 * before any filesystem access can complete.
 */
const deadlineExpiredArb = fc.constant<RuntimeProbeConfig>({
  platform: 'win32',
  arch: 'x64',
  resourcesPath: '/nonexistent-deadline-path',
  isPackaged: false,
  deadlineMs: 0,
});

/**
 * Combined arbitrary that generates every possible probe failure config
 * without touching the filesystem for most cases.
 */
const failureConfigArb: fc.Arbitrary<RuntimeProbeConfig> = fc.oneof(
  { weight: 3, arbitrary: nonWindowsPlatformArb },
  { weight: 3, arbitrary: unsupportedArchArb },
  { weight: 2, arbitrary: noBoundaryArb },
  { weight: 3, arbitrary: missingManifestArb },
  { weight: 2, arbitrary: deadlineExpiredArb },
);

// --------------------------------------------------------------------
// Spawn counter — verifies zero process starts
// --------------------------------------------------------------------

/**
 * A simple spawn counter that tracks invocations.
 * The runtime probe uses injected queryWebView2 and verifySignature —
 * neither should spawn ZuleUI.exe. We verify that when the probe fails,
 * no signature or WebView2 query was even attempted (since failure
 * short-circuits before reaching those checks).
 */
function createSpawnCounter() {
  let webView2Calls = 0;
  let signatureCalls = 0;

  return {
    get totalCalls() {
      return webView2Calls + signatureCalls;
    },
    get webView2Calls() {
      return webView2Calls;
    },
    get signatureCalls() {
      return signatureCalls;
    },
    queryWebView2: (): string | null => {
      webView2Calls++;
      return '120.0.0.0';
    },
    verifySignature: (_path: string): SignatureResult => {
      signatureCalls++;
      return { valid: true, publisher: 'Zule AI', status: 'valid' as const };
    },
  };
}

// --------------------------------------------------------------------
// Property Test
// --------------------------------------------------------------------

describe('Stage C Runtime Probe — Property Tests', () => {
  // Feature: stealth-window-host, Property 3: Probe failure has no launch side effect
  describe('Property 3: Probe failure has no launch side effect', () => {
    it('every probe failure config produces eligible=false, a valid ProbeFailureReason, and zero spawn-count change', () => {
      fc.assert(
        fc.asyncProperty(failureConfigArb, async (config) => {
          // Attach spawn counter to detect any process-start attempts
          const counter = createSpawnCounter();
          const configWithCounter: RuntimeProbeConfig = {
            ...config,
            queryWebView2: counter.queryWebView2,
            verifySignature: counter.verifySignature,
          };

          // Run the probe — it must not throw
          const result = await runRuntimeProbe(configWithCounter);

          // **Validates: Requirements 4.10** — probe failure returns typed content-free reason
          expect(result.eligible).toBe(false);
          expect(result.reason).not.toBeNull();

          // Reason must be a valid enum member (content-free)
          expect(ALL_FAILURE_REASONS).toContain(result.reason);

          // **Validates: Requirements 4.3** — zero sidecar spawn count change
          // For early failures (non-Windows, bad arch, missing boundary, missing manifest,
          // deadline expired), the probe short-circuits before WebView2 or signature checks.
          // This confirms no process was started.
          expect(counter.totalCalls).toBe(0);
        }),
        { numRuns: 200 },
      );
    });

    it('probe never throws — always returns a clean RuntimeProbeResult', () => {
      fc.assert(
        fc.asyncProperty(failureConfigArb, async (config) => {
          // The probe must never throw an unhandled exception
          const result = await runRuntimeProbe(config);

          // Result is always a well-formed object
          expect(result).toHaveProperty('eligible');
          expect(result).toHaveProperty('reason');
          expect(typeof result.eligible).toBe('boolean');

          // When not eligible, reason must be non-null and typed
          if (!result.eligible) {
            expect(result.reason).not.toBeNull();
            expect(ALL_FAILURE_REASONS).toContain(result.reason);
          }
        }),
        { numRuns: 200 },
      );
    });

    it('deadline of 0ms always results in failure without hanging', () => {
      fc.assert(
        fc.asyncProperty(
          // Generate various architectures and resource paths with 0ms deadline
          fc.record({
            arch: fc.constantFrom('x64', 'arm64'),
            resourcesPath: fc.oneof(
              fc.constant('/fake/path'),
              fc.constant(undefined as unknown as string),
            ),
          }),
          async ({ arch, resourcesPath }) => {
            const config: RuntimeProbeConfig = {
              platform: 'win32',
              arch,
              resourcesPath,
              isPackaged: false,
              deadlineMs: 0,
            };

            const counter = createSpawnCounter();
            config.queryWebView2 = counter.queryWebView2;
            config.verifySignature = counter.verifySignature;

            const result = await runRuntimeProbe(config);

            // Must return a failure, not hang
            expect(result.eligible).toBe(false);
            expect(result.reason).not.toBeNull();
            expect(ALL_FAILURE_REASONS).toContain(result.reason);

            // Zero spawn attempts
            expect(counter.totalCalls).toBe(0);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('reason values are content-free: they contain no user paths, secrets, or payloads', () => {
      fc.assert(
        fc.asyncProperty(failureConfigArb, async (config) => {
          const result = await runRuntimeProbe(config);

          if (result.reason !== null) {
            // Content-free: reason is a short UPPER_SNAKE_CASE string
            // It must not contain paths, JSON, stack traces, or user data
            expect(result.reason).toMatch(/^[A-Z][A-Z0-9_]+$/);
            // Must not exceed reasonable enum identifier length
            expect(result.reason.length).toBeLessThanOrEqual(50);
            // Must not embed resourcesPath or other config data
            if (config.resourcesPath) {
              expect(result.reason).not.toContain(config.resourcesPath);
            }
          }
        }),
        { numRuns: 200 },
      );
    });
  });
});
