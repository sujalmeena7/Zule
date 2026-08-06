/**
 * Unit tests for the Bridge Security Gate (Req 17.12).
 *
 * Verifies that the gate logic correctly evaluates bridge security test cases
 * using mock executors — no real WebView2, native processes, or side effects.
 */

import { describe, it, expect } from 'vitest';

import {
  BridgeAttackVector,
  ALL_BRIDGE_ATTACK_VECTORS,
  BRIDGE_SECURITY_TEST_CASES,
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_OVERSIZED_MESSAGE_BYTES,
  ALLOWED_BRIDGE_METHODS,
  ALLOWED_BRIDGE_EVENTS,
  UNLISTED_METHOD_SAMPLES,
  UNLISTED_EVENT_SAMPLES,
  executeBridgeSecurityGate,
  buildBridgeSecurityGateRecord,
  isAllowedBridgeMethod,
  isAllowedBridgeEvent,
  exceedsBridgeMessageLimit,
  generateOversizedBridgeMessage,
  type BridgeSecurityTestExecutor,
  type BridgeTestCaseResult,
} from '../bridgeSecurityGate';

import { ReleaseGateId } from '../../types';
import type { EnvironmentMatrixRow } from '../../types';

// ────────────────────────────────────────────────────────────────────
// Test Fixtures
// ────────────────────────────────────────────────────────────────────

const TEST_ENV: EnvironmentMatrixRow = {
  osBuild: 'win11_23h2',
  architecture: 'x64',
  webView2Version: '120.0.2210.0',
};

function createPassingResult(vector: BridgeAttackVector, testedItems: number): BridgeTestCaseResult {
  return {
    vector,
    passed: true,
    allRejected: true,
    nativeSideEffectDetected: false,
    testedItems,
    rejectedItems: testedItems,
    detail: `All ${testedItems} items correctly rejected`,
  };
}

function createSideEffectResult(vector: BridgeAttackVector): BridgeTestCaseResult {
  return {
    vector,
    passed: false,
    allRejected: true,
    nativeSideEffectDetected: true,
    testedItems: 1,
    rejectedItems: 1,
    detail: 'Native side effect detected during rejection',
  };
}

function createNotFullyRejectedResult(vector: BridgeAttackVector): BridgeTestCaseResult {
  return {
    vector,
    passed: false,
    allRejected: false,
    nativeSideEffectDetected: false,
    testedItems: 10,
    rejectedItems: 8,
    detail: '2 items were incorrectly accepted',
  };
}

/**
 * Mock executor that returns correct (passing) results for all attack vectors.
 */
