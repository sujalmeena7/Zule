/**
 * Unit tests for the Local IPC Security Gate (Req 17.11).
 *
 * Verifies that the gate logic correctly evaluates IPC security test cases
 * using mock executors — no real pipes, native processes, or services.
 */

import { describe, it, expect } from 'vitest';

import {
  IpcAttackVector,
  ALL_IPC_ATTACK_VECTORS,
  IPC_SECURITY_TEST_CASES,
  IPC_MAX_FRAME_BYTES,
  IPC_OVERSIZED_FRAME_BYTES,
  IPC_MAX_REPLAY_CACHE_ENTRIES,
  IPC_OVERFLOW_REPLAY_CACHE_ENTRIES,
  IPC_MAX_QUEUED_MESSAGES,
  IPC_OVERFLOW_QUEUED_MESSAGES,
  IPC_MAX_QUEUED_BYTES,
  IPC_OVERFLOW_QUEUED_BYTES,
  executeIpcSecurityGate,
  buildIpcSecurityGateRecord,
  type IpcSecurityTestExecutor,
  type IpcTestCaseResult,
} from '../ipcSecurityGate';

import { ReleaseGateId } from '../../types';
import type { EnvironmentMatrixRow } from '../../types';

// ────────────────────────────────────────────────────────────────────
// Test Fixtures
// ────────────────────────────────────────────────────────────────────

const TEST_ENV: EnvironmentMatrixRow = {
  osBuild: 'win10_22h2',
  architecture: 'x64',
  webView2Version: '119.0.2151.0',
};

function createPassingResult(vector: IpcAttackVector, rejected: boolean): IpcTestCaseResult {
  return {
    vector,
    passed: true,
    rejected,
    stateMutated: false,
    serviceInvoked: false,
    detail: `Vector ${vector} handled correctly`,
  };
}

function createFailingStateMutationResult(vector: IpcAttackVector): IpcTestCaseResult {
  return {
    vector,
    passed: false,
    rejected: true,
    stateMutated: true,
    serviceInvoked: false,
    detail: `Vector ${vector} caused state mutation`,
  };
}

function createFailingServiceResult(vector: IpcAttackVector): IpcTestCaseResult {
  return {
    vector,
    passed: false,
    rejected: true,
    stateMutated: false,
    serviceInvoked: true,
    detail: `Vector ${vector} caused service invocation`,
  };
}

function createNotRejectedResult(vector: IpcAttackVector): IpcTestCaseResult {
  return {
    vector,
    passed: false,
    rejected: false,
    stateMutated: false,
    serviceInvoked: false,
    detail: `Vector ${vector} was incorrectly accepted`,
  };
}

/**
 * Mock executor that returns correct (passing) results for all attack vectors.
 */
