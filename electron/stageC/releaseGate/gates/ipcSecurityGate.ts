/**
 * Stage C Release Gate — Local IPC Security Gate
 *
 * Verifies that the Local IPC layer correctly rejects every specified
 * attack vector with zero App_Core state mutations and zero service invocations.
 *
 * Test vectors (Req 17.11):
 * - Authentication failure (wrong credentials)
 * - Expired credential
 * - Replay attacks
 * - Reversed-direction type (sidecar→controller from controller direction)
 * - Unknown type
 * - Malformed UTF-8
 * - Malformed JSON
 * - Extra field
 * - Missing field
 * - Invalid schema
 * - Invalid revision
 * - Incompatible version
 * - 1,048,577-byte frame (above 1 MiB limit)
 * - Replay-cache bound (4,096/4,097 entries)
 * - 257-message queue (above 256 limit)
 * - 1,048,577-byte queue
 *
 * All cases must produce zero App_Core state mutations and zero service invocations.
 *
 * Requirements: 17.11
 */

import type { EnvironmentMatrixRow, GateResultRecord, GateVerdict } from '../types';
import { ReleaseGateId } from '../types';

// ────────────────────────────────────────────────────────────────────
// Boundary Constants (exact values from protocol/schema.ts)
// ────────────────────────────────────────────────────────────────────

/** Maximum frame size in bytes — frames above this MUST be rejected. */
export const IPC_MAX_FRAME_BYTES = 1_048_576;

/** Oversized frame: exactly 1 byte above the limit. */
export const IPC_OVERSIZED_FRAME_BYTES = 1_048_577;

/** Maximum replay cache entries per launch. */
export const IPC_MAX_REPLAY_CACHE_ENTRIES = 4_096;

/** Replay cache overflow: 1 entry above the limit. */
export const IPC_OVERFLOW_REPLAY_CACHE_ENTRIES = 4_097;

/** Maximum queued messages per connection. */
export const IPC_MAX_QUEUED_MESSAGES = 256;

/** Queue overflow: 1 message above the limit. */
export const IPC_OVERFLOW_QUEUED_MESSAGES = 257;

/** Maximum aggregate queued bytes per connection. */
export const IPC_MAX_QUEUED_BYTES = 1_048_576;

/** Queue byte overflow: 1 byte above the limit. */
export const IPC_OVERFLOW_QUEUED_BYTES = 1_048_577;

// ────────────────────────────────────────────────────────────────────
// IPC Attack Vector Enumeration
// ────────────────────────────────────────────────────────────────────

/** Every IPC attack vector that MUST be rejected per Req 17.11. */
export enum IpcAttackVector {
  /** Authentication failure — wrong credential value. */
  AUTH_FAILURE_WRONG_CREDENTIAL = 'auth_failure_wrong_credential',

  /** Expired credential — presented after launch credential TTL. */
  EXPIRED_CREDENTIAL = 'expired_credential',

  /** Replay attack — duplicate message ID resubmitted. */
  REPLAY_ATTACK = 'replay_attack',

  /** Reversed direction — sidecar→controller type sent from controller. */
  REVERSED_DIRECTION = 'reversed_direction',

  /** Unknown message type — not in any directional allowlist. */
  UNKNOWN_TYPE = 'unknown_type',

  /** Malformed UTF-8 — invalid byte sequence in frame. */
  MALFORMED_UTF8 = 'malformed_utf8',

  /** Malformed JSON — syntactically invalid JSON payload. */
  MALFORMED_JSON = 'malformed_json',

  /** Extra field — payload contains an unlisted field. */
  EXTRA_FIELD = 'extra_field',

  /** Missing field — payload omits a required field. */
  MISSING_FIELD = 'missing_field',

  /** Invalid schema — field type or structure does not match spec. */
  INVALID_SCHEMA = 'invalid_schema',

  /** Invalid revision — negative or non-integer revision number. */
  INVALID_REVISION = 'invalid_revision',

  /** Incompatible version — protocol major version does not match. */
  INCOMPATIBLE_VERSION = 'incompatible_version',

  /** Oversized frame — 1,048,577 bytes (above 1 MiB limit). */
  OVERSIZED_FRAME = 'oversized_frame',

  /** Replay cache at bound — 4,096 entries (boundary, accepted). */
  REPLAY_CACHE_AT_BOUND = 'replay_cache_at_bound',

  /** Replay cache overflow — 4,097 entries (above limit, rejected). */
  REPLAY_CACHE_OVERFLOW = 'replay_cache_overflow',

  /** Message queue overflow — 257 messages (above 256 limit). */
  QUEUE_MESSAGE_OVERFLOW = 'queue_message_overflow',

  /** Queue byte overflow — 1,048,577 bytes (above 1 MiB queue limit). */
  QUEUE_BYTE_OVERFLOW = 'queue_byte_overflow',
}

