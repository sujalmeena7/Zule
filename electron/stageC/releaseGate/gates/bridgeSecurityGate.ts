/**
 * Stage C Release Gate — Bridge Security Gate
 *
 * Verifies that the bridge adapter correctly rejects every unlisted bridge
 * method or event and every 65,537-byte bridge message with zero native
 * side effects.
 *
 * Test vectors (Req 17.12):
 * - Every unlisted bridge method (not in the reviewed 6-method allowlist)
 * - Every unlisted bridge event (not in the reviewed 3-event allowlist)
 * - Every 65,537-byte bridge message (above 65,536-byte limit)
 *
 * All cases must produce zero native side effects.
 *
 * Requirements: 17.12
 */

import type { EnvironmentMatrixRow, GateResultRecord, GateVerdict } from '../types';
import { ReleaseGateId } from '../types';

// ────────────────────────────────────────────────────────────────────
// Boundary Constants
// ────────────────────────────────────────────────────────────────────

/** Maximum bridge message size in bytes. */
export const BRIDGE_MAX_MESSAGE_BYTES = 65_536;

/** Oversized bridge message: exactly 1 byte above the limit. */
export const BRIDGE_OVERSIZED_MESSAGE_BYTES = 65_537;

// ────────────────────────────────────────────────────────────────────
// Reviewed Allowlists (from protocol/bridge.ts)
// ────────────────────────────────────────────────────────────────────

/**
 * The 6 reviewed and allowed bridge methods.
 * Any method NOT in this list MUST be rejected.
 */
export const ALLOWED_BRIDGE_METHODS: readonly string[] = [
  'requestOverlayAction',
  'requestAI',
  'requestAudio',
  'requestScreenCapture',
  'reportDragRegions',
  'reportInteractiveRegions',
] as const;

/**
 * The 3 reviewed and allowed bridge events.
 * Any event NOT in this list MUST be rejected.
 */
export const ALLOWED_BRIDGE_EVENTS: readonly string[] = [
  'onStateSnapshot',
  'onStatePatch',
  'onOperationResult',
] as const;

// ────────────────────────────────────────────────────────────────────
// Bridge Attack Vector Enumeration
// ────────────────────────────────────────────────────────────────────

/** Every bridge attack vector that MUST be rejected per Req 17.12. */
export enum BridgeAttackVector {
  /** Unlisted bridge method — not in the reviewed 6-method allowlist. */
  UNLISTED_METHOD = 'unlisted_method',

  /** Unlisted bridge event — not in the reviewed 3-event allowlist. */
  UNLISTED_EVENT = 'unlisted_event',

  /** Oversized bridge message — 65,537 bytes (above 65,536-byte limit). */
  OVERSIZED_MESSAGE = 'oversized_message',
}

/** All bridge attack vectors for enumeration. */
export const ALL_BRIDGE_ATTACK_VECTORS: readonly BridgeAttackVector[] = Object.values(BridgeAttackVector);

// ────────────────────────────────────────────────────────────────────
// Test Case Definition
// ────────────────────────────────────────────────────────────────────

/** A single bridge security test case. */
export interface BridgeSecurityTestCase {
  /** Which attack vector this case exercises. */
  readonly vector: BridgeAttackVector;

  /** Human-readable description. */
  readonly description: string;

  /** Whether native side effects are allowed (always false). */
  readonly allowsNativeSideEffects: false;
}

/**
 * Complete set of bridge security test cases required by Req 17.12.
 * All cases must be rejected with zero native side effects.
 */
export const BRIDGE_SECURITY_TEST_CASES: readonly BridgeSecurityTestCase[] = [
  {
    vector: BridgeAttackVector.UNLISTED_METHOD,
    description: 'Every unlisted bridge method rejected with zero native side effects',
    allowsNativeSideEffects: false,
  },
  {
    vector: BridgeAttackVector.UNLISTED_EVENT,
    description: 'Every unlisted bridge event rejected with zero native side effects',
    allowsNativeSideEffects: false,
  },
  {
    vector: BridgeAttackVector.OVERSIZED_MESSAGE,
    description: `Every ${BRIDGE_OVERSIZED_MESSAGE_BYTES}-byte bridge message rejected with zero native side effects`,
    allowsNativeSideEffects: false,
  },
];

// ────────────────────────────────────────────────────────────────────
// Unlisted Method/Event Generators
// ────────────────────────────────────────────────────────────────────

/**
 * Generates a set of unlisted bridge method names for testing.
 * These are plausible-looking method names that are NOT in the reviewed allowlist.
 */
export const UNLISTED_METHOD_SAMPLES: readonly string[] = [
  'executeCommand',
  'readFile',
  'writeFile',
  'getCredentials',
  'setCredentials',
  'openDevTools',
  'eval',
  'navigateTo',
  'downloadFile',
  'accessClipboard',
  'readRegistry',
  'spawnProcess',
  'sendNotification',
  'captureScreen',
  'recordAudio',
  'modifySettings',
] as const;

/**
 * Generates a set of unlisted bridge event names for testing.
 * These are plausible-looking event names that are NOT in the reviewed allowlist.
 */
export const UNLISTED_EVENT_SAMPLES: readonly string[] = [
  'onCredentialChange',
  'onFileSystemChange',
  'onNetworkRequest',
  'onProcessSpawn',
  'onRegistryChange',
  'onClipboardChange',
  'onDevToolsOpen',
  'onNavigate',
  'onDownloadComplete',
  'onSystemEvent',
] as const;

