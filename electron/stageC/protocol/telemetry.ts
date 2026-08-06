/**
 * Stage C Protocol — Telemetry Event Schema
 *
 * Defines the content-free telemetry event model with exact field allowlists,
 * field/count/value/size bounds, and canary exclusion enforcement.
 *
 * Requirements: 15.1–15.12
 */

import {
  MAX_TELEMETRY_EVENT_BYTES,
  ValidationResult,
  ValidationError,
  ValidationErrorCode,
} from './schema';

// ────────────────────────────────────────────────────────────────────
// Field Allowlists and Limits
// ────────────────────────────────────────────────────────────────────

/** Common fields permitted on all telemetry events (Req 15.1). */
export const TELEMETRY_COMMON_FIELDS: readonly string[] = [
  'eventName',
  'timestamp',
  'hostStrategy',
  'lifecyclePhase',
  'durationMs',
  'result',
  'failureReason',
  'measurements',
  'osBuild',
  'architecture',
  'appCoreVersion',
  'sidecarVersion',
  'protocolVersion',
  'webView2RuntimeVersion',
];

/** Additional fields permitted only on protocol-rejection events (Req 15.2). */
export const TELEMETRY_REJECTION_FIELDS: readonly string[] = [
  'category',
  'direction',
  'decodedType',
  'byteCount',
];

/** All valid telemetry fields (common + rejection-specific). */
export const ALL_TELEMETRY_FIELDS: ReadonlySet<string> = new Set([
  ...TELEMETRY_COMMON_FIELDS,
  ...TELEMETRY_REJECTION_FIELDS,
]);

/** Fields required on every event. */
export const TELEMETRY_REQUIRED_FIELDS: readonly string[] = [
  'eventName',
  'timestamp',
];

// ────────────────────────────────────────────────────────────────────
// Field Size Limits (Req 15.4–15.7)
// ────────────────────────────────────────────────────────────────────

/** Max 64 UTF-8 bytes (Req 15.4). */
const LIMIT_64_FIELDS: ReadonlySet<string> = new Set([
  'eventName',
  'result',
  'failureReason',
  'category',
  'decodedType',
]);

/** Max 32 UTF-8 bytes (Req 15.5). */
const LIMIT_32_FIELDS: ReadonlySet<string> = new Set([
  'hostStrategy',
  'lifecyclePhase',
  'direction',
  'osBuild',
  'architecture',
]);

/** Max 64 UTF-8 bytes for version fields (Req 15.6). */
const LIMIT_64_VERSION_FIELDS: ReadonlySet<string> = new Set([
  'appCoreVersion',
  'sidecarVersion',
  'protocolVersion',
  'webView2RuntimeVersion',
]);

/** Maximum measurement entries (Req 15.7). */
export const MAX_MEASUREMENT_ENTRIES = 16;

/** Maximum measurement key length in UTF-8 bytes (Req 15.7). */
export const MAX_MEASUREMENT_KEY_BYTES = 64;

// ────────────────────────────────────────────────────────────────────
// Canary/Content Exclusion Patterns (Req 15.11)
// ────────────────────────────────────────────────────────────────────

/**
 * Patterns that should never appear in telemetry event values.
 * These are checked against all string values in the event.
 */
export const CANARY_EXCLUSION_PATTERNS: readonly RegExp[] = [
  // Launch credentials / pipe names
  /\\\\\.\\pipe\\/i,
  /[0-9a-f]{32,}/i,
  // Provider keys / tokens
  /sk-[a-zA-Z0-9]{20,}/,
  /Bearer\s+/i,
  // User content patterns
  /\n.*\n.*\n/,     // Multi-line content (likely transcript/prompt)
  // File paths (absolute Windows paths — both raw and JSON-escaped)
  /[A-Z]:\\/,
  // Base64 blobs (likely binary data like screenshots/audio)
  /[A-Za-z0-9+/]{100,}={0,2}/,
];

// ────────────────────────────────────────────────────────────────────
// Telemetry Event Interface
// ────────────────────────────────────────────────────────────────────