/** All attack vectors for enumeration. */
export const ALL_IPC_ATTACK_VECTORS: readonly IpcAttackVector[] = Object.values(IpcAttackVector);

// ────────────────────────────────────────────────────────────────────
// Test Case Definition
// ────────────────────────────────────────────────────────────────────

/** Expected outcome for each test case. */
export type IpcTestExpectation = 'rejected' | 'accepted_boundary';

/** A single IPC security test case. */
export interface IpcSecurityTestCase {
  /** Which attack vector this case exercises. */
  readonly vector: IpcAttackVector;

  /** Human-readable description. */
  readonly description: string;

  /** The expected test outcome. */
  readonly expectation: IpcTestExpectation;

  /** Whether App_Core state mutations are allowed (always false). */
  readonly allowsStateMutation: false;

  /** Whether service invocations are allowed (always false). */
  readonly allowsServiceInvocation: false;
}

/**
 * Complete set of IPC security test cases required by Req 17.11.
 * Boundary cases (replay cache at 4,096) are accepted; all overflow
 * and attack cases are rejected.
 */
export const IPC_SECURITY_TEST_CASES: readonly IpcSecurityTestCase[] = [
  {
    vector: IpcAttackVector.AUTH_FAILURE_WRONG_CREDENTIAL,
    description: 'Authentication failure with wrong credential value',
    expectation: 'rejected',
    allowsStateMutation: false,
    allowsServiceInvocation: false,
  },
  {
    vector: IpcAttackVector.EXPIRED_CREDENTIAL,
    description: 'Expired launch credential presented after TTL',
    expectation: 'rejected',
    allowsStateMutation: false,
    allowsServiceInvocation: false,
  },
  {
    vector: IpcAttackVector.REPLAY_ATTACK,
    description: 'Replay attack with duplicate message identifier',
    expectation: 'rejected',
    allowsStateMutation: false,
    allowsServiceInvocation: false,
  },
  {
    vector: IpcAttackVector.REVERSED_DIRECTION,
    description: 'Sidecar→controller type sent from controller direction',
    expectation: 'rejected',
    allowsStateMutation: false,
    allowsServiceInvocation: false,
  },
  {
    vector: IpcAttackVector.UNKNOWN_TYPE,
    description: 'Unknown message type not in any directional allowlist',
    expectation: 'rejected',
    allowsStateMutation: false,
    allowsServiceInvocation: false,
  },
  {
    vector: IpcAttackVector.MALFORMED_UTF8,
    description: 'Malformed UTF-8 byte sequence in frame',
    expectation: 'rejected',
    allowsStateMutation: false,
    allowsServiceInvocation: false,
  },
  {
    vector: IpcAttackVector.MALFORMED_JSON,
    description: 'Syntactically invalid JSON payload',
    expectation: 'rejected',
    allowsStateMutation: false,
    allowsServiceInvocation: false,
  },
  {
    vector: IpcAttackVector.EXTRA_FIELD,
    description: 'Payload contains an unlisted extra field',
    expectation: 'rejected',
    allowsStateMutation: false,
    allowsServiceInvocation: false,
  },
  {
    vector: IpcAttackVector.MISSING_FIELD,
    description: 'Payload omits a required field',
    expectation: 'rejected',
    allowsStateMutation: false,
    allowsServiceInvocation: false,
  },
  {
    vector: IpcAttackVector.INVALID_SCHEMA,
    description: 'Field type or structure does not match exact schema',
    expectation: 'rejected',
    allowsStateMutation: false,
    allowsServiceInvocation: false,
  },
  {
    vector: IpcAttackVector.INVALID_REVISION,
    description: 'Negative or non-integer revision number',
    expectation: 'rejected',
    allowsStateMutation: false,
    allowsServiceInvocation: false,
  },
  {
    vector: IpcAttackVector.INCOMPATIBLE_VERSION,
    description: 'Protocol major version does not match (incompatible)',
    expectation: 'rejected',
    allowsStateMutation: false,
    allowsServiceInvocation: false,
  },
  {
    vector: IpcAttackVector.OVERSIZED_FRAME,
    description: `Frame size ${IPC_OVERSIZED_FRAME_BYTES} bytes exceeds ${IPC_MAX_FRAME_BYTES}-byte limit`,
    expectation: 'rejected',
    allowsStateMutation: false,
    allowsServiceInvocation: false,
  },
  {
    vector: IpcAttackVector.REPLAY_CACHE_AT_BOUND,
    description: `Replay cache at ${IPC_MAX_REPLAY_CACHE_ENTRIES} entries (boundary, accepted)`,
    expectation: 'accepted_boundary',
    allowsStateMutation: false,
    allowsServiceInvocation: false,
  },
  {
    vector: IpcAttackVector.REPLAY_CACHE_OVERFLOW,
    description: `Replay cache at ${IPC_OVERFLOW_REPLAY_CACHE_ENTRIES} entries (overflow, rejected)`,
    expectation: 'rejected',
    allowsStateMutation: false,
    allowsServiceInvocation: false,
  },
  {
    vector: IpcAttackVector.QUEUE_MESSAGE_OVERFLOW,
    description: `Message queue at ${IPC_OVERFLOW_QUEUED_MESSAGES} messages exceeds ${IPC_MAX_QUEUED_MESSAGES} limit`,
    expectation: 'rejected',
    allowsStateMutation: false,
    allowsServiceInvocation: false,
  },
  {
    vector: IpcAttackVector.QUEUE_BYTE_OVERFLOW,
    description: `Queue byte total at ${IPC_OVERFLOW_QUEUED_BYTES} bytes exceeds ${IPC_MAX_QUEUED_BYTES}-byte limit`,
    expectation: 'rejected',
    allowsStateMutation: false,
    allowsServiceInvocation: false,
  },
];