// ────────────────────────────────────────────────────────────────────
// Injectable Dependencies
// ────────────────────────────────────────────────────────────────────

/** Result of a single bridge security test case execution. */
export interface BridgeTestCaseResult {
  readonly vector: BridgeAttackVector;
  readonly passed: boolean;
  readonly allRejected: boolean;
  readonly nativeSideEffectDetected: boolean;
  readonly testedItems: number;
  readonly rejectedItems: number;
  readonly detail: string;
}

/**
 * Injectable dependency for executing bridge attack vectors.
 * Abstracts the actual bridge layer so the gate logic can be tested without
 * real WebView2 or native processes.
 */
export interface BridgeSecurityTestExecutor {
  /**
   * Execute a single attack vector and report whether all attempts were
   * properly rejected with zero native side effects.
   */
  executeTestCase(
    vector: BridgeAttackVector,
    env: EnvironmentMatrixRow,
  ): Promise<BridgeTestCaseResult>;
}

// ────────────────────────────────────────────────────────────────────
// Gate Execution
// ────────────────────────────────────────────────────────────────────

/** Result from the complete bridge security gate execution. */
export interface BridgeSecurityGateResult {
  readonly verdict: GateVerdict;
  readonly results: readonly BridgeTestCaseResult[];
  readonly summary: string;
}

/**
 * Executes the Bridge Security Gate (Req 17.12).
 *
 * Runs every specified attack vector against the bridge layer and verifies:
 * 1. Every unlisted method is rejected
 * 2. Every unlisted event is rejected
 * 3. Every 65,537-byte message is rejected
 * 4. Zero native side effects for all cases
 *
 * @param env - The environment matrix row under test
 * @param executor - Injectable bridge test executor
 * @returns Gate result with per-case outcomes and overall verdict
 */
export async function executeBridgeSecurityGate(
  env: EnvironmentMatrixRow,
  executor: BridgeSecurityTestExecutor,
): Promise<BridgeSecurityGateResult> {
  const results: BridgeTestCaseResult[] = [];
  const failures: string[] = [];

  for (const testCase of BRIDGE_SECURITY_TEST_CASES) {
    const result = await executor.executeTestCase(testCase.vector, env);
    results.push(result);

    // Verify zero native side effects for ALL cases
    if (result.nativeSideEffectDetected) {
      failures.push(
        `[${testCase.vector}] Native side effect detected — expected zero side effects`,
      );
    }

    // Verify all items were rejected
    if (!result.allRejected) {
      failures.push(
        `[${testCase.vector}] Not all items rejected: ${result.rejectedItems}/${result.testedItems} rejected`,
      );
    }
  }

  const verdict: GateVerdict = failures.length === 0 ? 'pass' : 'fail';
  const totalTested = results.reduce((sum, r) => sum + r.testedItems, 0);
  const totalRejected = results.reduce((sum, r) => sum + r.rejectedItems, 0);
  const summary =
    verdict === 'pass'
      ? `All ${totalTested} bridge security attempts rejected (${totalRejected}/${totalTested}) with zero native side effects`
      : `${failures.length} failure(s): ${failures.join('; ')}`;

  return { verdict, results, summary };
}

/**
 * Builds a GateResultRecord from the bridge security gate execution.
 */
export function buildBridgeSecurityGateRecord(
  gateResult: BridgeSecurityGateResult,
  env: EnvironmentMatrixRow,
  buildHash: string,
  appVersion: string,
  sidecarVersion: string,
): GateResultRecord {
  return {
    gateId: ReleaseGateId.BRIDGE_SECURITY,
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

// ────────────────────────────────────────────────────────────────────
// Bridge Validation Helpers (pure, no side effects)
// ────────────────────────────────────────────────────────────────────

/**
 * Checks if a bridge method name is in the reviewed allowlist.
 * Returns true only for the exact 6 reviewed methods.
 */
export function isAllowedBridgeMethod(method: string): boolean {
  return (ALLOWED_BRIDGE_METHODS as readonly string[]).includes(method);
}

/**
 * Checks if a bridge event name is in the reviewed allowlist.
 * Returns true only for the exact 3 reviewed events.
 */
export function isAllowedBridgeEvent(event: string): boolean {
  return (ALLOWED_BRIDGE_EVENTS as readonly string[]).includes(event);
}

/**
 * Checks if a bridge message exceeds the 65,536-byte size limit.
 * Uses strict UTF-8 byte length measurement.
 */
export function exceedsBridgeMessageLimit(messageBytes: number): boolean {
  return messageBytes > BRIDGE_MAX_MESSAGE_BYTES;
}

/**
 * Generates a bridge message payload of exactly the specified byte count.
 * Used for boundary testing (65,536 at limit, 65,537 above limit).
 */
export function generateOversizedBridgeMessage(targetBytes: number): string {
  // Build a minimal valid-structure JSON with padding to hit exact byte count
  const prefix = '{"version":1,"method":"requestOverlayAction","action":"';
  const suffix = '"}';
  const overhead = Buffer.byteLength(prefix + suffix, 'utf-8');
  const paddingLength = targetBytes - overhead;

  if (paddingLength <= 0) {
    return prefix + suffix;
  }

  // Use single-byte ASCII characters for exact byte targeting
  const padding = 'x'.repeat(paddingLength);
  return prefix + padding + suffix;
}