function createAllPassingExecutor(): IpcSecurityTestExecutor {
  return {
    async executeTestCase(vector: IpcAttackVector): Promise<IpcTestCaseResult> {
      // The boundary test (REPLAY_CACHE_AT_BOUND) is accepted, all others rejected
      const isBoundary = vector === IpcAttackVector.REPLAY_CACHE_AT_BOUND;
      return createPassingResult(vector, !isBoundary);
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// Tests: Constants
// ────────────────────────────────────────────────────────────────────

describe('IPC Security Gate — Constants', () => {
  it('encodes exact frame limit boundary values', () => {
    expect(IPC_MAX_FRAME_BYTES).toBe(1_048_576);
    expect(IPC_OVERSIZED_FRAME_BYTES).toBe(1_048_577);
    expect(IPC_OVERSIZED_FRAME_BYTES).toBe(IPC_MAX_FRAME_BYTES + 1);
  });

  it('encodes exact replay cache boundary values', () => {
    expect(IPC_MAX_REPLAY_CACHE_ENTRIES).toBe(4_096);
    expect(IPC_OVERFLOW_REPLAY_CACHE_ENTRIES).toBe(4_097);
    expect(IPC_OVERFLOW_REPLAY_CACHE_ENTRIES).toBe(IPC_MAX_REPLAY_CACHE_ENTRIES + 1);
  });

  it('encodes exact message queue boundary values', () => {
    expect(IPC_MAX_QUEUED_MESSAGES).toBe(256);
    expect(IPC_OVERFLOW_QUEUED_MESSAGES).toBe(257);
    expect(IPC_OVERFLOW_QUEUED_MESSAGES).toBe(IPC_MAX_QUEUED_MESSAGES + 1);
  });

  it('encodes exact queue byte boundary values', () => {
    expect(IPC_MAX_QUEUED_BYTES).toBe(1_048_576);
    expect(IPC_OVERFLOW_QUEUED_BYTES).toBe(1_048_577);
    expect(IPC_OVERFLOW_QUEUED_BYTES).toBe(IPC_MAX_QUEUED_BYTES + 1);
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Attack Vector Coverage
// ────────────────────────────────────────────────────────────────────

describe('IPC Security Gate — Attack Vector Coverage', () => {
  it('enumerates all 17 required attack vectors', () => {
    expect(ALL_IPC_ATTACK_VECTORS).toHaveLength(17);
  });

  it('defines a test case for each attack vector', () => {
    const coveredVectors = IPC_SECURITY_TEST_CASES.map((tc) => tc.vector);
    for (const vector of ALL_IPC_ATTACK_VECTORS) {
      expect(coveredVectors).toContain(vector);
    }
  });

  it('marks all test cases as disallowing state mutation', () => {
    for (const testCase of IPC_SECURITY_TEST_CASES) {
      expect(testCase.allowsStateMutation).toBe(false);
    }
  });

  it('marks all test cases as disallowing service invocation', () => {
    for (const testCase of IPC_SECURITY_TEST_CASES) {
      expect(testCase.allowsServiceInvocation).toBe(false);
    }
  });

  it('has exactly one boundary (accepted) test case for replay cache at limit', () => {
    const boundaryCase = IPC_SECURITY_TEST_CASES.find(
      (tc) => tc.vector === IpcAttackVector.REPLAY_CACHE_AT_BOUND,
    );
    expect(boundaryCase).toBeDefined();
    expect(boundaryCase!.expectation).toBe('accepted_boundary');
  });

  it('marks all other cases as expecting rejection', () => {
    const rejected = IPC_SECURITY_TEST_CASES.filter(
      (tc) => tc.vector !== IpcAttackVector.REPLAY_CACHE_AT_BOUND,
    );
    for (const tc of rejected) {
      expect(tc.expectation).toBe('rejected');
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Gate Execution — Passing
// ────────────────────────────────────────────────────────────────────

describe('IPC Security Gate — Execution (all passing)', () => {
  it('returns pass verdict when all vectors are correctly handled', async () => {
    const result = await executeIpcSecurityGate(TEST_ENV, createAllPassingExecutor());
    expect(result.verdict).toBe('pass');
    expect(result.results).toHaveLength(IPC_SECURITY_TEST_CASES.length);
  });

  it('summary confirms zero mutations and zero invocations', async () => {
    const result = await executeIpcSecurityGate(TEST_ENV, createAllPassingExecutor());
    expect(result.summary).toContain('zero state mutations');
    expect(result.summary).toContain('zero service invocations');
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Gate Execution — Failing (state mutation detected)
// ────────────────────────────────────────────────────────────────────

describe('IPC Security Gate — Execution (state mutation failure)', () => {
  it('returns fail verdict when any vector causes state mutation', async () => {
    const executor: IpcSecurityTestExecutor = {
      async executeTestCase(vector: IpcAttackVector): Promise<IpcTestCaseResult> {
        if (vector === IpcAttackVector.MALFORMED_JSON) {
          return createFailingStateMutationResult(vector);
        }
        const isBoundary = vector === IpcAttackVector.REPLAY_CACHE_AT_BOUND;
        return createPassingResult(vector, !isBoundary);
      },
    };

    const result = await executeIpcSecurityGate(TEST_ENV, executor);
    expect(result.verdict).toBe('fail');
    expect(result.summary).toContain('State mutation detected');
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Gate Execution — Failing (service invocation detected)
// ────────────────────────────────────────────────────────────────────

describe('IPC Security Gate — Execution (service invocation failure)', () => {
  it('returns fail verdict when any vector causes service invocation', async () => {
    const executor: IpcSecurityTestExecutor = {
      async executeTestCase(vector: IpcAttackVector): Promise<IpcTestCaseResult> {
        if (vector === IpcAttackVector.AUTH_FAILURE_WRONG_CREDENTIAL) {
          return createFailingServiceResult(vector);
        }
        const isBoundary = vector === IpcAttackVector.REPLAY_CACHE_AT_BOUND;
        return createPassingResult(vector, !isBoundary);
      },
    };

    const result = await executeIpcSecurityGate(TEST_ENV, executor);
    expect(result.verdict).toBe('fail');
    expect(result.summary).toContain('Service invocation detected');
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Gate Execution — Failing (not rejected)
// ────────────────────────────────────────────────────────────────────

describe('IPC Security Gate — Execution (not rejected failure)', () => {
  it('returns fail verdict when a rejection-expected vector is accepted', async () => {
    const executor: IpcSecurityTestExecutor = {
      async executeTestCase(vector: IpcAttackVector): Promise<IpcTestCaseResult> {
        if (vector === IpcAttackVector.OVERSIZED_FRAME) {
          return createNotRejectedResult(vector);
        }
        const isBoundary = vector === IpcAttackVector.REPLAY_CACHE_AT_BOUND;
        return createPassingResult(vector, !isBoundary);
      },
    };

    const result = await executeIpcSecurityGate(TEST_ENV, executor);
    expect(result.verdict).toBe('fail');
    expect(result.summary).toContain('Expected rejection but message was accepted');
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Gate Execution — Failing (boundary rejected)
// ────────────────────────────────────────────────────────────────────

describe('IPC Security Gate — Execution (boundary incorrectly rejected)', () => {
  it('returns fail verdict when boundary case is incorrectly rejected', async () => {
    const executor: IpcSecurityTestExecutor = {
      async executeTestCase(vector: IpcAttackVector): Promise<IpcTestCaseResult> {
        // All cases rejected, including boundary — boundary should be accepted
        return createPassingResult(vector, true);
      },
    };

    const result = await executeIpcSecurityGate(TEST_ENV, executor);
    expect(result.verdict).toBe('fail');
    expect(result.summary).toContain('Expected acceptance at boundary');
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Gate Result Record
// ────────────────────────────────────────────────────────────────────

describe('IPC Security Gate — Result Record', () => {
  it('builds a correctly-shaped GateResultRecord on pass', async () => {
    const gateResult = await executeIpcSecurityGate(TEST_ENV, createAllPassingExecutor());
    const record = buildIpcSecurityGateRecord(
      gateResult,
      TEST_ENV,
      'abc123def456',
      '1.0.0',
      '1.0.0',
    );

    expect(record.gateId).toBe(ReleaseGateId.IPC_SECURITY);
    expect(record.verdict).toBe('pass');
    expect(record.buildHash).toBe('abc123def456');
    expect(record.osBuild).toBe('win10_22h2');
    expect(record.architecture).toBe('x64');
    expect(record.webView2Version).toBe('119.0.2151.0');
    expect(record.appVersion).toBe('1.0.0');
    expect(record.sidecarVersion).toBe('1.0.0');
    expect(record.rawMeasurementSummary).toContain('zero state mutations');
    expect(record.executedAt).toBeTruthy();
  });

  it('builds a correctly-shaped GateResultRecord on fail', async () => {
    const executor: IpcSecurityTestExecutor = {
      async executeTestCase(vector: IpcAttackVector): Promise<IpcTestCaseResult> {
        return createFailingStateMutationResult(vector);
      },
    };

    const gateResult = await executeIpcSecurityGate(TEST_ENV, executor);
    const record = buildIpcSecurityGateRecord(
      gateResult,
      TEST_ENV,
      'abc123def456',
      '1.0.0',
      '1.0.0',
    );

    expect(record.gateId).toBe(ReleaseGateId.IPC_SECURITY);
    expect(record.verdict).toBe('fail');
  });
});
