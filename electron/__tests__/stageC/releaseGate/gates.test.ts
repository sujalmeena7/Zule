/**
 * Stage C Release Gate — Gate Harness Unit Tests.
 *
 * Tests the five automated gate modules (metadata, scope-honesty,
 * runtime-probe, startup, transparency) with mock inputs to verify
 * correct pass/fail evidence generation.
 *
 * Requirements: 17.4–17.8
 */

import { describe, it, expect } from 'vitest';

import { ReleaseGateId, type EnvironmentMatrixRow } from '../../../stageC/releaseGate/types';

import {
  executeMetadataGate,
  validateWindowIdentity,
  validateColdLaunch,
  EXPECTED_CLASS_NAME,
  EXPECTED_IMAGE_NAME,
  EXPECTED_ORIGINAL_FILENAME,
  EXPECTED_COMPANY_NAME,
  EXPECTED_PRODUCT_NAME,
} from '../../../stageC/releaseGate/gates/metadataGate';

import {
  executeScopeHonestyGate,
  validateObservability,
  validateClaimScan,
} from '../../../stageC/releaseGate/gates/scopeHonestyGate';

import {
  executeRuntimeProbeGate,
  validateColdProbe,
  PROBE_SUCCESS_DEADLINE_MS,
} from '../../../stageC/releaseGate/gates/runtimeProbeGate';

import {
  executeStartupGate,
  validateMilestoneOrdering,
  validateColdStartup,
  computeP95,
  STARTUP_DEADLINE_MS,
  STARTUP_P95_MS,
} from '../../../stageC/releaseGate/gates/startupGate';

import {
  executeTransparencyGate,
  validateTransparencyAnalysis,
} from '../../../stageC/releaseGate/gates/transparencyGate';

import type {
  GateBuildContext,
  WindowIdentity,
  ColdLaunchResult,
  ObservabilityReport,
  ClaimScanResult,
  ColdProbeResult,
  ColdStartupResult,
  StartupMilestones,
  TransparencyAnalysis,
} from '../../../stageC/releaseGate/gates/types';

// ────────────────────────────────────────────────────────────────────
// Test Fixtures
// ────────────────────────────────────────────────────────────────────

const TEST_ENV: EnvironmentMatrixRow = {
  osBuild: 'win10_22h2',
  architecture: 'x64',
  webView2Version: '119.0.2151.0',
};

const TEST_BUILD_CONTEXT: GateBuildContext = {
  buildHash: 'a'.repeat(64),
  appVersion: '1.0.0',
  sidecarVersion: '1.0.0',
};

function makeValidWindow(isFloatingSurface: boolean): WindowIdentity {
  return {
    className: EXPECTED_CLASS_NAME,
    title: isFloatingSurface ? '' : 'Zule Overlay',
    imageName: EXPECTED_IMAGE_NAME,
    originalFilename: EXPECTED_ORIGINAL_FILENAME,
    companyName: EXPECTED_COMPANY_NAME,
    productName: EXPECTED_PRODUCT_NAME,
    isFloatingSurface,
  };
}

function makeValidColdLaunch(): ColdLaunchResult {
  return {
    windows: [makeValidWindow(true)],
    chromeWidgetWinOverlayCount: 0,
  };
}

function makeValidObservability(): ObservabilityReport {
  return {
    dashboardObservable: true,
    processObservable: true,
    moduleObservable: true,
    childWindowObservable: true,
    webView2Observable: true,
  };
}

function makeCleanClaimScan(): ClaimScanResult {
  return {
    undetectabilityClaims: 0,
    evasionClaims: 0,
    captureImpossibilityClaims: 0,
    impersonationClaims: 0,
  };
}

function makeValidStartupMilestones(): StartupMilestones {
  return {
    authenticationAt: 100,
    readyHandshakeAt: 200,
    snapshotAckAt: 300,
    firstFrameAt: 400,
    totalDurationMs: 400,
  };
}

