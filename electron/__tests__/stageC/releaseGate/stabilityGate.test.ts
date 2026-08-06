/**
 * Unit tests for the Stability Gate (Req 17.18).
 *
 * Tests the gate logic with mock process monitor inputs to verify
 * thresholds for soak duration, start-stop cycles, crashes, orphans,
 * leaked windows, and memory growth.
 */

import { describe, it, expect } from 'vitest';

import {
  evaluateStabilityMetrics,
  evaluateStartStopMetrics,
  evaluateStabilityGate,
  SOAK_DURATION_MS,
  START_STOP_CYCLES,
  MAX_APP_CORE_CRASHES,
  MAX_SIDECAR_CRASHES,
  MAX_ORPHAN_PROCESSES,
  MAX_LEAKED_WINDOWS,
  MAX_MEMORY_GROWTH_BYTES,
  type StabilityMetrics,
  type StabilityProcessMonitor,
  type StabilityGateInput,
} from '../../../stageC/releaseGate/gates/stabilityGate';

import { ReleaseGateId } from '../../../stageC/releaseGate/types';
import type { EnvironmentMatrixRow } from '../../../stageC/releaseGate/types';

// ────────────────────────────────────────────────────────────────────
// Test Fixtures
// ────────────────────────────────────────────────────────────────────

const TEST_ENV: EnvironmentMatrixRow = {
  osBuild: 'win11_23h2',
  architecture: 'x64',
  webView2Version: '120.0.2210.0',
};

function passingSoakMetrics(): StabilityMetrics {
  return {
    soakDurationMs: SOAK_DURATION_MS,
    completedCycles: 0,
    appCoreCrashes: 0,
    sidecarCrashes: 0,
    orphanProcesses: 0,
    leakedWindows: 0,
    memoryGrowthBytes: 0,
  };
}

function passingCycleMetrics(): StabilityMetrics {
  return {
    soakDurationMs: 0,
    completedCycles: START_STOP_CYCLES,
    appCoreCrashes: 0,
    sidecarCrashes: 0,
    orphanProcesses: 0,
    leakedWindows: 0,
    memoryGrowthBytes: 0,
  };
}

// ────────────────────────────────────────────────────────────────────
// Threshold Constants
// ────────────────────────────────────────────────────────────────────

describe('Stability Gate — Threshold Constants', () => {
  it('SOAK_DURATION_MS is 60 minutes', () => {
    expect(SOAK_DURATION_MS).toBe(3_600_000);
  });

  it('START_STOP_CYCLES is 100', () => {
    expect(START_STOP_CYCLES).toBe(100);
  });

  it('MAX_APP_CORE_CRASHES is 0', () => {
    expect(MAX_APP_CORE_CRASHES).toBe(0);
  });

  it('MAX_SIDECAR_CRASHES is 0', () => {
    expect(MAX_SIDECAR_CRASHES).toBe(0);
  });

  it('MAX_ORPHAN_PROCESSES is 0', () => {
    expect(MAX_ORPHAN_PROCESSES).toBe(0);
  });

  it('MAX_LEAKED_WINDOWS is 0', () => {
    expect(MAX_LEAKED_WINDOWS).toBe(0);
  });

  it('MAX_MEMORY_GROWTH_BYTES is 50 MiB', () => {
    expect(MAX_MEMORY_GROWTH_BYTES).toBe(50 * 1024 * 1024);
  });
});

// ────────────────────────────────────────────────────────────────────
// evaluateStabilityMetrics (soak)
// ────────────────────────────────────────────────────────────────────

describe('Stability Gate — evaluateStabilityMetrics', () => {
  it('passes with zero issues and full soak duration', () => {
    expect(evaluateStabilityMetrics(passingSoakMetrics())).toBe('pass');
  });

  it('fails when soak duration is incomplete', () => {
    const metrics: StabilityMetrics = {
      ...passingSoakMetrics(),
      soakDurationMs: SOAK_DURATION_MS - 1,
    };
    expect(evaluateStabilityMetrics(metrics)).toBe('fail');
  });

  it('fails when App Core crash count exceeds zero', () => {
    const metrics: StabilityMetrics = {
      ...passingSoakMetrics(),
      appCoreCrashes: 1,
    };
    expect(evaluateStabilityMetrics(metrics)).toBe('fail');
  });

  it('fails when sidecar crash count exceeds zero', () => {
    const metrics: StabilityMetrics = {
      ...passingSoakMetrics(),
      sidecarCrashes: 1,
    };
    expect(evaluateStabilityMetrics(metrics)).toBe('fail');
  });

  it('fails when orphan processes are detected', () => {
    const metrics: StabilityMetrics = {
      ...passingSoakMetrics(),
      orphanProcesses: 1,
    };
    expect(evaluateStabilityMetrics(metrics)).toBe('fail');
  });

  it('fails when leaked windows are detected', () => {
    const metrics: StabilityMetrics = {
      ...passingSoakMetrics(),
      leakedWindows: 1,
    };
    expect(evaluateStabilityMetrics(metrics)).toBe('fail');
  });

  it('fails when memory growth exceeds 50 MiB', () => {
    const metrics: StabilityMetrics = {
      ...passingSoakMetrics(),
      memoryGrowthBytes: MAX_MEMORY_GROWTH_BYTES + 1,
    };
    expect(evaluateStabilityMetrics(metrics)).toBe('fail');
  });

  it('passes at exact 50 MiB boundary', () => {
    const metrics: StabilityMetrics = {
      ...passingSoakMetrics(),
      memoryGrowthBytes: MAX_MEMORY_GROWTH_BYTES,
    };
    expect(evaluateStabilityMetrics(metrics)).toBe('pass');
  });
});