// ────────────────────────────────────────────────────────────────────
// Injectable Dependencies
// ────────────────────────────────────────────────────────────────────

/** Result of a single IPC security test case execution. */
export interface IpcTestCaseResult {
  readonly vector: IpcAttackVector;
  readonly passed: boolean;
  readonly rejected: boolean;
  readonly stateMutated: boolean;
  readonly serviceInvoked: boolean;
  readonly detail: string;
}

/**
 * Injectable dependency for executing IPC attack vectors.
 * Abstracts the actual IPC layer so the gate logic can be tested without
 * real named pipes or native processes.
 */
export interface IpcSecurityTestExecutor {
  /**
   * Execute a single attack vector and report whether it was properly rejected
   * with zero state mutations and zero service invocations.
   */
  executeTestCase(
    vector: IpcAttackVector,
    env: EnvironmentMatrixRow,
  ): Promise<IpcTestCaseResult>;
}

// ────────────────────────────────────────────────────────────────────
// Gate Execution
// ────────────────────────────────────────────────────────────────────

/** Result from the complete IPC security gate execution. */
export interface IpcSecurityGateResult {
  readonly verdict: GateVerdict;
  readonly results: readonly IpcTestCaseResult[];
  readonly summary: string;
}

/**
 * Executes the Local IPC Security Gate (Req 17.11).
 *
 * Runs every specified attack vector against the IPC layer and verifies:
 * 1. Each attack case is properly rejected (or accepted at exact boundary)
 * 2. Zero App_Core state mutations for all cases
 * 3. Zero service invocations for all cases
 *
 * @param env - The environment matrix row under test
 * @param executor - Injectable IPC test executor
 * @returns Gate result with per-case outcomes and overall verdict
 */
export async function executeIpcSecurityGate(
  env: EnvironmentMatrixRow,
  executor: IpcSecurityTestExecutor,
): Promise<IpcSecurityGateResult> {
  const results: IpcTestCaseResult[] = [];
  const failures: string[] = [];

  for (const testCase of IPC_SECURITY_TEST_CASES) {
    const result = await executor.executeTestCase(testCase.vector, env);
    results.push(result);

    // Verify zero state mutations for ALL cases
    if (result.stateMutated) {
      failures.push(
        `[${testCase.vector}] State mutation detected — expected zero mutations`,
      );
    }

    // Verify zero service invocations for ALL cases
    if (result.serviceInvoked) {
      failures.push(
        `[${testCase.vector}] Service invocation detected — expected zero invocations`,
      );
    }

    // Verify expected rejection/acceptance behavior
    if (testCase.expectation === 'rejected') {
      if (!result.rejected) {
        failures.push(
          `[${testCase.vector}] Expected rejection but message was accepted`,
        );
      }
    } else if (testCase.expectation === 'accepted_boundary') {
      if (result.rejected) {
        failures.push(
          `[${testCase.vector}] Expected acceptance at boundary but message was rejected`,
        );
      }
    }
  }

  const verdict: GateVerdict = failures.length === 0 ? 'pass' : 'fail';
  const summary =
    verdict === 'pass'
      ? `All ${IPC_SECURITY_TEST_CASES.length} IPC security vectors verified with zero state mutations and zero service invocations`
      : `${failures.length} failure(s): ${failures.join('; ')}`;

  return { verdict, results, summary };
}

/**
 * Builds a GateResultRecord from the IPC security gate execution.
 */
export function buildIpcSecurityGateRecord(
  gateResult: IpcSecurityGateResult,
  env: EnvironmentMatrixRow,
  buildHash: string,
  appVersion: string,
  sidecarVersion: string,
): GateResultRecord {
  return {
    gateId: ReleaseGateId.IPC_SECURITY,
    buildHash,
    osBuild: env.osBuild,
    architecture: env.architecture,
    webView2Version: env.webView2Version,
    appVersion,
    sidecarVersion,
    rawMeasurementSummary: gateResult.summary,
    verdict: gateResult.verdict,
    executedAt: new Date().toISOString(),
  };
}
