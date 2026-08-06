/**
 * Stage C Protocol — Bridge Adapter Message Schemas
 *
 * Defines the exact schemas for the 6 reviewed methods and 3 events
 * exposed through `window.zuleOverlay`. Enforces the 65,536-byte size limit
 * and exact field validation.
 *
 * Requirements: 7.1–7.10
 */

import {
  MAX_BRIDGE_MESSAGE_BYTES,
  ValidationResult,
  ValidationError,
  ValidationErrorCode,
} from './schema';

// ────────────────────────────────────────────────────────────────────
// Bridge Method Types (WebView2 → Sidecar)
// ────────────────────────────────────────────────────────────────────

export enum BridgeMethodType {
  REQUEST_OVERLAY_ACTION = 'requestOverlayAction',
  REQUEST_AI = 'requestAI',
  REQUEST_AUDIO = 'requestAudio',
  REQUEST_SCREEN_CAPTURE = 'requestScreenCapture',
  REPORT_DRAG_REGIONS = 'reportDragRegions',
  REPORT_INTERACTIVE_REGIONS = 'reportInteractiveRegions',
}

// ────────────────────────────────────────────────────────────────────
// Bridge Event Types (Sidecar → WebView2)
// ────────────────────────────────────────────────────────────────────

export enum BridgeEventType {
  ON_STATE_SNAPSHOT = 'onStateSnapshot',
  ON_STATE_PATCH = 'onStatePatch',
  ON_OPERATION_RESULT = 'onOperationResult',
}

// ────────────────────────────────────────────────────────────────────
// Bridge Message Interfaces — Exact fields
// ────────────────────────────────────────────────────────────────────

export interface BridgeRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface BridgeMethodBase {
  version: number;
  method: BridgeMethodType;
}

export interface RequestOverlayActionMessage extends BridgeMethodBase {
  method: BridgeMethodType.REQUEST_OVERLAY_ACTION;
  action: string;
  parameters?: Record<string, unknown>;
}

export interface RequestAIMessage extends BridgeMethodBase {
  method: BridgeMethodType.REQUEST_AI;
  action: string;
  parameters?: Record<string, unknown>;
}

export interface RequestAudioMessage extends BridgeMethodBase {
  method: BridgeMethodType.REQUEST_AUDIO;
  action: string;
  parameters?: Record<string, unknown>;
}

export interface RequestScreenCaptureMessage extends BridgeMethodBase {
  method: BridgeMethodType.REQUEST_SCREEN_CAPTURE;
  action: string;
  parameters?: Record<string, unknown>;
}

export interface ReportDragRegionsMessage extends BridgeMethodBase {
  method: BridgeMethodType.REPORT_DRAG_REGIONS;
  revision: number;
  regions: BridgeRegion[];
}

export interface ReportInteractiveRegionsMessage extends BridgeMethodBase {
  method: BridgeMethodType.REPORT_INTERACTIVE_REGIONS;
  revision: number;
  regions: BridgeRegion[];
}

export type BridgeMethodMessage =
  | RequestOverlayActionMessage
  | RequestAIMessage
  | RequestAudioMessage
  | RequestScreenCaptureMessage
  | ReportDragRegionsMessage
  | ReportInteractiveRegionsMessage;

// ────────────────────────────────────────────────────────────────────
// Bridge Event Interfaces — Exact fields
// ────────────────────────────────────────────────────────────────────

export interface BridgeEventBase {
  version: number;
  event: BridgeEventType;
}

export interface OnStateSnapshotEvent extends BridgeEventBase {
  event: BridgeEventType.ON_STATE_SNAPSHOT;
  revision: number;
  state: Record<string, unknown>;
}

export interface OnStatePatchEvent extends BridgeEventBase {
  event: BridgeEventType.ON_STATE_PATCH;
  base_revision: number;
  next_revision: number;
  patch: Record<string, unknown>;
}

export interface OnOperationResultEvent extends BridgeEventBase {
  event: BridgeEventType.ON_OPERATION_RESULT;
  operation_id: string;
  success: boolean;
  error_code?: string;
  data?: Record<string, unknown>;
}

export type BridgeEventMessage =
  | OnStateSnapshotEvent
  | OnStatePatchEvent
  | OnOperationResultEvent;

// ────────────────────────────────────────────────────────────────────
// Field Specs for Bridge Messages
// ────────────────────────────────────────────────────────────────────

interface BridgeFieldSpec {
  required: readonly string[];
  optional: readonly string[];
}