function makeValidStartupResult(): ColdStartupResult {
  return {
    success: true,
    milestones: makeValidStartupMilestones(),
    durationMs: 400,
  };
}

// ────────────────────────────────────────────────────────────────────
// Metadata Gate Tests (Req 17.4)
// ────────────────────────────────────────────────────────────────────

describe('Metadata Gate', () => {
  describe('validateWindowIdentity', () => {
    it('returns no violations for a valid window', () => {
      const win = makeValidWindow(false);
      expect(validateWindowIdentity(win)).toEqual([]);
    });

    it('returns no violations for a valid Floating_Surface window', () => {
      const win = makeValidWindow(true);
      expect(validateWindowIdentity(win)).toEqual([]);
    });

    it('reports violation for wrong class name', () => {
      const win = { ...makeValidWindow(false), className: 'WrongClass' };
      const violations = validateWindowIdentity(win);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]).toContain('WrongClass');
    });

    it('reports violation for wrong image name', () => {
      const win = { ...makeValidWindow(false), imageName: 'Other.exe' };
      const violations = validateWindowIdentity(win);
      expect(violations.some((v) => v.includes('Other.exe'))).toBe(true);
    });

    it('reports violation for blank title on non-Floating_Surface', () => {
      const win = { ...makeValidWindow(false), title: '' };
      const violations = validateWindowIdentity(win);
      expect(violations.some((v) => v.includes('blank title'))).toBe(true);
    });

    it('reports violation for non-empty title on Floating_Surface', () => {
      const win = { ...makeValidWindow(true), title: 'Unexpected Title' };
      const violations = validateWindowIdentity(win);
      expect(violations.some((v) => v.includes('non-empty title'))).toBe(true);
    });
  });

  describe('validateColdLaunch', () => {
    it('returns no violations for zero Chrome_WidgetWin overlays', () => {
      const result = makeValidColdLaunch();
      expect(validateColdLaunch(result)).toEqual([]);
    });

    it('reports violation when Chrome_WidgetWin overlays are present', () => {
      const result: ColdLaunchResult = {
        windows: [makeValidWindow(true)],
        chromeWidgetWinOverlayCount: 2,
      };
      const violations = validateColdLaunch(result);
      expect(violations.some((v) => v.includes('Chrome_WidgetWin'))).toBe(true);
    });
  });

  describe('executeMetadataGate', () => {
    it('returns pass verdict when all launches are valid', async () => {
      const deps = {
        coldLaunch: async () => makeValidColdLaunch(),
      };
      const result = await executeMetadataGate(TEST_ENV, TEST_BUILD_CONTEXT, deps);
      expect(result.verdict).toBe('pass');
      expect(result.gateId).toBe(ReleaseGateId.METADATA);
    });

    it('returns fail verdict when window has wrong class name', async () => {
      const deps = {
        coldLaunch: async (): Promise<ColdLaunchResult> => ({
          windows: [{ ...makeValidWindow(false), className: 'BadClass' }],
          chromeWidgetWinOverlayCount: 0,
        }),
      };
      const result = await executeMetadataGate(TEST_ENV, TEST_BUILD_CONTEXT, deps);
      expect(result.verdict).toBe('fail');
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// Scope-Honesty Gate Tests (Req 17.5)
// ────────────────────────────────────────────────────────────────────

describe('Scope-Honesty Gate', () => {
  describe('validateObservability', () => {
    it('returns no violations when all components are observable', () => {
      expect(validateObservability(makeValidObservability())).toEqual([]);
    });

    it('reports violation when dashboard is not observable', () => {
      const report = { ...makeValidObservability(), dashboardObservable: false };
      const violations = validateObservability(report);
      expect(violations.some((v) => v.includes('Dashboard'))).toBe(true);
    });

    it('reports violation when process tree is not observable', () => {
      const report = { ...makeValidObservability(), processObservable: false };
      const violations = validateObservability(report);
      expect(violations.some((v) => v.includes('Process'))).toBe(true);
    });

    it('reports multiple violations when several components are not observable', () => {
      const report: ObservabilityReport = {
        dashboardObservable: false,
        processObservable: false,
        moduleObservable: false,
        childWindowObservable: true,
        webView2Observable: true,
      };
      const violations = validateObservability(report);
      expect(violations.length).toBe(3);
    });
  });

  describe('validateClaimScan', () => {
    it('returns no violations for a clean scan', () => {
      expect(validateClaimScan(makeCleanClaimScan())).toEqual([]);
    });

    it('reports violation for undetectability claims', () => {
      const scan = { ...makeCleanClaimScan(), undetectabilityClaims: 1 };
      const violations = validateClaimScan(scan);
      expect(violations.some((v) => v.includes('undetectability'))).toBe(true);
    });

    it('reports violation for evasion claims', () => {
      const scan = { ...makeCleanClaimScan(), evasionClaims: 2 };
      const violations = validateClaimScan(scan);
      expect(violations.some((v) => v.includes('evasion'))).toBe(true);
    });

    it('reports violations for multiple claim types', () => {
      const scan: ClaimScanResult = {
        undetectabilityClaims: 1,
        evasionClaims: 1,
        captureImpossibilityClaims: 1,
        impersonationClaims: 1,
      };
      const violations = validateClaimScan(scan);
      expect(violations.length).toBe(4);
    });
  });

  describe('executeScopeHonestyGate', () => {
    it('returns pass verdict when observability is full and claims are clean', async () => {
      const deps = {
        verifyObservability: async () => makeValidObservability(),
        scanReleaseMaterial: async () => makeCleanClaimScan(),
      };
      const result = await executeScopeHonestyGate(TEST_ENV, TEST_BUILD_CONTEXT, deps);
      expect(result.verdict).toBe('pass');
      expect(result.gateId).toBe(ReleaseGateId.SCOPE_HONESTY);
    });

    it('returns fail verdict when observability fails', async () => {
      const deps = {
        verifyObservability: async (): Promise<ObservabilityReport> => ({
          ...makeValidObservability(),
          dashboardObservable: false,
        }),
        scanReleaseMaterial: async () => makeCleanClaimScan(),
      };
      const result = await executeScopeHonestyGate(TEST_ENV, TEST_BUILD_CONTEXT, deps);
      expect(result.verdict).toBe('fail');
    });

    it('returns fail verdict when claims are found', async () => {
      const deps = {
        verifyObservability: async () => makeValidObservability(),
        scanReleaseMaterial: async (): Promise<ClaimScanResult> => ({
          ...makeCleanClaimScan(),
          evasionClaims: 3,
        }),
      };
      const result = await executeScopeHonestyGate(TEST_ENV, TEST_BUILD_CONTEXT, deps);
      expect(result.verdict).toBe('fail');
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// Runtime-Probe Gate Tests (Req 17.6)
// ────────────────────────────────────────────────────────────────────

describe('Runtime-Probe Gate', () => {
  describe('validateColdProbe', () => {
    it('returns no violations for a successful probe within deadline', () => {
      const probe: ColdProbeResult = {
        success: true,
        durationMs: 1500,
        sidecarProcessesStarted: 0,
      };
      expect(validateColdProbe(probe, 0)).toEqual([]);
    });

    it('returns no violations for a failed probe with zero sidecar processes', () => {
      const probe: ColdProbeResult = {
        success: false,
        durationMs: 5000,
        sidecarProcessesStarted: 0,
      };
      expect(validateColdProbe(probe, 0)).toEqual([]);
    });

    it('reports violation for a successful probe exceeding deadline', () => {
      const probe: ColdProbeResult = {
        success: true,
        durationMs: PROBE_SUCCESS_DEADLINE_MS + 500,
        sidecarProcessesStarted: 0,
      };
      const violations = validateColdProbe(probe, 0);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]).toContain('deadline');
    });

    it('reports violation for a failed probe that started sidecar processes', () => {
      const probe: ColdProbeResult = {
        success: false,
        durationMs: 1000,
        sidecarProcessesStarted: 2,
      };
      const violations = validateColdProbe(probe, 0);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]).toContain('sidecar');
    });
  });

  describe('executeRuntimeProbeGate', () => {
    it('returns pass verdict when all probes succeed within deadline', async () => {
      const deps = {
        executeColdProbe: async (): Promise<ColdProbeResult> => ({
          success: true,
          durationMs: 1000,
          sidecarProcessesStarted: 0,
        }),
      };
      const result = await executeRuntimeProbeGate(TEST_ENV, TEST_BUILD_CONTEXT, deps);
      expect(result.verdict).toBe('pass');
      expect(result.gateId).toBe(ReleaseGateId.RUNTIME_PROBE);
    });

    it('returns fail verdict when a probe exceeds the deadline', async () => {
      const deps = {
        executeColdProbe: async (): Promise<ColdProbeResult> => ({
          success: true,
          durationMs: PROBE_SUCCESS_DEADLINE_MS + 1000,
          sidecarProcessesStarted: 0,
        }),
      };
      const result = await executeRuntimeProbeGate(TEST_ENV, TEST_BUILD_CONTEXT, deps);
      expect(result.verdict).toBe('fail');
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// Startup Gate Tests (Req 17.7)
// ────────────────────────────────────────────────────────────────────

describe('Startup Gate', () => {
  describe('validateMilestoneOrdering', () => {
    it('returns no violations for correct ordering', () => {
      expect(validateMilestoneOrdering(makeValidStartupMilestones())).toEqual([]);
    });

    it('reports violation when authentication is not before handshake', () => {
      const milestones: StartupMilestones = {
        ...makeValidStartupMilestones(),
        authenticationAt: 300,
        readyHandshakeAt: 200,
      };
      const violations = validateMilestoneOrdering(milestones);
      expect(violations.some((v) => v.includes('Authentication'))).toBe(true);
    });

    it('reports violation when handshake is not before snapshot ack', () => {
      const milestones: StartupMilestones = {
        ...makeValidStartupMilestones(),
        readyHandshakeAt: 400,
        snapshotAckAt: 300,
      };
      const violations = validateMilestoneOrdering(milestones);
      expect(violations.some((v) => v.includes('Ready_Handshake'))).toBe(true);
    });

    it('reports violation when snapshot ack is not before first-frame', () => {
      const milestones: StartupMilestones = {
        ...makeValidStartupMilestones(),
        snapshotAckAt: 500,
        firstFrameAt: 400,
      };
      const violations = validateMilestoneOrdering(milestones);
      expect(violations.some((v) => v.includes('Snapshot ack'))).toBe(true);
    });
  });

  describe('validateColdStartup', () => {
    it('returns no violations for a successful startup within deadline', () => {
      expect(validateColdStartup(makeValidStartupResult(), 0)).toEqual([]);
    });

    it('reports violation when startup exceeds deadline', () => {
      const result: ColdStartupResult = {
        success: true,
        milestones: { ...makeValidStartupMilestones(), totalDurationMs: 4000 },
        durationMs: STARTUP_DEADLINE_MS + 500,
      };
      const violations = validateColdStartup(result, 0);
      expect(violations.some((v) => v.includes('deadline'))).toBe(true);
    });

    it('reports violation for a failed startup', () => {
      const result: ColdStartupResult = {
        success: false,
        milestones: null,
        durationMs: 5000,
      };
      const violations = validateColdStartup(result, 0);
      expect(violations.some((v) => v.includes('failed'))).toBe(true);
    });
  });

  describe('computeP95', () => {
    it('returns 0 for an empty array', () => {
      expect(computeP95([])).toBe(0);
    });

    it('returns the single value for a one-element array', () => {
      expect(computeP95([500])).toBe(500);
    });

    it('returns the correct 95th percentile for a larger array', () => {
      // 20 values from 100 to 2000 in steps of 100
      const durations = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
      // ceil(0.95 * 20) - 1 = 19 - 1 = 18 → sorted[18] = 1900
      expect(computeP95(durations)).toBe(1900);
    });
  });

  describe('executeStartupGate', () => {
    it('returns pass verdict when all launches succeed within thresholds', async () => {
      const deps = {
        measureColdStartup: async () => makeValidStartupResult(),
      };
      const result = await executeStartupGate(TEST_ENV, TEST_BUILD_CONTEXT, deps);
      expect(result.verdict).toBe('pass');
      expect(result.gateId).toBe(ReleaseGateId.STARTUP);
    });

    it('returns fail verdict when p95 exceeds threshold', async () => {
      const deps = {
        measureColdStartup: async (): Promise<ColdStartupResult> => ({
          success: true,
          milestones: makeValidStartupMilestones(),
          durationMs: STARTUP_P95_MS + 500,
        }),
      };
      const result = await executeStartupGate(TEST_ENV, TEST_BUILD_CONTEXT, deps);
      expect(result.verdict).toBe('fail');
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// Transparency Gate Tests (Req 17.8)
// ────────────────────────────────────────────────────────────────────

describe('Transparency Gate', () => {
  describe('validateTransparencyAnalysis', () => {
    it('returns no violations for zero nonzero-alpha pixels and low error', () => {
      const analysis: TransparencyAnalysis = {
        mode: 'compact',
        scaleFactor: 100,
        nonzeroAlphaPixelCount: 0,
        maxPartialAlphaError: 0,
      };
      expect(validateTransparencyAnalysis(analysis)).toEqual([]);
    });

    it('reports violation for nonzero-alpha pixels', () => {
      const analysis: TransparencyAnalysis = {
        mode: 'expanded',
        scaleFactor: 150,
        nonzeroAlphaPixelCount: 5,
        maxPartialAlphaError: 0,
      };
      const violations = validateTransparencyAnalysis(analysis);
      expect(violations.some((v) => v.includes('nonzero-alpha'))).toBe(true);
    });

    it('reports violation for excessive partial-alpha error', () => {
      const analysis: TransparencyAnalysis = {
        mode: 'maximized',
        scaleFactor: 200,
        nonzeroAlphaPixelCount: 0,
        maxPartialAlphaError: 5,
      };
      const violations = validateTransparencyAnalysis(analysis);
      expect(violations.some((v) => v.includes('partial-alpha'))).toBe(true);
    });
  });

  describe('executeTransparencyGate', () => {
    it('returns pass verdict when all mode/scale combinations pass', async () => {
      const deps = {
        analyzeTransparency: async (
          _env: EnvironmentMatrixRow,
          mode: 'compact' | 'expanded' | 'maximized',
          scaleFactor: 100 | 125 | 150 | 200,
        ): Promise<TransparencyAnalysis> => ({
          mode,
          scaleFactor,
          nonzeroAlphaPixelCount: 0,
          maxPartialAlphaError: 0,
        }),
      };
      const result = await executeTransparencyGate(TEST_ENV, TEST_BUILD_CONTEXT, deps);
      expect(result.verdict).toBe('pass');
      expect(result.gateId).toBe(ReleaseGateId.TRANSPARENCY);
    });

    it('returns fail verdict when any combination has nonzero-alpha pixels', async () => {
      let callCount = 0;
      const deps = {
        analyzeTransparency: async (
          _env: EnvironmentMatrixRow,
          mode: 'compact' | 'expanded' | 'maximized',
          scaleFactor: 100 | 125 | 150 | 200,
        ): Promise<TransparencyAnalysis> => {
          callCount++;
          return {
            mode,
            scaleFactor,
            nonzeroAlphaPixelCount: callCount === 1 ? 10 : 0,
            maxPartialAlphaError: 0,
          };
        },
      };
      const result = await executeTransparencyGate(TEST_ENV, TEST_BUILD_CONTEXT, deps);
      expect(result.verdict).toBe('fail');
    });
  });
});
