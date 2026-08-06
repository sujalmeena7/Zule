/**
 * Unit tests for Stage C Release Gates: input, geometry, capture,
 * capture-fallback, lifecycle-fallback, and diagnostic-retry.
 *
 * Requirements: 17.9–17.10, 17.13–17.16
 */

import { describe, it, expect } from 'vitest';

import { ReleaseGateId } from '../stageC/releaseGate/types';
import type { EnvironmentMatrixRow } from '../stageC/releaseGate/types';

import {
  // Input gate
  REQUIRED_CLICK_TARGETS,
  REQUIRED_KEYBOARD_IME_ACTIONS,
  REQUIRED_SCROLL_ACTIONS,
  REQUIRED_DRAGS_PER_SCALE,
  MAX_COORDINATE_ERROR_PX,
  type InputActionResult,
  type InputGateDeps,
  executeInputGate,
  // Geometry gate
  REQUIRED_SCALE_FACTORS,
  REQUIRED_TOPOLOGIES,
  MAX_EDGE_ERROR_PX,
  type GeometryGateDeps,
  executeGeometryGate,
  // Capture gate
  REQUIRED_CAPTURE_CYCLES,
  MAX_READBACK_LATENCY_MS,
  REQUIRED_RECORDERS,
  type CaptureGateDeps,
  executeCaptureGate,
  // Capture-fallback gate
  MAX_LAYER0_RECOVERY_MS,
  REQUIRED_CAPTURE_FAILURE_TYPES,
  type CaptureFallbackGateDeps,
  executeCaptureFallbackGate,
  // Fallback gate
  REQUIRED_INJECTION_REPETITIONS,
  MAX_RECOVERY_DURATION_MS,
  REQUIRED_FAILURE_TYPES,
  type FallbackGateDeps,
  executeFallbackGate,
  // Diagnostic-retry gate
  EXPECTED_ACCEPTED_RETRIES,
  REJECTION_VERIFICATION_ATTEMPTS,
  type DiagnosticRetryGateDeps,
  executeDiagnosticRetryGate,
} from '../stageC/releaseGate/gates';

// ────────────────────────────────────────────────────────────────────
// Test Fixtures
// ────────────────────────────────────────────────────────────────────

const TEST_ROW: EnvironmentMatrixRow = {
  osBuild: 'win10_22h2',
  architecture: 'x64',
  webView2Version: '119.0.2151.0',
};

const TEST_BUILD_HASH = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
const TEST_APP_VERSION = '1.0.0';
const TEST_SIDECAR_VERSION = '1.0.0';

function makePassingResult(): InputActionResult {
  return { routed: true, coordinateErrorPx: 0, retainedCapture: false };
}

// ────────────────────────────────────────────────────────────────────
// Input Gate Tests (Req 17.9)
// ────────────────────────────────────────────────────────────────────