export interface TelemetryEvent {
  eventName: string;
  timestamp: string;
  hostStrategy?: string;
  lifecyclePhase?: string;
  durationMs?: number;
  result?: string;
  failureReason?: string;
  measurements?: Record<string, number>;
  osBuild?: string;
  architecture?: string;
  appCoreVersion?: string;
  sidecarVersion?: string;
  protocolVersion?: string;
  webView2RuntimeVersion?: string;
  // Rejection-only fields
  category?: string;
  direction?: string;
  decodedType?: string;
  byteCount?: number;
}

// ────────────────────────────────────────────────────────────────────
// Validators
// ────────────────────────────────────────────────────────────────────

/**
 * Validates an RFC 3339 UTC timestamp string (Req 15.3).
 */
function isValidRfc3339Utc(value: string): boolean {
  // Must end with Z for UTC
  if (!value.endsWith('Z')) return false;
  const d = new Date(value);
  if (isNaN(d.getTime())) return false;
  // Verify it round-trips correctly
  return d.toISOString() === value || !isNaN(Date.parse(value));
}

/**
 * Validates UTF-8 byte length of a string field.
 */
function fieldByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf-8');
}

/**
 * Checks all string values in the event for canary exclusion patterns.
 */
function checkCanaryExclusion(obj: Record<string, unknown>): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      for (const pattern of CANARY_EXCLUSION_PATTERNS) {
        if (pattern.test(value)) {
          errors.push({
            code: ValidationErrorCode.INVALID_VALUE,
            field: key,
            message: `Field '${key}' contains prohibited content pattern`,
          });
          break;
        }
      }
    }
  }

  return errors;
}

/**
 * Validates a complete telemetry event.
 * Enforces field allowlist, size limits, type checks, canary exclusion,
 * and total serialized event size.
 *
 * @param isRejectionEvent Whether this event is a protocol-rejection event
 */
