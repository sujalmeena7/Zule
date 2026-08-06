/**
 * Stage C Protocol — Overlay State Projection
 *
 * Defines the OverlayProjection (full snapshot) and OverlayPatch (incremental update)
 * interfaces with strict validation.
 *
 * Requirements: 5.9–5.19, 8.1–8.6
 */

import {
  DipRectangle,
  OverlayMode,
  ValidationResult,
  ValidationError,
  ValidationErrorCode,
  validateDipRectangle,
} from './schema';

// ────────────────────────────────────────────────────────────────────
// Overlay Projection (Full Snapshot)
// ────────────────────────────────────────────────────────────────────

export interface OverlayProjection {
  revision: number;
  visibility_requested: boolean;
  bounds_dip: DipRectangle;
  mode: OverlayMode;
  capture_protection: boolean;
  render_state: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────────────
// Overlay Patch (Incremental Update)
// ────────────────────────────────────────────────────────────────────

export interface OverlayPatch {
  base_revision: number;
  next_revision: number;
  visibility_requested?: boolean;
  bounds_dip?: DipRectangle;
  mode?: OverlayMode;
  capture_protection?: boolean;
  render_state_patch?: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────────────
// Field Specs
// ────────────────────────────────────────────────────────────────────

const PROJECTION_REQUIRED_FIELDS: readonly string[] = [
  'revision',
  'visibility_requested',
  'bounds_dip',
  'mode',
  'capture_protection',
  'render_state',
];

const PATCH_REQUIRED_FIELDS: readonly string[] = [
  'base_revision',
  'next_revision',
];

const PATCH_OPTIONAL_FIELDS: readonly string[] = [
  'visibility_requested',
  'bounds_dip',
  'mode',
  'capture_protection',
  'render_state_patch',
];

const VALID_MODES = new Set<string>(Object.values(OverlayMode));

// ────────────────────────────────────────────────────────────────────
// Validators
// ────────────────────────────────────────────────────────────────────

/**
 * Validates a full OverlayProjection snapshot.
 * Rejects unknown fields, validates types and revision.
 */
export function validateProjection(value: unknown): ValidationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      valid: false,
      errors: [{ code: ValidationErrorCode.INVALID_TYPE, message: 'Projection must be an object' }],
    };
  }

  const obj = value as Record<string, unknown>;
  const errors: ValidationError[] = [];
  const allAllowed = new Set(PROJECTION_REQUIRED_FIELDS);

  // Reject unknown fields
  for (const key of Object.keys(obj)) {
    if (!allAllowed.has(key)) {
      errors.push({
        code: ValidationErrorCode.UNKNOWN_FIELD,
        field: key,
        message: `Unknown field '${key}' in projection`,
      });
    }
  }

  // Check required fields
  for (const field of PROJECTION_REQUIRED_FIELDS) {
    if (!(field in obj)) {
      errors.push({
        code: ValidationErrorCode.MISSING_FIELD,
        field,
        message: `Missing required field '${field}' in projection`,
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Type validation
  if (typeof obj.revision !== 'number' || !Number.isInteger(obj.revision) || (obj.revision as number) < 0) {
    errors.push({
      code: ValidationErrorCode.INVALID_REVISION,
      field: 'revision',
      message: 'revision must be a non-negative integer',
    });
  }

  if (typeof obj.visibility_requested !== 'boolean') {
    errors.push({
      code: ValidationErrorCode.INVALID_TYPE,
      field: 'visibility_requested',
      message: 'visibility_requested must be a boolean',
    });
  }

  // Validate bounds_dip
  const boundsResult = validateDipRectangle(obj.bounds_dip, 'bounds_dip');
  if (!boundsResult.valid) {
    errors.push(...boundsResult.errors);
  }

  if (typeof obj.mode !== 'string' || !VALID_MODES.has(obj.mode as string)) {
    errors.push({
      code: ValidationErrorCode.INVALID_VALUE,
      field: 'mode',
      message: `mode must be one of: ${[...VALID_MODES].join(', ')}`,
    });
  }

  if (typeof obj.capture_protection !== 'boolean') {
    errors.push({
      code: ValidationErrorCode.INVALID_TYPE,
      field: 'capture_protection',
      message: 'capture_protection must be a boolean',
    });
  }

  if (typeof obj.render_state !== 'object' || obj.render_state === null || Array.isArray(obj.render_state)) {
    errors.push({
      code: ValidationErrorCode.INVALID_TYPE,
      field: 'render_state',
      message: 'render_state must be an object',
    });
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

/**
 * Validates an OverlayPatch (incremental update).
 * Requires base_revision and next_revision; rejects unknown fields.
 */
export function validatePatch(value: unknown): ValidationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      valid: false,
      errors: [{ code: ValidationErrorCode.INVALID_TYPE, message: 'Patch must be an object' }],
    };
  }

  const obj = value as Record<string, unknown>;
  const errors: ValidationError[] = [];
  const allAllowed = new Set([...PATCH_REQUIRED_FIELDS, ...PATCH_OPTIONAL_FIELDS]);

  // Reject unknown fields
  for (const key of Object.keys(obj)) {
    if (!allAllowed.has(key)) {
      errors.push({
        code: ValidationErrorCode.UNKNOWN_FIELD,
        field: key,
        message: `Unknown field '${key}' in patch`,
      });
    }
  }

  // Check required fields
  for (const field of PATCH_REQUIRED_FIELDS) {
    if (!(field in obj)) {
      errors.push({
        code: ValidationErrorCode.MISSING_FIELD,
        field,
        message: `Missing required field '${field}' in patch`,
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Type validation for revisions
  if (typeof obj.base_revision !== 'number' || !Number.isInteger(obj.base_revision) || (obj.base_revision as number) < 0) {
    errors.push({
      code: ValidationErrorCode.INVALID_REVISION,
      field: 'base_revision',
      message: 'base_revision must be a non-negative integer',
    });
  }

  if (typeof obj.next_revision !== 'number' || !Number.isInteger(obj.next_revision) || (obj.next_revision as number) < 0) {
    errors.push({
      code: ValidationErrorCode.INVALID_REVISION,
      field: 'next_revision',
      message: 'next_revision must be a non-negative integer',
    });
  }

  // Validate next_revision > base_revision
  if (
    typeof obj.base_revision === 'number' &&
    typeof obj.next_revision === 'number' &&
    (obj.next_revision as number) <= (obj.base_revision as number)
  ) {
    errors.push({
      code: ValidationErrorCode.INVALID_REVISION,
      field: 'next_revision',
      message: 'next_revision must be greater than base_revision',
    });
  }

  // Validate optional fields if present
  if ('visibility_requested' in obj && typeof obj.visibility_requested !== 'boolean') {
    errors.push({
      code: ValidationErrorCode.INVALID_TYPE,
      field: 'visibility_requested',
      message: 'visibility_requested must be a boolean',
    });
  }

  if ('bounds_dip' in obj) {
    const boundsResult = validateDipRectangle(obj.bounds_dip, 'bounds_dip');
    if (!boundsResult.valid) {
      errors.push(...boundsResult.errors);
    }
  }

  if ('mode' in obj && (typeof obj.mode !== 'string' || !VALID_MODES.has(obj.mode as string))) {
    errors.push({
      code: ValidationErrorCode.INVALID_VALUE,
      field: 'mode',
      message: `mode must be one of: ${[...VALID_MODES].join(', ')}`,
    });
  }

  if ('capture_protection' in obj && typeof obj.capture_protection !== 'boolean') {
    errors.push({
      code: ValidationErrorCode.INVALID_TYPE,
      field: 'capture_protection',
      message: 'capture_protection must be a boolean',
    });
  }

  if ('render_state_patch' in obj) {
    if (typeof obj.render_state_patch !== 'object' || obj.render_state_patch === null || Array.isArray(obj.render_state_patch)) {
      errors.push({
        code: ValidationErrorCode.INVALID_TYPE,
        field: 'render_state_patch',
        message: 'render_state_patch must be an object',
      });
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
