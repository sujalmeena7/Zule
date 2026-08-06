/**
 * Stage C Release Gate — Telemetry Schema Gate
 *
 * Verifies rejection of:
 * - Each unknown field
 * - Each field-size overflow
 * - Each count overflow
 * - Each 4,097-byte event (above 4,096-byte limit)
 *
 * Requirement 17.21
 */

import type { EnvironmentMatrixRow, GateResultRecord } from '../types';
import { ReleaseGateId } from '../types';
import {
  validateTelemetryEvent,
  TELEMETRY_COMMON_FIELDS,
  TELEMETRY_REJECTION_FIELDS,
  MAX_MEASUREMENT_ENTRIES,
  MAX_MEASUREMENT_KEY_BYTES,
  type TelemetryEvent,
} from '../../protocol/telemetry';
import { MAX_TELEMETRY_EVENT_BYTES } from '../../protocol/schema';

// ────────────────────────────────────────────────────────────────────
// Schema Limit Definitions (from Req 15.4–15.8)
// ────────────────────────────────────────────────────────────────────

/**
 * Fields with a 64-byte UTF-8 limit.
 */
const FIELDS_64_BYTE_LIMIT: readonly string[] = [
  'eventName',
  'result',
  'failureReason',
  'category',
  'decodedType',
  'appCoreVersion',
  'sidecarVersion',
  'protocolVersion',
  'webView2RuntimeVersion',
] as const;

/**
 * Fields with a 32-byte UTF-8 limit.
 */
const FIELDS_32_BYTE_LIMIT: readonly string[] = [
  'hostStrategy',
  'lifecyclePhase',
  'direction',
  'osBuild',
  'architecture',
] as const;

// ────────────────────────────────────────────────────────────────────
// Telemetry Schema Gate Dependencies
// ────────────────────────────────────────────────────────────────────

/**
 * Injectable dependencies for the telemetry schema gate.
 * Allows testing with alternative validation implementations.
 */
export interface TelemetrySchemaGateDeps {
  /**
   * Validates a telemetry event. Defaults to the production
   * validateTelemetryEvent function.
   */
  validate(event: unknown, isRejectionEvent?: boolean): { valid: boolean };
}

/**
 * Default production dependencies using the real validator.
 */
export function createDefaultTelemetrySchemaGateDeps(): TelemetrySchemaGateDeps {
  return {
    validate: (event: unknown, isRejectionEvent?: boolean) =>
      validateTelemetryEvent(event, isRejectionEvent),
  };
}

// ────────────────────────────────────────────────────────────────────
// Test Case Types
// ────────────────────────────────────────────────────────────────────

/**
 * Categories of schema violation tests.
 */
export type SchemaViolationType =
  | 'unknown_field'
  | 'field_size_overflow'
  | 'count_overflow'
  | 'event_size_overflow';

/**
 * A single schema violation test case.
 */
export interface SchemaTestCase {
  readonly type: SchemaViolationType;
  readonly description: string;
  readonly event: Record<string, unknown>;
  readonly isRejectionEvent: boolean;
}

// ────────────────────────────────────────────────────────────────────
// Test Case Generation
// ────────────────────────────────────────────────────────────────────

/**
 * Creates a minimal valid base event for building test cases upon.
 */
function baseEvent(): Record<string, unknown> {
  return {
    eventName: 'schema_gate_test',
    timestamp: new Date().toISOString(),
    hostStrategy: 'STAGE_C',
  };
}

/**
 * Generates all unknown-field test cases.
 * Each case adds a single field not in the allowlist.
 */
function generateUnknownFieldCases(): readonly SchemaTestCase[] {
  const unknownFields = [
    'secretData',
    'userInput',
    'rawPayload',
    'internalState',
    'debugInfo',
    'stackTrace',
    'credential',
    'apiKey',
    'tokenValue',
    'endpointUrl',
  ];

  return unknownFields.map((field) => ({
    type: 'unknown_field' as const,
    description: `Unknown field '${field}' must be rejected`,
    event: { ...baseEvent(), [field]: 'test_value' },
    isRejectionEvent: false,
  }));
}

/**
 * Generates field-size overflow test cases.
 * Each case sets a valid field to a value exceeding its byte limit.
 */
function generateFieldSizeOverflowCases(): readonly SchemaTestCase[] {
  const cases: SchemaTestCase[] = [];

  // 64-byte limit fields
  for (const field of FIELDS_64_BYTE_LIMIT) {
    // Determine if this is a rejection-only field
    const isRejectionField = new Set(TELEMETRY_REJECTION_FIELDS).has(field);
    const event = { ...baseEvent(), [field]: 'x'.repeat(65) };
    cases.push({
      type: 'field_size_overflow',
      description: `Field '${field}' exceeding 64 UTF-8 bytes must be rejected`,
      event,
      isRejectionEvent: isRejectionField,
    });
  }

  // 32-byte limit fields
  for (const field of FIELDS_32_BYTE_LIMIT) {
    const isRejectionField = new Set(TELEMETRY_REJECTION_FIELDS).has(field);
    const event = { ...baseEvent(), [field]: 'x'.repeat(33) };
    cases.push({
      type: 'field_size_overflow',
      description: `Field '${field}' exceeding 32 UTF-8 bytes must be rejected`,
      event,
      isRejectionEvent: isRejectionField,
    });
  }

  // Measurement key exceeding 64 bytes
  cases.push({
    type: 'field_size_overflow',
    description: `Measurement key exceeding ${MAX_MEASUREMENT_KEY_BYTES} UTF-8 bytes must be rejected`,
    event: {
      ...baseEvent(),
      measurements: { ['k'.repeat(MAX_MEASUREMENT_KEY_BYTES + 1)]: 1 },
    },
    isRejectionEvent: false,
  });

  return cases;
}