const BRIDGE_METHOD_FIELDS: Readonly<Record<BridgeMethodType, BridgeFieldSpec>> = {
  [BridgeMethodType.REQUEST_OVERLAY_ACTION]: {
    required: ['version', 'method', 'action'],
    optional: ['parameters'],
  },
  [BridgeMethodType.REQUEST_AI]: {
    required: ['version', 'method', 'action'],
    optional: ['parameters'],
  },
  [BridgeMethodType.REQUEST_AUDIO]: {
    required: ['version', 'method', 'action'],
    optional: ['parameters'],
  },
  [BridgeMethodType.REQUEST_SCREEN_CAPTURE]: {
    required: ['version', 'method', 'action'],
    optional: ['parameters'],
  },
  [BridgeMethodType.REPORT_DRAG_REGIONS]: {
    required: ['version', 'method', 'revision', 'regions'],
    optional: [],
  },
  [BridgeMethodType.REPORT_INTERACTIVE_REGIONS]: {
    required: ['version', 'method', 'revision', 'regions'],
    optional: [],
  },
};

const BRIDGE_EVENT_FIELDS: Readonly<Record<BridgeEventType, BridgeFieldSpec>> = {
  [BridgeEventType.ON_STATE_SNAPSHOT]: {
    required: ['version', 'event', 'revision', 'state'],
    optional: [],
  },
  [BridgeEventType.ON_STATE_PATCH]: {
    required: ['version', 'event', 'base_revision', 'next_revision', 'patch'],
    optional: [],
  },
  [BridgeEventType.ON_OPERATION_RESULT]: {
    required: ['version', 'event', 'operation_id', 'success'],
    optional: ['error_code', 'data'],
  },
};

const VALID_METHODS = new Set<string>(Object.values(BridgeMethodType));
const VALID_EVENTS = new Set<string>(Object.values(BridgeEventType));

// ────────────────────────────────────────────────────────────────────
// Bridge Region Validation
// ────────────────────────────────────────────────────────────────────

const REGION_FIELDS: readonly string[] = ['left', 'top', 'width', 'height'];

function validateBridgeRegion(region: unknown, index: number): ValidationError[] {
  const errors: ValidationError[] = [];
  if (typeof region !== 'object' || region === null || Array.isArray(region)) {
    errors.push({
      code: ValidationErrorCode.INVALID_TYPE,
      field: `regions[${index}]`,
      message: `regions[${index}] must be an object`,
    });
    return errors;
  }

  const obj = region as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!REGION_FIELDS.includes(key)) {
      errors.push({
        code: ValidationErrorCode.UNKNOWN_FIELD,
        field: `regions[${index}].${key}`,
        message: `Unknown field '${key}' in regions[${index}]`,
      });
    }
  }
  for (const key of REGION_FIELDS) {
    if (!(key in obj)) {
      errors.push({
        code: ValidationErrorCode.MISSING_FIELD,
        field: `regions[${index}].${key}`,
        message: `Missing field '${key}' in regions[${index}]`,
      });
    } else if (typeof obj[key] !== 'number' || !Number.isFinite(obj[key] as number)) {
      errors.push({
        code: ValidationErrorCode.INVALID_TYPE,
        field: `regions[${index}].${key}`,
        message: `regions[${index}].${key} must be a finite number`,
      });
    }
  }
  return errors;
}

// ────────────────────────────────────────────────────────────────────
// Bridge Message Validators
// ────────────────────────────────────────────────────────────────────

/**
 * Validates the size of a bridge message before dispatch.
 * Requirement 7.6: reject if strict UTF-8 encoded size exceeds 65,536 bytes.
 */
export function validateBridgeMessageSize(json: string): ValidationResult {
  const byteLength = Buffer.byteLength(json, 'utf-8');
  if (byteLength > MAX_BRIDGE_MESSAGE_BYTES) {
    return {
      valid: false,
      errors: [{
        code: ValidationErrorCode.SIZE_EXCEEDED,
        message: `Bridge message size (${byteLength} bytes) exceeds maximum ${MAX_BRIDGE_MESSAGE_BYTES} bytes`,
      }],
    };
  }
  return { valid: true };
}

/**
 * Validates a bridge method message (WebView2 → Sidecar).
 * Enforces exact fields, version, type, and size.
 */