export function validateTelemetryEvent(
  value: unknown,
  isRejectionEvent = false,
): ValidationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      valid: false,
      errors: [{ code: ValidationErrorCode.INVALID_TYPE, message: 'Telemetry event must be an object' }],
    };
  }

  const obj = value as Record<string, unknown>;
  const errors: ValidationError[] = [];
  const allowedFields = isRejectionEvent
    ? ALL_TELEMETRY_FIELDS
    : new Set(TELEMETRY_COMMON_FIELDS);

  // Reject unknown fields
  for (const key of Object.keys(obj)) {
    if (!allowedFields.has(key)) {
      errors.push({
        code: ValidationErrorCode.UNKNOWN_FIELD,
        field: key,
        message: `Unknown telemetry field '${key}'`,
      });
    }
  }

  // Check rejection-only fields are not present on non-rejection events
  if (!isRejectionEvent) {
    for (const field of TELEMETRY_REJECTION_FIELDS) {
      if (field in obj) {
        errors.push({
          code: ValidationErrorCode.UNKNOWN_FIELD,
          field,
          message: `Field '${field}' is only permitted on protocol-rejection events`,
        });
      }
    }
  }

  // Check required fields
  for (const field of TELEMETRY_REQUIRED_FIELDS) {
    if (!(field in obj)) {
      errors.push({
        code: ValidationErrorCode.MISSING_FIELD,
        field,
        message: `Missing required field '${field}'`,
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Validate eventName
  if (typeof obj.eventName !== 'string' || obj.eventName.length === 0) {
    errors.push({
      code: ValidationErrorCode.INVALID_TYPE,
      field: 'eventName',
      message: 'eventName must be a non-empty string',
    });
  }

  // Validate timestamp (Req 15.3)
  if (typeof obj.timestamp !== 'string' || !isValidRfc3339Utc(obj.timestamp as string)) {
    errors.push({
      code: ValidationErrorCode.INVALID_VALUE,
      field: 'timestamp',
      message: 'timestamp must be an RFC 3339 UTC value',
    });
  }

  // Validate field byte limits
  for (const field of LIMIT_64_FIELDS) {
    if (field in obj) {
      if (typeof obj[field] !== 'string') {
        errors.push({ code: ValidationErrorCode.INVALID_TYPE, field, message: `${field} must be a string` });
      } else if (fieldByteLength(obj[field] as string) > 64) {
        errors.push({ code: ValidationErrorCode.SIZE_EXCEEDED, field, message: `${field} exceeds 64 UTF-8 bytes` });
      }
    }
  }

  for (const field of LIMIT_32_FIELDS) {
    if (field in obj) {
      if (typeof obj[field] !== 'string') {
        errors.push({ code: ValidationErrorCode.INVALID_TYPE, field, message: `${field} must be a string` });
      } else if (fieldByteLength(obj[field] as string) > 32) {
        errors.push({ code: ValidationErrorCode.SIZE_EXCEEDED, field, message: `${field} exceeds 32 UTF-8 bytes` });
      }
    }
  }

  for (const field of LIMIT_64_VERSION_FIELDS) {
    if (field in obj) {
      if (typeof obj[field] !== 'string') {
        errors.push({ code: ValidationErrorCode.INVALID_TYPE, field, message: `${field} must be a string` });
      } else if (fieldByteLength(obj[field] as string) > 64) {
        errors.push({ code: ValidationErrorCode.SIZE_EXCEEDED, field, message: `${field} exceeds 64 UTF-8 bytes` });
      }
    }
  }

  // Validate numeric fields are finite non-negative (Req 15.3)
  if ('durationMs' in obj) {
    if (typeof obj.durationMs !== 'number' || !Number.isFinite(obj.durationMs as number) || (obj.durationMs as number) < 0) {
      errors.push({
        code: ValidationErrorCode.INVALID_VALUE,
        field: 'durationMs',
        message: 'durationMs must be a finite non-negative number',
      });
    }
  }

  if ('byteCount' in obj) {
    if (typeof obj.byteCount !== 'number' || !Number.isFinite(obj.byteCount as number) || (obj.byteCount as number) < 0) {
      errors.push({
        code: ValidationErrorCode.INVALID_VALUE,
        field: 'byteCount',
        message: 'byteCount must be a finite non-negative number',
      });
    }
  }

  // Validate measurements (Req 15.7)
  if ('measurements' in obj) {
    if (typeof obj.measurements !== 'object' || obj.measurements === null || Array.isArray(obj.measurements)) {
      errors.push({
        code: ValidationErrorCode.INVALID_TYPE,
        field: 'measurements',
        message: 'measurements must be an object',
      });
    } else {
      const measurements = obj.measurements as Record<string, unknown>;
      const entries = Object.entries(measurements);

      if (entries.length > MAX_MEASUREMENT_ENTRIES) {
        errors.push({
          code: ValidationErrorCode.SIZE_EXCEEDED,
          field: 'measurements',
          message: `measurements has ${entries.length} entries, maximum is ${MAX_MEASUREMENT_ENTRIES}`,
        });
      }

      for (const [key, val] of entries) {
        if (fieldByteLength(key) > MAX_MEASUREMENT_KEY_BYTES) {
          errors.push({
            code: ValidationErrorCode.SIZE_EXCEEDED,
            field: `measurements.${key}`,
            message: `Measurement key '${key}' exceeds ${MAX_MEASUREMENT_KEY_BYTES} UTF-8 bytes`,
          });
        }
        if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) {
          errors.push({
            code: ValidationErrorCode.INVALID_VALUE,
            field: `measurements.${key}`,
            message: `Measurement value for '${key}' must be a finite non-negative number`,
          });
        }
      }
    }
  }

  // Canary exclusion check (Req 15.11)
  const canaryErrors = checkCanaryExclusion(obj);
  errors.push(...canaryErrors);

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Total serialized event size (Req 15.8)
  const serialized = JSON.stringify(obj);
  const totalBytes = Buffer.byteLength(serialized, 'utf-8');
  if (totalBytes > MAX_TELEMETRY_EVENT_BYTES) {
    return {
      valid: false,
      errors: [{
        code: ValidationErrorCode.SIZE_EXCEEDED,
        message: `Telemetry event (${totalBytes} bytes) exceeds maximum ${MAX_TELEMETRY_EVENT_BYTES} bytes`,
      }],
    };
  }

  return { valid: true };
}