/**
 * Generates count overflow test cases.
 * Tests exceeding the measurement entry count limit.
 */
function generateCountOverflowCases(): readonly SchemaTestCase[] {
  // Create measurements object with MAX_MEASUREMENT_ENTRIES + 1 entries
  const measurements: Record<string, number> = {};
  for (let i = 0; i <= MAX_MEASUREMENT_ENTRIES; i++) {
    measurements[`metric_${i}`] = i;
  }

  return [{
    type: 'count_overflow',
    description: `Measurements exceeding ${MAX_MEASUREMENT_ENTRIES} entries must be rejected`,
    event: { ...baseEvent(), measurements },
    isRejectionEvent: false,
  }];
}

/**
 * Generates event-size overflow test cases.
 * Tests an event of exactly 4,097 bytes (above the 4,096-byte limit).
 */
function generateEventSizeOverflowCases(): readonly SchemaTestCase[] {
  // Build an event that serializes to exactly over the limit.
  // The base event with a large 'result' field pushes over 4096 bytes.
  const base = baseEvent();
  const baseSize = Buffer.byteLength(JSON.stringify(base), 'utf-8');
  // We need the total to exceed MAX_TELEMETRY_EVENT_BYTES (4096).
  // Account for the key, quotes, colon, comma in JSON: ,"result":"..."
  const overhead = ',"result":"'.length + '"'.length;
  const targetPayloadSize = MAX_TELEMETRY_EVENT_BYTES - baseSize - overhead + 1;
  const paddedResult = 'A'.repeat(Math.max(targetPayloadSize, 1));

  return [{
    type: 'event_size_overflow',
    description: `Event of ${MAX_TELEMETRY_EVENT_BYTES + 1} bytes (above ${MAX_TELEMETRY_EVENT_BYTES}-byte limit) must be rejected`,
    event: { ...base, result: paddedResult },
    isRejectionEvent: false,
  }];
}

/**
 * Generates the complete set of schema violation test cases.
 */
export function generateAllSchemaTestCases(): readonly SchemaTestCase[] {
  return [
    ...generateUnknownFieldCases(),
    ...generateFieldSizeOverflowCases(),
    ...generateCountOverflowCases(),
    ...generateEventSizeOverflowCases(),
  ];
}

// ────────────────────────────────────────────────────────────────────
// Telemetry Schema Gate Execution
// ────────────────────────────────────────────────────────────────────

/**
 * Result of a single schema test case execution.
 */
export interface SchemaTestCaseResult {
  readonly testCase: SchemaTestCase;
  /** Whether the validator correctly rejected the event */
  readonly correctlyRejected: boolean;
}

/**
 * Executes the telemetry-schema gate for a given environment matrix row.
 *
 * For each schema violation category (per Req 15.4–15.10, 17.21):
 * 1. Unknown fields: each must be rejected
 * 2. Field-size overflows: each field exceeding its byte limit must be rejected
 * 3. Count overflows: measurement entry count exceeding 16 must be rejected
 * 4. Event-size overflow: each 4,097-byte event must be rejected
 *
 * @param row The environment matrix row under test
 * @param deps Injectable dependencies (defaults to production validator)
 * @param buildHash The SHA-256 build hash for evidence binding
 * @param appVersion The App Core version under test
 * @param sidecarVersion The sidecar version under test
 * @returns A complete GateResultRecord
 */
export function executeTelemetrySchemaGate(
  row: EnvironmentMatrixRow,
  deps: TelemetrySchemaGateDeps,
  buildHash: string,
  appVersion: string,
  sidecarVersion: string,
): GateResultRecord {
  const testCases = generateAllSchemaTestCases();
  const results: SchemaTestCaseResult[] = [];
  const failures: string[] = [];

  for (const testCase of testCases) {
    const validationResult = deps.validate(testCase.event, testCase.isRejectionEvent);
    const correctlyRejected = !validationResult.valid;

    results.push({ testCase, correctlyRejected });

    if (!correctlyRejected) {
      failures.push(
        `ACCEPTED when should REJECT (${testCase.type}): ${testCase.description}`,
      );
    }
  }

  const verdict = failures.length === 0 ? 'pass' : 'fail';

  // Build measurement summary
  const summary = {
    totalTestCases: testCases.length,
    unknownFieldCases: results.filter((r) => r.testCase.type === 'unknown_field').length,
    fieldSizeOverflowCases: results.filter((r) => r.testCase.type === 'field_size_overflow').length,
    countOverflowCases: results.filter((r) => r.testCase.type === 'count_overflow').length,
    eventSizeOverflowCases: results.filter((r) => r.testCase.type === 'event_size_overflow').length,
    correctlyRejected: results.filter((r) => r.correctlyRejected).length,
    incorrectlyAccepted: failures.length,
    failures,
  };

  return {
    gateId: ReleaseGateId.TELEMETRY_SCHEMA,
    buildHash,
    osBuild: row.osBuild,
    architecture: row.architecture,
    webView2Version: row.webView2Version,
    appVersion,
    sidecarVersion,
    rawMeasurementSummary: JSON.stringify(summary),
    verdict,
    executedAt: new Date().toISOString(),
  };
}