export function validateBridgeMethod(value: unknown): ValidationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      valid: false,
      errors: [{ code: ValidationErrorCode.INVALID_TYPE, message: 'Bridge method message must be an object' }],
    };
  }

  const obj = value as Record<string, unknown>;
  const errors: ValidationError[] = [];

  // Check version
  if (typeof obj.version !== 'number' || !Number.isInteger(obj.version) || (obj.version as number) < 1) {
    errors.push({
      code: ValidationErrorCode.INVALID_TYPE,
      field: 'version',
      message: 'version must be a positive integer',
    });
  }

  // Check method is valid
  if (typeof obj.method !== 'string' || !VALID_METHODS.has(obj.method)) {
    errors.push({
      code: ValidationErrorCode.UNKNOWN_MESSAGE_TYPE,
      field: 'method',
      message: `Unknown bridge method: ${obj.method}`,
    });
    return { valid: false, errors };
  }

  const method = obj.method as BridgeMethodType;
  const spec = BRIDGE_METHOD_FIELDS[method];
  const allowedFields = new Set([...spec.required, ...spec.optional]);

  // Reject unknown fields
  for (const key of Object.keys(obj)) {
    if (!allowedFields.has(key)) {
      errors.push({
        code: ValidationErrorCode.UNKNOWN_FIELD,
        field: key,
        message: `Unknown field '${key}' in bridge method '${method}'`,
      });
    }
  }

  // Check required fields
  for (const field of spec.required) {
    if (!(field in obj)) {
      errors.push({
        code: ValidationErrorCode.MISSING_FIELD,
        field,
        message: `Missing required field '${field}' in bridge method '${method}'`,
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Type-specific validation
  if (method === BridgeMethodType.REPORT_DRAG_REGIONS || method === BridgeMethodType.REPORT_INTERACTIVE_REGIONS) {
    if (typeof obj.revision !== 'number' || !Number.isInteger(obj.revision) || (obj.revision as number) < 0) {
      errors.push({
        code: ValidationErrorCode.INVALID_REVISION,
        field: 'revision',
        message: 'revision must be a non-negative integer',
      });
    }
    if (!Array.isArray(obj.regions)) {
      errors.push({
        code: ValidationErrorCode.INVALID_TYPE,
        field: 'regions',
        message: 'regions must be an array',
      });
    } else {
      for (let i = 0; i < obj.regions.length; i++) {
        errors.push(...validateBridgeRegion(obj.regions[i], i));
      }
    }
  } else {
    // Action-based methods
    if (typeof obj.action !== 'string' || (obj.action as string).length === 0) {
      errors.push({
        code: ValidationErrorCode.INVALID_TYPE,
        field: 'action',
        message: 'action must be a non-empty string',
      });
    }
  }

  // Size validation
  const json = JSON.stringify(value);
  const sizeResult = validateBridgeMessageSize(json);
  if (!sizeResult.valid) {
    errors.push(...sizeResult.errors);
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

/**
 * Validates a bridge event message (Sidecar → WebView2).
 * Enforces exact fields and size.
 */
export function validateBridgeEvent(value: unknown): ValidationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      valid: false,
      errors: [{ code: ValidationErrorCode.INVALID_TYPE, message: 'Bridge event message must be an object' }],
    };
  }

  const obj = value as Record<string, unknown>;
  const errors: ValidationError[] = [];

  // Check version
  if (typeof obj.version !== 'number' || !Number.isInteger(obj.version) || (obj.version as number) < 1) {
    errors.push({
      code: ValidationErrorCode.INVALID_TYPE,
      field: 'version',
      message: 'version must be a positive integer',
    });
  }

  // Check event is valid
  if (typeof obj.event !== 'string' || !VALID_EVENTS.has(obj.event)) {
    errors.push({
      code: ValidationErrorCode.UNKNOWN_MESSAGE_TYPE,
      field: 'event',
      message: `Unknown bridge event: ${obj.event}`,
    });
    return { valid: false, errors };
  }

  const event = obj.event as BridgeEventType;
  const spec = BRIDGE_EVENT_FIELDS[event];
  const allowedFields = new Set([...spec.required, ...spec.optional]);

  // Reject unknown fields
  for (const key of Object.keys(obj)) {
    if (!allowedFields.has(key)) {
      errors.push({
        code: ValidationErrorCode.UNKNOWN_FIELD,
        field: key,
        message: `Unknown field '${key}' in bridge event '${event}'`,
      });
    }
  }

  // Check required fields
  for (const field of spec.required) {
    if (!(field in obj)) {
      errors.push({
        code: ValidationErrorCode.MISSING_FIELD,
        field,
        message: `Missing required field '${field}' in bridge event '${event}'`,
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Size validation
  const json = JSON.stringify(value);
  const sizeResult = validateBridgeMessageSize(json);
  if (!sizeResult.valid) {
    errors.push(...sizeResult.errors);
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