describe('Input Gate (Req 17.9)', () => {
  function makeInputDeps(overrides?: Partial<InputGateDeps>): InputGateDeps {
    const scales = [1.0, 1.25, 1.5, 2.0];
    return {
      getTestedScales: () => scales,
      runClickTargets: async () => Array.from({ length: REQUIRED_CLICK_TARGETS }, makePassingResult),
      runKeyboardImeActions: async () => Array.from({ length: REQUIRED_KEYBOARD_IME_ACTIONS }, makePassingResult),
      runScrollActions: async () => Array.from({ length: REQUIRED_SCROLL_ACTIONS }, makePassingResult),
      runDragActions: async () => Array.from({ length: REQUIRED_DRAGS_PER_SCALE }, makePassingResult),
      ...overrides,
    };
  }

  it('passes when all inputs meet thresholds', async () => {
    const result = await executeInputGate(TEST_ROW, makeInputDeps(), TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION);

    expect(result.gateId).toBe(ReleaseGateId.INPUT);
    expect(result.verdict).toBe('pass');
    expect(result.buildHash).toBe(TEST_BUILD_HASH);
    expect(result.osBuild).toBe(TEST_ROW.osBuild);
  });

  it('fails when click targets are insufficient', async () => {
    const deps = makeInputDeps({
      runClickTargets: async () => Array.from({ length: 50 }, makePassingResult),
    });

    const result = await executeInputGate(TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION);
    expect(result.verdict).toBe('fail');

    const summary = JSON.parse(result.rawMeasurementSummary);
    expect(summary.failures.some((f: string) => f.includes('click targets'))).toBe(true);
  });

  it('fails when misroutes are detected', async () => {
    const deps = makeInputDeps({
      runClickTargets: async () =>
        Array.from({ length: REQUIRED_CLICK_TARGETS }, (_, i) =>
          i === 0 ? { routed: false, coordinateErrorPx: 0, retainedCapture: false } : makePassingResult(),
        ),
    });

    const result = await executeInputGate(TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION);
    expect(result.verdict).toBe('fail');

    const summary = JSON.parse(result.rawMeasurementSummary);
    expect(summary.misroutes).toBeGreaterThan(0);
  });

  it('fails when coordinate error exceeds threshold', async () => {
    const deps = makeInputDeps({
      runClickTargets: async () =>
        Array.from({ length: REQUIRED_CLICK_TARGETS }, (_, i) =>
          i === 0 ? { routed: true, coordinateErrorPx: MAX_COORDINATE_ERROR_PX + 1, retainedCapture: false } : makePassingResult(),
        ),
    });

    const result = await executeInputGate(TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION);
    expect(result.verdict).toBe('fail');

    const summary = JSON.parse(result.rawMeasurementSummary);
    expect(summary.maxCoordinateErrorPx).toBeGreaterThan(MAX_COORDINATE_ERROR_PX);
  });

  it('fails when retained pointer captures are detected', async () => {
    const deps = makeInputDeps({
      runDragActions: async () =>
        Array.from({ length: REQUIRED_DRAGS_PER_SCALE }, (_, i) =>
          i === 0 ? { routed: true, coordinateErrorPx: 0, retainedCapture: true } : makePassingResult(),
        ),
    });

    const result = await executeInputGate(TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION);
    expect(result.verdict).toBe('fail');

    const summary = JSON.parse(result.rawMeasurementSummary);
    expect(summary.retainedCaptures).toBeGreaterThan(0);
  });

  it('encodes required counts as constants', () => {
    expect(REQUIRED_CLICK_TARGETS).toBe(100);
    expect(REQUIRED_KEYBOARD_IME_ACTIONS).toBe(100);
    expect(REQUIRED_SCROLL_ACTIONS).toBe(100);
    expect(REQUIRED_DRAGS_PER_SCALE).toBe(20);
    expect(MAX_COORDINATE_ERROR_PX).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// Geometry Gate Tests (Req 17.10)
// ────────────────────────────────────────────────────────────────────

describe('Geometry Gate (Req 17.10)', () => {
  function makeGeometryDeps(overrides?: Partial<GeometryGateDeps>): GeometryGateDeps {
    return {
      runGeometryOperation: async (scale, topology) => ({
        scale,
        topology,
        edgeErrorPx: 0,
        surfaceReachable: true,
      }),
      ...overrides,
    };
  }

  it('passes when all scale×topology combinations pass', async () => {
    const result = await executeGeometryGate(TEST_ROW, makeGeometryDeps(), TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION);

    expect(result.gateId).toBe(ReleaseGateId.GEOMETRY);
    expect(result.verdict).toBe('pass');

    const summary = JSON.parse(result.rawMeasurementSummary);
    expect(summary.totalOperations).toBe(REQUIRED_SCALE_FACTORS.length * REQUIRED_TOPOLOGIES.length);
  });

  it('fails when edge error exceeds threshold', async () => {
    const deps = makeGeometryDeps({
      runGeometryOperation: async (scale, topology) => ({
        scale,
        topology,
        edgeErrorPx: scale === 3.0 && topology === 'dpi_change' ? MAX_EDGE_ERROR_PX + 1 : 0,
        surfaceReachable: true,
      }),
    });

    const result = await executeGeometryGate(TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION);
    expect(result.verdict).toBe('fail');

    const summary = JSON.parse(result.rawMeasurementSummary);
    expect(summary.maxEdgeErrorPx).toBeGreaterThan(MAX_EDGE_ERROR_PX);
  });

  it('fails when surface is unreachable', async () => {
    const deps = makeGeometryDeps({
      runGeometryOperation: async (scale, topology) => ({
        scale,
        topology,
        edgeErrorPx: 0,
        surfaceReachable: topology !== 'monitor_removal',
      }),
    });

    const result = await executeGeometryGate(TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION);
    expect(result.verdict).toBe('fail');

    const summary = JSON.parse(result.rawMeasurementSummary);
    expect(summary.unreachableSurfaces).toBeGreaterThan(0);
  });

  it('encodes required scale factors and topologies', () => {
    expect(REQUIRED_SCALE_FACTORS).toEqual([1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0]);
    expect(REQUIRED_TOPOLOGIES).toContain('move');
    expect(REQUIRED_TOPOLOGIES).toContain('resize');
    expect(REQUIRED_TOPOLOGIES).toContain('dpi_change');
    expect(REQUIRED_TOPOLOGIES).toContain('rotation');
    expect(REQUIRED_TOPOLOGIES).toContain('negative_coordinates');
    expect(REQUIRED_TOPOLOGIES).toContain('work_area_change');
    expect(REQUIRED_TOPOLOGIES.length).toBe(13);
  });
});

// ────────────────────────────────────────────────────────────────────
// Capture Gate Tests (Req 17.13)
// ────────────────────────────────────────────────────────────────────

describe('Capture Gate (Req 17.13)', () => {
  function makeCaptureDeps(overrides?: Partial<CaptureGateDeps>): CaptureGateDeps {
    return {
      runCaptureCycle: async (cycleIndex) => ({
        cycleIndex,
        readbackMatchesRequest: true,
        readbackLatencyMs: 50,
      }),
      checkRecorderParity: async (recorder) => ({
        recorder,
        parityWithLayer0: true,
      }),
      ...overrides,
    };
  }

  it('passes when all cycles meet thresholds and recorders confirm parity', async () => {
    const result = await executeCaptureGate(TEST_ROW, makeCaptureDeps(), TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION);

    expect(result.gateId).toBe(ReleaseGateId.CAPTURE);
    expect(result.verdict).toBe('pass');
  });

  it('fails when read-back does not match request', async () => {
    const deps = makeCaptureDeps({
      runCaptureCycle: async (cycleIndex) => ({
        cycleIndex,
        readbackMatchesRequest: cycleIndex !== 5,
        readbackLatencyMs: 50,
      }),
    });

    const result = await executeCaptureGate(TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION);
    expect(result.verdict).toBe('fail');

    const summary = JSON.parse(result.rawMeasurementSummary);
    expect(summary.readbackMismatches).toBe(1);
  });

  it('fails when read-back latency exceeds 100ms', async () => {
    const deps = makeCaptureDeps({
      runCaptureCycle: async (cycleIndex) => ({
        cycleIndex,
        readbackMatchesRequest: true,
        readbackLatencyMs: cycleIndex === 10 ? MAX_READBACK_LATENCY_MS + 50 : 50,
      }),
    });

    const result = await executeCaptureGate(TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION);
    expect(result.verdict).toBe('fail');

    const summary = JSON.parse(result.rawMeasurementSummary);
    expect(summary.latencyExceeded).toBe(1);
  });

  it('fails when recorder does not confirm Layer 0 parity', async () => {
    const deps = makeCaptureDeps({
      checkRecorderParity: async (recorder) => ({
        recorder,
        parityWithLayer0: recorder !== 'windows_graphics_capture',
      }),
    });

    const result = await executeCaptureGate(TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION);
    expect(result.verdict).toBe('fail');
  });

  it('encodes required cycles, latency, and recorders', () => {
    expect(REQUIRED_CAPTURE_CYCLES).toBe(20);
    expect(MAX_READBACK_LATENCY_MS).toBe(100);
    expect(REQUIRED_RECORDERS).toContain('electron_desktop_capture');
    expect(REQUIRED_RECORDERS).toContain('windows_graphics_capture');
  });
});

// ────────────────────────────────────────────────────────────────────
// Capture-Fallback Gate Tests (Req 17.14)
// ────────────────────────────────────────────────────────────────────

describe('Capture-Fallback Gate (Req 17.14)', () => {
  function makeCaptureFallbackDeps(overrides?: Partial<CaptureFallbackGateDeps>): CaptureFallbackGateDeps {
    return {
      injectCaptureFailure: async (failureType) => ({
        failureType,
        layer0Usable: true,
        layer0RecoveryMs: 200,
        bothHiddenIntervals: 0,
      }),
      ...overrides,
    };
  }

  it('passes when all injected failures recover within budget', async () => {
    const result = await executeCaptureFallbackGate(TEST_ROW, makeCaptureFallbackDeps(), TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION);

    expect(result.gateId).toBe(ReleaseGateId.CAPTURE_FALLBACK);
    expect(result.verdict).toBe('pass');
  });

  it('fails when Layer 0 recovery exceeds 500ms', async () => {
    const deps = makeCaptureFallbackDeps({
      injectCaptureFailure: async (failureType) => ({
        failureType,
        layer0Usable: true,
        layer0RecoveryMs: failureType === 'readback_timeout' ? MAX_LAYER0_RECOVERY_MS + 100 : 200,
        bothHiddenIntervals: 0,
      }),
    });

    const result = await executeCaptureFallbackGate(TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION);
    expect(result.verdict).toBe('fail');
  });

  it('fails when both surfaces are hidden beyond deadline', async () => {
    const deps = makeCaptureFallbackDeps({
      injectCaptureFailure: async (failureType) => ({
        failureType,
        layer0Usable: true,
        layer0RecoveryMs: 200,
        bothHiddenIntervals: failureType === 'application_failure' ? 1 : 0,
      }),
    });

    const result = await executeCaptureFallbackGate(TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION);
    expect(result.verdict).toBe('fail');
  });

  it('fails when Layer 0 does not become usable', async () => {
    const deps = makeCaptureFallbackDeps({
      injectCaptureFailure: async (failureType) => ({
        failureType,
        layer0Usable: failureType !== 'readback_failure',
        layer0RecoveryMs: 9999,
        bothHiddenIntervals: 0,
      }),
    });

    const result = await executeCaptureFallbackGate(TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION);
    expect(result.verdict).toBe('fail');
  });

  it('encodes required failure types and 500ms budget', () => {
    expect(REQUIRED_CAPTURE_FAILURE_TYPES).toEqual([
      'application_failure',
      'readback_failure',
      'readback_mismatch',
      'readback_timeout',
    ]);
    expect(MAX_LAYER0_RECOVERY_MS).toBe(500);
  });
});

// ────────────────────────────────────────────────────────────────────
// Lifecycle-Fallback Gate Tests (Req 17.15)
// ────────────────────────────────────────────────────────────────────

describe('Lifecycle-Fallback Gate (Req 17.15)', () => {
  function makeFallbackDeps(overrides?: Partial<FallbackGateDeps>): FallbackGateDeps {
    return {
      injectLifecycleFailure: async (failureType, repetition) => ({
        failureType,
        repetition,
        layer0Recovered: true,
        duplicateVisibleSurfaces: 0,
        recoveryDurationMs: 200,
      }),
      ...overrides,
    };
  }

  it('passes when all injected failures recover correctly', async () => {
    const result = await executeFallbackGate(TEST_ROW, makeFallbackDeps(), TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION);

    expect(result.gateId).toBe(ReleaseGateId.FALLBACK);
    expect(result.verdict).toBe('pass');

    const summary = JSON.parse(result.rawMeasurementSummary);
    expect(summary.totalInjections).toBe(REQUIRED_FAILURE_TYPES.length * REQUIRED_INJECTION_REPETITIONS);
  });

  it('fails when Layer 0 does not recover', async () => {
    const deps = makeFallbackDeps({
      injectLifecycleFailure: async (failureType, repetition) => ({
        failureType,
        repetition,
        layer0Recovered: failureType !== 'crash' || repetition !== 5,
        duplicateVisibleSurfaces: 0,
        recoveryDurationMs: 200,
      }),
    });

    const result = await executeFallbackGate(TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION);
    expect(result.verdict).toBe('fail');
  });

  it('fails when duplicate visible surfaces are detected', async () => {
    const deps = makeFallbackDeps({
      injectLifecycleFailure: async (failureType, repetition) => ({
        failureType,
        repetition,
        layer0Recovered: true,
        duplicateVisibleSurfaces: failureType === 'disconnect' && repetition === 0 ? 1 : 0,
        recoveryDurationMs: 200,
      }),
    });

    const result = await executeFallbackGate(TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION);
    expect(result.verdict).toBe('fail');
  });

  it('fails when recovery duration exceeds 500ms', async () => {
    const deps = makeFallbackDeps({
      injectLifecycleFailure: async (failureType, repetition) => ({
        failureType,
        repetition,
        layer0Recovered: true,
        duplicateVisibleSurfaces: 0,
        recoveryDurationMs: failureType === 'timeout' ? MAX_RECOVERY_DURATION_MS + 100 : 200,
      }),
    });

    const result = await executeFallbackGate(TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION);
    expect(result.verdict).toBe('fail');
  });

  it('encodes 13 failure types and 10 repetitions', () => {
    expect(REQUIRED_FAILURE_TYPES.length).toBe(13);
    expect(REQUIRED_FAILURE_TYPES).toContain('probe');
    expect(REQUIRED_FAILURE_TYPES).toContain('endpoint');
    expect(REQUIRED_FAILURE_TYPES).toContain('launch');
    expect(REQUIRED_FAILURE_TYPES).toContain('authentication');
    expect(REQUIRED_FAILURE_TYPES).toContain('handshake');
    expect(REQUIRED_FAILURE_TYPES).toContain('webview2');
    expect(REQUIRED_FAILURE_TYPES).toContain('bridge');
    expect(REQUIRED_FAILURE_TYPES).toContain('composition');
    expect(REQUIRED_FAILURE_TYPES).toContain('snapshot');
    expect(REQUIRED_FAILURE_TYPES).toContain('first_frame');
    expect(REQUIRED_FAILURE_TYPES).toContain('disconnect');
    expect(REQUIRED_FAILURE_TYPES).toContain('timeout');
    expect(REQUIRED_FAILURE_TYPES).toContain('crash');
    expect(REQUIRED_INJECTION_REPETITIONS).toBe(10);
    expect(MAX_RECOVERY_DURATION_MS).toBe(500);
  });
});

// ────────────────────────────────────────────────────────────────────
// Diagnostic-Retry Gate Tests (Req 17.16)
// ────────────────────────────────────────────────────────────────────

describe('Diagnostic-Retry Gate (Req 17.16)', () => {
  function makeDiagnosticRetryDeps(overrides?: Partial<DiagnosticRetryGateDeps>): DiagnosticRetryGateDeps {
    return {
      attemptDiagnosticRetry: async (attemptIndex) => ({
        attemptIndex,
        accepted: attemptIndex === 0, // Only first retry accepted
      }),
      ...overrides,
    };
  }

  it('passes when first retry is accepted and all subsequent are rejected', async () => {
    const result = await executeDiagnosticRetryGate(TEST_ROW, makeDiagnosticRetryDeps(), TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION);

    expect(result.gateId).toBe(ReleaseGateId.DIAGNOSTIC_RETRY);
    expect(result.verdict).toBe('pass');
  });

  it('fails when first retry is rejected', async () => {
    const deps = makeDiagnosticRetryDeps({
      attemptDiagnosticRetry: async () => ({
        attemptIndex: 0,
        accepted: false, // All rejected
      }),
    });

    const result = await executeDiagnosticRetryGate(TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION);
    expect(result.verdict).toBe('fail');
  });

  it('fails when subsequent retries are accepted', async () => {
    const deps = makeDiagnosticRetryDeps({
      attemptDiagnosticRetry: async (attemptIndex) => ({
        attemptIndex,
        accepted: true, // All accepted (should only be first)
      }),
    });

    const result = await executeDiagnosticRetryGate(TEST_ROW, deps, TEST_BUILD_HASH, TEST_APP_VERSION, TEST_SIDECAR_VERSION);
    expect(result.verdict).toBe('fail');

    const summary = JSON.parse(result.rawMeasurementSummary);
    expect(summary.unexpectedAcceptances).toBeGreaterThan(0);
  });

  it('encodes one accepted retry and rejection verification attempts', () => {
    expect(EXPECTED_ACCEPTED_RETRIES).toBe(1);
    expect(REJECTION_VERIFICATION_ATTEMPTS).toBe(5);
  });
});
