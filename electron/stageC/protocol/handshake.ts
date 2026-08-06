/**
 * Stage C Protocol — Ready Handshake Schema
 *
 * Defines the ReadyHandshake interface and validation function.
 * The sidecar sends exactly one ReadyHandshake after initialization.
 *
 * Requirements: 5.4–5.6
 */

import {
  PROTOCOL_MAJOR,
  BRIDGE_SCHEMA_VERSION,
  ValidationResult,
  ValidationError,
  ValidationErrorCode,
} from './schema';

// ────────────────────────────────────────────────────────────────────
// Ready Handshake Interface
// ────────────────────────────────────────────────────────────────────

export interface ReadyHandshake {
  launch_id: string;
  sidecar_version: string;
  protocol_major: number;
  protocol_minor: number;
  bridge_schema_version: number;
  capabilities: string[];
  webview2_runtime_version: string;
}

// ────────────────────────────────────────────────────────────────────
// Field Spec
// ────────────────────────────────────────────────────────────────────

const HANDSHAKE_REQUIRED_FIELDS: readonly string[] = [
  'launch_id',
  'sidecar_version',
  'protocol_major',
  'protocol_minor',
  'bridge_schema_version',
  'capabilities',
  'webview2_runtime_version',
];

// ────────────────────────────────────────────────────────────────────
// Handshake Validation
// ────────────────────────────────────────────────────────────────────

/**
 * Validates a ReadyHandshake payload.
 * Rejects unknown fields, validates types, and checks protocol compatibility.
 */
export function validateHandshake(value: unknown): ValidationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      valid: false,
      errors: [{ code: ValidationErrorCode.INVALID_TYPE, message: 'Handshake must be an object' }],
    };
  }

  const obj = value as Record<string, unknown>;
  const errors: ValidationError[] = [];
  const allowed = new Set(HANDSHAKE_REQUIRED_FIELDS);

  // Reject unknown fields
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      errors.push({
        code: ValidationErrorCode.UNKNOWN_FIELD,
        field: key,
        message: `Unknown field '${key}' in handshake`,
      });
    }
  }

  // Check required fields
  for (const field of HANDSHAKE_REQUIRED_FIELDS) {
    if (!(field in obj)) {
      errors.push({
        code: ValidationErrorCode.MISSING_FIELD,
        field,
        message: `Missing required field '${field}' in handshake`,
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Type validation
  if (typeof obj.launch_id !== 'string' || obj.launch_id.length === 0) {
    errors.push({
      code: ValidationErrorCode.INVALID_TYPE,
      field: 'launch_id',
      message: 'launch_id must be a non-empty string',
    });
  }

  if (typeof obj.sidecar_version !== 'string' || obj.sidecar_version.length === 0) {
    errors.push({
      code: ValidationErrorCode.INVALID_TYPE,
      field: 'sidecar_version',
      message: 'sidecar_version must be a non-empty string',
    });
  }

  if (typeof obj.protocol_major !== 'number' || !Number.isInteger(obj.protocol_major)) {
    errors.push({
      code: ValidationErrorCode.INVALID_TYPE,
      field: 'protocol_major',
      message: 'protocol_major must be an integer',
    });
  }

  if (typeof obj.protocol_minor !== 'number' || !Number.isInteger(obj.protocol_minor)) {
    errors.push({
      code: ValidationErrorCode.INVALID_TYPE,
      field: 'protocol_minor',
      message: 'protocol_minor must be an integer',
    });
  }

  if (typeof obj.bridge_schema_version !== 'number' || !Number.isInteger(obj.bridge_schema_version)) {
    errors.push({
      code: ValidationErrorCode.INVALID_TYPE,
      field: 'bridge_schema_version',
      message: 'bridge_schema_version must be an integer',
    });
  }

  if (!Array.isArray(obj.capabilities)) {
    errors.push({
      code: ValidationErrorCode.INVALID_TYPE,
      field: 'capabilities',
      message: 'capabilities must be an array',
    });
  } else {
    for (let i = 0; i < obj.capabilities.length; i++) {
      if (typeof obj.capabilities[i] !== 'string') {
        errors.push({
          code: ValidationErrorCode.INVALID_TYPE,
          field: `capabilities[${i}]`,
          message: `capabilities[${i}] must be a string`,
        });
      }
    }
  }

  if (typeof obj.webview2_runtime_version !== 'string' || obj.webview2_runtime_version.length === 0) {
    errors.push({
      code: ValidationErrorCode.INVALID_TYPE,
      field: 'webview2_runtime_version',
      message: 'webview2_runtime_version must be a non-empty string',
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Protocol compatibility check
  if ((obj.protocol_major as number) !== PROTOCOL_MAJOR) {
    errors.push({
      code: ValidationErrorCode.INCOMPATIBLE_PROTOCOL,
      field: 'protocol_major',
      message: `Protocol major ${obj.protocol_major} is incompatible with expected ${PROTOCOL_MAJOR}`,
    });
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

/**
 * Verifies the handshake against controller expectations.
 * Checks launch_id, protocol, bridge schema, and required capabilities.
 */
export function verifyHandshake(
  handshake: ReadyHandshake,
  expectedLaunchId: string,
  requiredCapabilities: string[],
): ValidationResult {
  const errors: ValidationError[] = [];

  if (handshake.launch_id !== expectedLaunchId) {
    errors.push({
      code: ValidationErrorCode.INVALID_VALUE,
      field: 'launch_id',
      message: 'launch_id does not match expected launch identifier',
    });
  }

  if (handshake.protocol_major !== PROTOCOL_MAJOR) {
    errors.push({
      code: ValidationErrorCode.INCOMPATIBLE_PROTOCOL,
      field: 'protocol_major',
      message: `Protocol major ${handshake.protocol_major} is incompatible`,
    });
  }

  if (handshake.bridge_schema_version !== BRIDGE_SCHEMA_VERSION) {
    errors.push({
      code: ValidationErrorCode.INCOMPATIBLE_PROTOCOL,
      field: 'bridge_schema_version',
      message: `Bridge schema version ${handshake.bridge_schema_version} is incompatible with expected ${BRIDGE_SCHEMA_VERSION}`,
    });
  }

  const providedCaps = new Set(handshake.capabilities);
  for (const required of requiredCapabilities) {
    if (!providedCaps.has(required)) {
      errors.push({
        code: ValidationErrorCode.INVALID_VALUE,
        field: 'capabilities',
        message: `Missing required capability: ${required}`,
      });
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
