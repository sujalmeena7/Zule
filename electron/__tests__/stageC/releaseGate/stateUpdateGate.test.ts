/**
 * Unit tests for the State-Update Gate (Req 17.22).
 *
 * Tests the gate logic with mock verifier inputs to verify enforcement
 * of queue bounds, revision-correlated acks, latest-value semantics,
 * and safe coalescing behavior.
 */

import { describe, it, expect } from 'vitest';

import {
  evaluateStateUpdateMetrics,
  evaluateStateUpdateGate,
  MAX_QUEUE_MESSAGE_COUNT,
  MAX_QUEUE_SIZE_BYTES,
  type StateUpdateMetrics,
  type StateUpdateVerifier,
  type StateUpdateGateInput,
} from '../../../stageC/releaseGate/gates/stateUpdateGate';

import { ReleaseGateId } from '../../../stageC/releaseGate/types';
import type { EnvironmentMatrixRow } from '../../../stageC/releaseGate/types';

// ────────────────────────────────────────────────────────────────────
// Test Fixtures
// ────────────────────────────────────────────────────────────────────

const TEST_ENV: EnvironmentMatrixRow = {
  osBuild: 'win11_24h2',
  architecture: 'x64',
  webView2Version: '124.0.2478.0',
};

function passingMetrics(): StateUpdateMetrics {
  return {
    queueBounds: {
      messageCountBoundEnforced: true,
      byteSizeBoundEnforced: true,
      observedMaxMessageCount: 200,
      observedMaxByteSize: 800_000,
    },
    revisionAcks: {
      allAcksCorrelated: true,
      totalAcksValidated: 500,
      uncorrelatedAcks: 0,
    },
    latestValue: {
      geometryLatestValue: true,
      visibilityLatestValue: true,
    },
    coalescing: {
      onlySupersededCoalesced: true,
      terminalTransitionsPreserved: true,
      errorTransitionsPreserved: true,
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// Threshold Constants
// ────────────────────────────────────────────────────────────────────

describe('State-Update Gate — Threshold Constants', () => {
  it('MAX_QUEUE_MESSAGE_COUNT is 256', () => {
    expect(MAX_QUEUE_MESSAGE_COUNT).toBe(256);
  });

  it('MAX_QUEUE_SIZE_BYTES is 1,048,576 (1 MiB)', () => {
    expect(MAX_QUEUE_SIZE_BYTES).toBe(1_048_576);
  });
});

// ────────────────────────────────────────────────────────────────────
// evaluateStateUpdateMetrics (pure logic)
// ────────────────────────────────────────────────────────────────────

describe('State-Update Gate — evaluateStateUpdateMetrics', () => {
  it('passes when all criteria are met', () => {
    expect(evaluateStateUpdateMetrics(passingMetrics())).toBe('pass');
  });

  // Queue bounds
  it('fails when message count bound is not enforced', () => {
    const metrics: StateUpdateMetrics = {
      ...passingMetrics(),
      queueBounds: {
        ...passingMetrics().queueBounds,
        messageCountBoundEnforced: false,
      },
    };
    expect(evaluateStateUpdateMetrics(metrics)).toBe('fail');
  });

  it('fails when byte size bound is not enforced', () => {
    const metrics: StateUpdateMetrics = {
      ...passingMetrics(),
      queueBounds: {
        ...passingMetrics().queueBounds,
        byteSizeBoundEnforced: false,
      },
    };
    expect(evaluateStateUpdateMetrics(metrics)).toBe('fail');
  });

  // Revision-correlated acknowledgements
  it('fails when acknowledgements are not revision-correlated', () => {
    const metrics: StateUpdateMetrics = {
      ...passingMetrics(),
      revisionAcks: {
        allAcksCorrelated: false,
        totalAcksValidated: 500,
        uncorrelatedAcks: 3,
      },
    };
    expect(evaluateStateUpdateMetrics(metrics)).toBe('fail');
  });

  // Latest-value semantics
  it('fails when geometry does not use latest-value semantics', () => {
    const metrics: StateUpdateMetrics = {
      ...passingMetrics(),
      latestValue: {
        geometryLatestValue: false,
        visibilityLatestValue: true,
      },
    };
    expect(evaluateStateUpdateMetrics(metrics)).toBe('fail');
  });

  it('fails when visibility does not use latest-value semantics', () => {
    const metrics: StateUpdateMetrics = {
      ...passingMetrics(),
      latestValue: {
        geometryLatestValue: true,
        visibilityLatestValue: false,
      },
    };
    expect(evaluateStateUpdateMetrics(metrics)).toBe('fail');
  });

  // Coalescing safety
  it('fails when non-superseded patches are coalesced', () => {
    const metrics: StateUpdateMetrics = {
      ...passingMetrics(),
      coalescing: {
        onlySupersededCoalesced: false,
        terminalTransitionsPreserved: true,
        errorTransitionsPreserved: true,
      },
    };
    expect(evaluateStateUpdateMetrics(metrics)).toBe('fail');
  });

  it('fails when terminal transitions are not preserved', () => {
    const metrics: StateUpdateMetrics = {
      ...passingMetrics(),
      coalescing: {
        onlySupersededCoalesced: true,
        terminalTransitionsPreserved: false,
        errorTransitionsPreserved: true,
      },
    };
    expect(evaluateStateUpdateMetrics(metrics)).toBe('fail');
  });

  it('fails when error transitions are not preserved', () => {
    const metrics: StateUpdateMetrics = {
      ...passingMetrics(),
      coalescing: {
        onlySupersededCoalesced: true,
        terminalTransitionsPreserved: true,
        errorTransitionsPreserved: false,
      },
    };
    expect(evaluateStateUpdateMetrics(metrics)).toBe('fail');
  });
});

// ────────────────────────────────────────────────────────────────────
// evaluateStateUpdateGate (integration with verifier)
// ────────────────────────────────────────────────────────────────────

describe('State-Update Gate — evaluateStateUpdateGate', () => {
  it('returns pass verdict with correct gate ID and environment binding', async () => {
    const verifier: StateUpdateVerifier = {
      verify: async () => passingMetrics(),
    };

    const input: StateUpdateGateInput = {
      env: TEST_ENV,
      buildHash: 'state-hash-789',
      appVersion: '3.0.0',
      sidecarVersion: '3.0.0',
      stateUpdateVerifier: verifier,
    };

    const result = await evaluateStateUpdateGate(input);

    expect(result.gateId).toBe(ReleaseGateId.STATE_UPDATE);
    expect(result.verdict).toBe('pass');
    expect(result.buildHash).toBe('state-hash-789');
    expect(result.osBuild).toBe('win11_24h2');
    expect(result.architecture).toBe('x64');
    expect(result.webView2Version).toBe('124.0.2478.0');
    expect(result.appVersion).toBe('3.0.0');
    expect(result.sidecarVersion).toBe('3.0.0');
    expect(result.executedAt).toBeTruthy();
  });

  it('returns fail verdict when queue bounds are not enforced', async () => {
    const verifier: StateUpdateVerifier = {
      verify: async () => ({
        ...passingMetrics(),
        queueBounds: {
          messageCountBoundEnforced: false,
          byteSizeBoundEnforced: false,
          observedMaxMessageCount: 300,
          observedMaxByteSize: 2_000_000,
        },
      }),
    };

    const input: StateUpdateGateInput = {
      env: TEST_ENV,
      buildHash: 'state-hash-789',
      appVersion: '3.0.0',
      sidecarVersion: '3.0.0',
      stateUpdateVerifier: verifier,
    };

    const result = await evaluateStateUpdateGate(input);
    expect(result.verdict).toBe('fail');
  });

  it('includes raw measurement summary with all sub-test results', async () => {
    const verifier: StateUpdateVerifier = {
      verify: async () => passingMetrics(),
    };

    const input: StateUpdateGateInput = {
      env: TEST_ENV,
      buildHash: 'state-hash-789',
      appVersion: '3.0.0',
      sidecarVersion: '3.0.0',
      stateUpdateVerifier: verifier,
    };

    const result = await evaluateStateUpdateGate(input);
    const summary = JSON.parse(result.rawMeasurementSummary);

    expect(summary.queueBounds.messageCountBoundEnforced).toBe(true);
    expect(summary.queueBounds.byteSizeBoundEnforced).toBe(true);
    expect(summary.revisionAcks.allAcksCorrelated).toBe(true);
    expect(summary.revisionAcks.totalAcksValidated).toBe(500);
    expect(summary.latestValue.geometryLatestValue).toBe(true);
    expect(summary.latestValue.visibilityLatestValue).toBe(true);
    expect(summary.coalescing.onlySupersededCoalesced).toBe(true);
    expect(summary.coalescing.terminalTransitionsPreserved).toBe(true);
    expect(summary.coalescing.errorTransitionsPreserved).toBe(true);
    expect(summary.thresholds.maxQueueMessageCount).toBe(MAX_QUEUE_MESSAGE_COUNT);
    expect(summary.thresholds.maxQueueSizeBytes).toBe(MAX_QUEUE_SIZE_BYTES);
  });

  it('returns fail when terminal transitions not preserved in coalescing', async () => {
    const verifier: StateUpdateVerifier = {
      verify: async () => ({
        ...passingMetrics(),
        coalescing: {
          onlySupersededCoalesced: true,
          terminalTransitionsPreserved: false,
          errorTransitionsPreserved: true,
        },
      }),
    };

    const input: StateUpdateGateInput = {
      env: TEST_ENV,
      buildHash: 'state-hash-789',
      appVersion: '3.0.0',
      sidecarVersion: '3.0.0',
      stateUpdateVerifier: verifier,
    };

    const result = await evaluateStateUpdateGate(input);
    expect(result.verdict).toBe('fail');
  });
});