// ────────────────────────────────────────────────────────────────────
// evaluateStartStopMetrics (cycles)
// ────────────────────────────────────────────────────────────────────

describe('Stability Gate — evaluateStartStopMetrics', () => {
  it('passes with 100 completed cycles and zero issues', () => {
    expect(evaluateStartStopMetrics(passingCycleMetrics())).toBe('pass');
  });

  it('fails when fewer than 100 cycles completed', () => {
    const metrics: StabilityMetrics = {
      ...passingCycleMetrics(),
      completedCycles: 99,
    };
    expect(evaluateStartStopMetrics(metrics)).toBe('fail');
  });

  it('passes when more than 100 cycles completed', () => {
    const metrics: StabilityMetrics = {
      ...passingCycleMetrics(),
      completedCycles: 150,
    };
    expect(evaluateStartStopMetrics(metrics)).toBe('pass');
  });

  it('fails when App Core crashes during cycles', () => {
    const metrics: StabilityMetrics = {
      ...passingCycleMetrics(),
      appCoreCrashes: 1,
    };
    expect(evaluateStartStopMetrics(metrics)).toBe('fail');
  });

  it('fails when sidecar crashes during cycles', () => {
    const metrics: StabilityMetrics = {
      ...passingCycleMetrics(),
      sidecarCrashes: 1,
    };
    expect(evaluateStartStopMetrics(metrics)).toBe('fail');
  });

  it('fails when orphan processes remain after cycles', () => {
    const metrics: StabilityMetrics = {
      ...passingCycleMetrics(),
      orphanProcesses: 1,
    };
    expect(evaluateStartStopMetrics(metrics)).toBe('fail');
  });

  it('fails when leaked windows remain after cycles', () => {
    const metrics: StabilityMetrics = {
      ...passingCycleMetrics(),
      leakedWindows: 1,
    };
    expect(evaluateStartStopMetrics(metrics)).toBe('fail');
  });

  it('fails when memory growth exceeds 50 MiB after cycles', () => {
    const metrics: StabilityMetrics = {
      ...passingCycleMetrics(),
      memoryGrowthBytes: MAX_MEMORY_GROWTH_BYTES + 1,
    };
    expect(evaluateStartStopMetrics(metrics)).toBe('fail');
  });
});

// ────────────────────────────────────────────────────────────────────
// evaluateStabilityGate (integration with process monitor)
// ────────────────────────────────────────────────────────────────────

describe('Stability Gate — evaluateStabilityGate', () => {
  it('returns pass verdict when both soak and cycles pass', async () => {
    const monitor: StabilityProcessMonitor = {
      runSoak: async () => passingSoakMetrics(),
      runStartStopCycles: async () => passingCycleMetrics(),
    };

    const input: StabilityGateInput = {
      env: TEST_ENV,
      buildHash: 'hash123',
      appVersion: '2.0.0',
      sidecarVersion: '2.0.0',
      processMonitor: monitor,
    };

    const result = await evaluateStabilityGate(input);

    expect(result.gateId).toBe(ReleaseGateId.STABILITY);
    expect(result.verdict).toBe('pass');
    expect(result.buildHash).toBe('hash123');
    expect(result.osBuild).toBe('win11_23h2');
    expect(result.architecture).toBe('x64');
    expect(result.webView2Version).toBe('120.0.2210.0');
  });

  it('returns fail verdict when soak fails but cycles pass', async () => {
    const monitor: StabilityProcessMonitor = {
      runSoak: async () => ({ ...passingSoakMetrics(), appCoreCrashes: 1 }),
      runStartStopCycles: async () => passingCycleMetrics(),
    };

    const input: StabilityGateInput = {
      env: TEST_ENV,
      buildHash: 'hash123',
      appVersion: '2.0.0',
      sidecarVersion: '2.0.0',
      processMonitor: monitor,
    };

    const result = await evaluateStabilityGate(input);
    expect(result.verdict).toBe('fail');
  });

  it('returns fail verdict when cycles fail but soak passes', async () => {
    const monitor: StabilityProcessMonitor = {
      runSoak: async () => passingSoakMetrics(),
      runStartStopCycles: async () => ({ ...passingCycleMetrics(), completedCycles: 50 }),
    };

    const input: StabilityGateInput = {
      env: TEST_ENV,
      buildHash: 'hash123',
      appVersion: '2.0.0',
      sidecarVersion: '2.0.0',
      processMonitor: monitor,
    };

    const result = await evaluateStabilityGate(input);
    expect(result.verdict).toBe('fail');
  });

  it('includes raw measurement summary with both soak and cycle data', async () => {
    const monitor: StabilityProcessMonitor = {
      runSoak: async () => passingSoakMetrics(),
      runStartStopCycles: async () => passingCycleMetrics(),
    };

    const input: StabilityGateInput = {
      env: TEST_ENV,
      buildHash: 'hash123',
      appVersion: '2.0.0',
      sidecarVersion: '2.0.0',
      processMonitor: monitor,
    };

    const result = await evaluateStabilityGate(input);
    const summary = JSON.parse(result.rawMeasurementSummary);

    expect(summary.soak.soakDurationMs).toBe(SOAK_DURATION_MS);
    expect(summary.cycles.completedCycles).toBe(START_STOP_CYCLES);
    expect(summary.thresholds.soakDurationMs).toBe(SOAK_DURATION_MS);
    expect(summary.thresholds.startStopCycles).toBe(START_STOP_CYCLES);
    expect(summary.thresholds.maxMemoryGrowthBytes).toBe(MAX_MEMORY_GROWTH_BYTES);
  });
});
