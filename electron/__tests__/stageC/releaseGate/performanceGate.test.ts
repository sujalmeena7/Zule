/**
 * Unit tests for the Performance Gate (Req 17.17).
 *
 * Tests the gate logic with mock metric inputs to verify threshold
 * enforcement for FPS, p95 latency, and run duration.
 */

import { describe, it, expect } from 'vitest';

import {
  evaluatePerformanceMetrics,
  evaluatePerformanceGate,
  MIN_FPS,
  MAX_P95_INTENT_LATENCY_MS,
  PERFORMANCE_RUN_DURATION_MS,
  type PerformanceMetrics,
  type PerformanceMetricsCollector,
  type PerformanceGateInput,
} from '../../../stageC/releaseGate/gates/performanceGate';

import { ReleaseGateId } from '../../../stageC/releaseGate/types';
import type { EnvironmentMatrixRow } from '../../../stageC/releaseGate/types';

// ────────────────────────────────────────────────────────────────────
// Test Fixtures
// ────────────────────────────────────────────────────────────────────

const TEST_ENV: EnvironmentMatrixRow = {
  osBuild: 'win10_22h2',
  architecture: 'x64',
  webView2Version: '119.0.2151.0',
};

function passingMetrics(): PerformanceMetrics {
  return {
    sustainedFps: 60,
    p95IntentLatencyMs: 25,
    runDurationMs: PERFORMANCE_RUN_DURATION_MS,
  };
}

// ────────────────────────────────────────────────────────────────────
// Threshold Constants
// ────────────────────────────────────────────────────────────────────

describe('Performance Gate — Threshold Constants', () => {
  it('MIN_FPS is 30', () => {
    expect(MIN_FPS).toBe(30);
  });

  it('MAX_P95_INTENT_LATENCY_MS is 50', () => {
    expect(MAX_P95_INTENT_LATENCY_MS).toBe(50);
  });

  it('PERFORMANCE_RUN_DURATION_MS is 10 minutes', () => {
    expect(PERFORMANCE_RUN_DURATION_MS).toBe(600_000);
  });
});

// ────────────────────────────────────────────────────────────────────
// evaluatePerformanceMetrics (pure logic)
// ────────────────────────────────────────────────────────────────────

describe('Performance Gate — evaluatePerformanceMetrics', () => {
  it('passes when all thresholds met', () => {
    expect(evaluatePerformanceMetrics(passingMetrics())).toBe('pass');
  });

  it('passes at exact FPS boundary (30)', () => {
    const metrics: PerformanceMetrics = {
      sustainedFps: 30,
      p95IntentLatencyMs: 50,
      runDurationMs: PERFORMANCE_RUN_DURATION_MS,
    };
    expect(evaluatePerformanceMetrics(metrics)).toBe('pass');
  });

  it('fails when FPS below 30', () => {
    const metrics: PerformanceMetrics = {
      sustainedFps: 29.9,
      p95IntentLatencyMs: 25,
      runDurationMs: PERFORMANCE_RUN_DURATION_MS,
    };
    expect(evaluatePerformanceMetrics(metrics)).toBe('fail');
  });

  it('fails when p95 latency exceeds 50 ms', () => {
    const metrics: PerformanceMetrics = {
      sustainedFps: 60,
      p95IntentLatencyMs: 50.1,
      runDurationMs: PERFORMANCE_RUN_DURATION_MS,
    };
    expect(evaluatePerformanceMetrics(metrics)).toBe('fail');
  });

  it('passes at exact latency boundary (50 ms)', () => {
    const metrics: PerformanceMetrics = {
      sustainedFps: 30,
      p95IntentLatencyMs: 50,
      runDurationMs: PERFORMANCE_RUN_DURATION_MS,
    };
    expect(evaluatePerformanceMetrics(metrics)).toBe('pass');
  });

  it('fails when run duration is shorter than 10 minutes', () => {
    const metrics: PerformanceMetrics = {
      sustainedFps: 60,
      p95IntentLatencyMs: 25,
      runDurationMs: PERFORMANCE_RUN_DURATION_MS - 1,
    };
    expect(evaluatePerformanceMetrics(metrics)).toBe('fail');
  });

  it('passes when run duration exceeds 10 minutes', () => {
    const metrics: PerformanceMetrics = {
      sustainedFps: 60,
      p95IntentLatencyMs: 25,
      runDurationMs: PERFORMANCE_RUN_DURATION_MS + 5000,
    };
    expect(evaluatePerformanceMetrics(metrics)).toBe('pass');
  });
});

// ────────────────────────────────────────────────────────────────────
// evaluatePerformanceGate (integration with collector)
// ────────────────────────────────────────────────────────────────────

describe('Performance Gate — evaluatePerformanceGate', () => {
  it('returns pass verdict with correct gate ID and environment binding', async () => {
    const collector: PerformanceMetricsCollector = {
      collect: async () => passingMetrics(),
    };

    const input: PerformanceGateInput = {
      env: TEST_ENV,
      buildHash: 'abc123def456',
      appVersion: '1.0.0',
      sidecarVersion: '1.0.0',
      metricsCollector: collector,
    };

    const result = await evaluatePerformanceGate(input);

    expect(result.gateId).toBe(ReleaseGateId.PERFORMANCE);
    expect(result.verdict).toBe('pass');
    expect(result.buildHash).toBe('abc123def456');
    expect(result.osBuild).toBe('win10_22h2');
    expect(result.architecture).toBe('x64');
    expect(result.webView2Version).toBe('119.0.2151.0');
    expect(result.appVersion).toBe('1.0.0');
    expect(result.sidecarVersion).toBe('1.0.0');
    expect(result.executedAt).toBeTruthy();
  });

  it('returns fail verdict when metrics below thresholds', async () => {
    const collector: PerformanceMetricsCollector = {
      collect: async () => ({
        sustainedFps: 20,
        p95IntentLatencyMs: 80,
        runDurationMs: PERFORMANCE_RUN_DURATION_MS,
      }),
    };

    const input: PerformanceGateInput = {
      env: TEST_ENV,
      buildHash: 'abc123def456',
      appVersion: '1.0.0',
      sidecarVersion: '1.0.0',
      metricsCollector: collector,
    };

    const result = await evaluatePerformanceGate(input);

    expect(result.verdict).toBe('fail');
  });

  it('includes raw measurement summary with metrics and thresholds', async () => {
    const collector: PerformanceMetricsCollector = {
      collect: async () => passingMetrics(),
    };

    const input: PerformanceGateInput = {
      env: TEST_ENV,
      buildHash: 'abc123def456',
      appVersion: '1.0.0',
      sidecarVersion: '1.0.0',
      metricsCollector: collector,
    };

    const result = await evaluatePerformanceGate(input);
    const summary = JSON.parse(result.rawMeasurementSummary);

    expect(summary.sustainedFps).toBe(60);
    expect(summary.p95IntentLatencyMs).toBe(25);
    expect(summary.runDurationMs).toBe(PERFORMANCE_RUN_DURATION_MS);
    expect(summary.thresholds.minFps).toBe(MIN_FPS);
    expect(summary.thresholds.maxP95LatencyMs).toBe(MAX_P95_INTENT_LATENCY_MS);
    expect(summary.thresholds.requiredDurationMs).toBe(PERFORMANCE_RUN_DURATION_MS);
  });
});