function createAllPassingExecutor(): BridgeSecurityTestExecutor {
  return {
    async executeTestCase(vector: BridgeAttackVector): Promise<BridgeTestCaseResult> {
      switch (vector) {
        case BridgeAttackVector.UNLISTED_METHOD:
          return createPassingResult(vector, UNLISTED_METHOD_SAMPLES.length);
        case BridgeAttackVector.UNLISTED_EVENT:
          return createPassingResult(vector, UNLISTED_EVENT_SAMPLES.length);
        case BridgeAttackVector.OVERSIZED_MESSAGE:
          return createPassingResult(vector, 1);
      }
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// Tests: Constants
// ────────────────────────────────────────────────────────────────────

describe('Bridge Security Gate — Constants', () => {
  it('encodes exact bridge message limit boundary values', () => {
    expect(BRIDGE_MAX_MESSAGE_BYTES).toBe(65_536);
    expect(BRIDGE_OVERSIZED_MESSAGE_BYTES).toBe(65_537);
    expect(BRIDGE_OVERSIZED_MESSAGE_BYTES).toBe(BRIDGE_MAX_MESSAGE_BYTES + 1);
  });

  it('defines exactly 6 allowed bridge methods', () => {
    expect(ALLOWED_BRIDGE_METHODS).toHaveLength(6);
  });

  it('defines exactly 3 allowed bridge events', () => {
    expect(ALLOWED_BRIDGE_EVENTS).toHaveLength(3);
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Allowlist Validation Helpers
// ────────────────────────────────────────────────────────────────────

describe('Bridge Security Gate — Allowlist Helpers', () => {
  it('accepts all 6 reviewed bridge methods', () => {
    for (const method of ALLOWED_BRIDGE_METHODS) {
      expect(isAllowedBridgeMethod(method)).toBe(true);
    }
  });

  it('rejects every unlisted method sample', () => {
    for (const method of UNLISTED_METHOD_SAMPLES) {
      expect(isAllowedBridgeMethod(method)).toBe(false);
    }
  });

  it('accepts all 3 reviewed bridge events', () => {
    for (const event of ALLOWED_BRIDGE_EVENTS) {
      expect(isAllowedBridgeEvent(event)).toBe(true);
    }
  });

  it('rejects every unlisted event sample', () => {
    for (const event of UNLISTED_EVENT_SAMPLES) {
      expect(isAllowedBridgeEvent(event)).toBe(false);
    }
  });

  it('rejects message at exactly 65,537 bytes', () => {
    expect(exceedsBridgeMessageLimit(BRIDGE_OVERSIZED_MESSAGE_BYTES)).toBe(true);
  });

  it('accepts message at exactly 65,536 bytes', () => {
    expect(exceedsBridgeMessageLimit(BRIDGE_MAX_MESSAGE_BYTES)).toBe(false);
  });

  it('accepts message below the limit', () => {
    expect(exceedsBridgeMessageLimit(1000)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Oversized Message Generator
// ────────────────────────────────────────────────────────────────────

describe('Bridge Security Gate — Oversized Message Generator', () => {
  it('generates a message of exactly the target byte length', () => {
    const message = generateOversizedBridgeMessage(BRIDGE_OVERSIZED_MESSAGE_BYTES);
    const actualBytes = Buffer.byteLength(message, 'utf-8');
    expect(actualBytes).toBe(BRIDGE_OVERSIZED_MESSAGE_BYTES);
  });

  it('generates a valid JSON structure', () => {
    const message = generateOversizedBridgeMessage(BRIDGE_OVERSIZED_MESSAGE_BYTES);
    expect(() => JSON.parse(message)).not.toThrow();
  });

  it('generates a message at the exact boundary', () => {
    const message = generateOversizedBridgeMessage(BRIDGE_MAX_MESSAGE_BYTES);
    const actualBytes = Buffer.byteLength(message, 'utf-8');
    expect(actualBytes).toBe(BRIDGE_MAX_MESSAGE_BYTES);
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Attack Vector Coverage
// ────────────────────────────────────────────────────────────────────

describe('Bridge Security Gate — Attack Vector Coverage', () => {
  it('enumerates all 3 required attack vectors', () => {
    expect(ALL_BRIDGE_ATTACK_VECTORS).toHaveLength(3);
  });

  it('defines a test case for each attack vector', () => {
    const coveredVectors = BRIDGE_SECURITY_TEST_CASES.map((tc) => tc.vector);
    for (const vector of ALL_BRIDGE_ATTACK_VECTORS) {
      expect(coveredVectors).toContain(vector);
    }
  });

  it('marks all test cases as disallowing native side effects', () => {
    for (const testCase of BRIDGE_SECURITY_TEST_CASES) {
      expect(testCase.allowsNativeSideEffects).toBe(false);
    }
  });

  it('unlisted method samples do not overlap with allowed methods', () => {
    for (const sample of UNLISTED_METHOD_SAMPLES) {
      expect(ALLOWED_BRIDGE_METHODS).not.toContain(sample);
    }
  });

  it('unlisted event samples do not overlap with allowed events', () => {
    for (const sample of UNLISTED_EVENT_SAMPLES) {
      expect(ALLOWED_BRIDGE_EVENTS).not.toContain(sample);
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Gate Execution — Passing
// ────────────────────────────────────────────────────────────────────

describe('Bridge Security Gate — Execution (all passing)', () => {
  it('returns pass verdict when all vectors are correctly handled', async () => {
    const result = await executeBridgeSecurityGate(TEST_ENV, createAllPassingExecutor());
    expect(result.verdict).toBe('pass');
    expect(result.results).toHaveLength(BRIDGE_SECURITY_TEST_CASES.length);
  });

  it('summary confirms zero native side effects', async () => {
    const result = await executeBridgeSecurityGate(TEST_ENV, createAllPassingExecutor());
    expect(result.summary).toContain('zero native side effects');
  });

  it('counts total tested items correctly', async () => {
    const result = await executeBridgeSecurityGate(TEST_ENV, createAllPassingExecutor());
    const expectedTotal =
      UNLISTED_METHOD_SAMPLES.length + UNLISTED_EVENT_SAMPLES.length + 1;
    expect(result.summary).toContain(`${expectedTotal} bridge security attempts rejected`);
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Gate Execution — Failing (native side effects)
// ────────────────────────────────────────────────────────────────────

describe('Bridge Security Gate — Execution (native side effect failure)', () => {
  it('returns fail verdict when any vector causes native side effects', async () => {
    const executor: BridgeSecurityTestExecutor = {
      async executeTestCase(vector: BridgeAttackVector): Promise<BridgeTestCaseResult> {
        if (vector === BridgeAttackVector.UNLISTED_METHOD) {
          return createSideEffectResult(vector);
        }
        return createPassingResult(vector, 5);
      },
    };

    const result = await executeBridgeSecurityGate(TEST_ENV, executor);
    expect(result.verdict).toBe('fail');
    expect(result.summary).toContain('Native side effect detected');
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Gate Execution — Failing (not all rejected)
// ────────────────────────────────────────────────────────────────────

describe('Bridge Security Gate — Execution (not all rejected failure)', () => {
  it('returns fail verdict when not all items are rejected', async () => {
    const executor: BridgeSecurityTestExecutor = {
      async executeTestCase(vector: BridgeAttackVector): Promise<BridgeTestCaseResult> {
        if (vector === BridgeAttackVector.OVERSIZED_MESSAGE) {
          return createNotFullyRejectedResult(vector);
        }
        return createPassingResult(vector, 5);
      },
    };

    const result = await executeBridgeSecurityGate(TEST_ENV, executor);
    expect(result.verdict).toBe('fail');
    expect(result.summary).toContain('Not all items rejected');
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Gate Result Record
// ────────────────────────────────────────────────────────────────────

describe('Bridge Security Gate — Result Record', () => {
  it('builds a correctly-shaped GateResultRecord on pass', async () => {
    const gateResult = await executeBridgeSecurityGate(TEST_ENV, createAllPassingExecutor());
    const record = buildBridgeSecurityGateRecord(
      gateResult,
      TEST_ENV,
      'deadbeef1234',
      '2.0.0',
      '2.0.0',
    );

    expect(record.gateId).toBe(ReleaseGateId.BRIDGE_SECURITY);
    expect(record.verdict).toBe('pass');
    expect(record.buildHash).toBe('deadbeef1234');
    expect(record.osBuild).toBe('win11_23h2');
    expect(record.architecture).toBe('x64');
    expect(record.webView2Version).toBe('120.0.2210.0');
    expect(record.appVersion).toBe('2.0.0');
    expect(record.sidecarVersion).toBe('2.0.0');
    expect(record.rawMeasurementSummary).toContain('zero native side effects');
    expect(record.executedAt).toBeTruthy();
  });

  it('builds a correctly-shaped GateResultRecord on fail', async () => {
    const executor: BridgeSecurityTestExecutor = {
      async executeTestCase(vector: BridgeAttackVector): Promise<BridgeTestCaseResult> {
        return createSideEffectResult(vector);
      },
    };

    const gateResult = await executeBridgeSecurityGate(TEST_ENV, executor);
    const record = buildBridgeSecurityGateRecord(
      gateResult,
      TEST_ENV,
      'deadbeef1234',
      '2.0.0',
      '2.0.0',
    );

    expect(record.gateId).toBe(ReleaseGateId.BRIDGE_SECURITY);
    expect(record.verdict).toBe('fail');
  });
});
