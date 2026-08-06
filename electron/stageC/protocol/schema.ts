/**
 * Stage C Protocol — Canonical Schema Source (v1)
 *
 * Single source of truth for all protocol types, message schemas, and
 * directional allowlists. Both the Electron controller and native sidecar
 * derive their models from this file (native via generated bindings).
 *
 * Requirements: 5.5–5.6, 6.13–6.21, 7.1–7.10, 8.1–8.10, 14.6–14.8, 15.1–15.12
 */

// ────────────────────────────────────────────────────────────────────
// Protocol Version Constants
// ────────────────────────────────────────────────────────────────────

/** Protocol major version — both sides must match exactly. */
export const PROTOCOL_MAJOR = 1;

/** Protocol minor version — additive capabilities. */
export const PROTOCOL_MINOR = 0;

/** Bridge schema version for WebView2 adapter validation. */
export const BRIDGE_SCHEMA_VERSION = 1;

/** Schema revision identifier for drift detection. */
export const SCHEMA_HASH_VERSION = '1.0.0';

// ────────────────────────────────────────────────────────────────────
// Size Limits
// ────────────────────────────────────────────────────────────────────

/** Maximum frame size in bytes (Req 6.16). */
export const MAX_FRAME_BYTES = 1_048_576;

/** Maximum bridge message size in bytes (Req 7.6). */
export const MAX_BRIDGE_MESSAGE_BYTES = 65_536;

/** Maximum telemetry event size in bytes (Req 15.8). */
export const MAX_TELEMETRY_EVENT_BYTES = 4_096;

/** Maximum replay cache entries per launch (Req 6.23). */
export const MAX_REPLAY_CACHE_ENTRIES = 4_096;

/** Maximum queued messages per connection (Req 6.24). */
export const MAX_QUEUED_MESSAGES = 256;

/** Maximum aggregate queued bytes per connection (Req 6.24). */
export const MAX_QUEUED_BYTES = 1_048_576;

// ────────────────────────────────────────────────────────────────────
// Message Type Enums — Directional
// ────────────────────────────────────────────────────────────────────

/**
 * Messages sent from Controller (App Core) → Sidecar.
 * Requirement 6.18.
 */
export enum ControllerToSidecarType {
  LIFECYCLE_SHUTDOWN = 'lifecycle.shutdown',
  STATE_SNAPSHOT = 'state.snapshot',
  STATE_PATCH = 'state.patch',
  SURFACE_SET_BOUNDS = 'surface.setBounds',
  SURFACE_SET_VISIBILITY = 'surface.setVisibility',
  SURFACE_SET_CAPTURE_PROTECTION = 'surface.setCaptureProtection',
  AI_STREAM_DELTA = 'ai.streamDelta',
  AI_STREAM_COMPLETED = 'ai.streamCompleted',
  AI_STREAM_FAILED = 'ai.streamFailed',
  OPERATION_RESULT = 'operation.result',
}

/**
 * Messages sent from Sidecar → Controller (App Core).
 * Requirement 6.19.
 */
export enum SidecarToControllerType {
  LIFECYCLE_READY = 'lifecycle.ready',
  LIFECYCLE_SHUTDOWN_ACK = 'lifecycle.shutdownAck',
  SURFACE_FIRST_FRAME_READY = 'surface.firstFrameReady',
  STATE_SNAPSHOT_ACK = 'state.snapshotAck',
  STATE_PATCH_ACK = 'state.patchAck',
  SURFACE_BOUNDS_CHANGED = 'surface.boundsChanged',
  SURFACE_CAPTURE_PROTECTION_RESULT = 'surface.captureProtectionResult',
  INTENT_OVERLAY = 'intent.overlay',
  INTENT_AI = 'intent.ai',
  INTENT_AUDIO = 'intent.audio',
  INTENT_SCREEN_CAPTURE = 'intent.screenCapture',
  DIAGNOSTIC_CONTENT_POLICY_EVENT = 'diagnostic.contentPolicyEvent',
}

/** Union of all valid message type strings. */
export type AllowedMessageType = ControllerToSidecarType | SidecarToControllerType;

/** Set of all controller→sidecar type values for fast lookup. */
export const CONTROLLER_TO_SIDECAR_TYPES: ReadonlySet<string> = new Set(
  Object.values(ControllerToSidecarType),
);

/** Set of all sidecar→controller type values for fast lookup. */
export const SIDECAR_TO_CONTROLLER_TYPES: ReadonlySet<string> = new Set(
  Object.values(SidecarToControllerType),
);

// ────────────────────────────────────────────────────────────────────
// Message Direction
// ────────────────────────────────────────────────────────────────────

export enum MessageDirection {
  CONTROLLER_TO_SIDECAR = 'controller_to_sidecar',
  SIDECAR_TO_CONTROLLER = 'sidecar_to_controller',
}

// ────────────────────────────────────────────────────────────────────
// Overlay Mode
// ────────────────────────────────────────────────────────────────────

export enum OverlayMode {
  COMPACT = 'compact',
  EXPANDED = 'expanded',
  MAXIMIZED = 'maximized',
}

// ────────────────────────────────────────────────────────────────────
// Host Strategy & Stage C Phase (mirrors design.md)
// ────────────────────────────────────────────────────────────────────

export enum HostStrategy {
  LAYER_0 = 'LAYER_0',
  STAGE_C = 'STAGE_C',
}

export enum StageCPhase {
  DISABLED = 'DISABLED',
  LAYER_0_ACTIVE = 'LAYER_0_ACTIVE',
  PROBING = 'PROBING',
  LAUNCHING = 'LAUNCHING',
  AUTHENTICATING = 'AUTHENTICATING',
  HANDSHAKING = 'HANDSHAKING',
  SYNCHRONIZING = 'SYNCHRONIZING',
  WAITING_FIRST_FRAME = 'WAITING_FIRST_FRAME',
  ACTIVE = 'ACTIVE',
  FALLING_BACK = 'FALLING_BACK',
  STOPPING = 'STOPPING',
}

// ────────────────────────────────────────────────────────────────────
// Failure Reasons
// ────────────────────────────────────────────────────────────────────

export enum StageCFailureReason {
  NON_WINDOWS = 'NON_WINDOWS',
  UNSUPPORTED_ARCHITECTURE = 'UNSUPPORTED_ARCHITECTURE',
  MANIFEST_MISSING = 'MANIFEST_MISSING',
  MANIFEST_SCHEMA_INVALID = 'MANIFEST_SCHEMA_INVALID',
  MANIFEST_INTEGRITY_FAILURE = 'MANIFEST_INTEGRITY_FAILURE',
  SIDECAR_NOT_FOUND = 'SIDECAR_NOT_FOUND',
  SIDECAR_ARCHITECTURE_MISMATCH = 'SIDECAR_ARCHITECTURE_MISMATCH',
  PROTOCOL_MAJOR_MISMATCH = 'PROTOCOL_MAJOR_MISMATCH',
  BRIDGE_SCHEMA_INCOMPATIBLE = 'BRIDGE_SCHEMA_INCOMPATIBLE',
  WEBVIEW2_NOT_FOUND = 'WEBVIEW2_NOT_FOUND',
  WEBVIEW2_VERSION_TOO_OLD = 'WEBVIEW2_VERSION_TOO_OLD',
  DEPENDENCY_LOCK_INTEGRITY_FAILURE = 'DEPENDENCY_LOCK_INTEGRITY_FAILURE',
  DEPENDENCY_LOCK_MISSING = 'DEPENDENCY_LOCK_MISSING',
  RELEASE_GATE_MISSING = 'RELEASE_GATE_MISSING',
  SIGNATURE_INVALID = 'SIGNATURE_INVALID',
  SIGNATURE_WRONG_PUBLISHER = 'SIGNATURE_WRONG_PUBLISHER',
  SIGNATURE_INDETERMINATE = 'SIGNATURE_INDETERMINATE',
  VERSION_MISMATCH = 'VERSION_MISMATCH',
  DIAGNOSTIC_MARKER_MISSING = 'DIAGNOSTIC_MARKER_MISSING',
  DEADLINE_EXPIRED = 'DEADLINE_EXPIRED',
  NATIVE_BOUNDARY_FAILURE = 'NATIVE_BOUNDARY_FAILURE',
  STARTUP_TIMEOUT = 'STARTUP_TIMEOUT',
  AUTHENTICATION_FAILED = 'AUTHENTICATION_FAILED',
  HANDSHAKE_FAILURE = 'HANDSHAKE_FAILURE',
  STATE_ACK_TIMEOUT = 'STATE_ACK_TIMEOUT',
  FIRST_FRAME_TIMEOUT = 'FIRST_FRAME_TIMEOUT',
  CAPTURE_PROTECTION_FAILURE = 'CAPTURE_PROTECTION_FAILURE',
  PROCESS_EXIT = 'PROCESS_EXIT',
  IPC_DISCONNECT = 'IPC_DISCONNECT',
}

// ────────────────────────────────────────────────────────────────────
// Geometry
// ────────────────────────────────────────────────────────────────────

/** Rectangle in Device-Independent Pixels. */
export interface DipRectangle {
  left: number;
  top: number;
  width: number;
  height: number;
}

// ────────────────────────────────────────────────────────────────────
// Payload Interfaces — Exact field sets
// ────────────────────────────────────────────────────────────────────

// --- Controller → Sidecar Payloads ---

export interface LifecycleShutdownPayload {
  reason: string;
}

export interface StateSnapshotPayload {
  revision: number;
  visibility_requested: boolean;
  bounds_dip: DipRectangle;
  mode: OverlayMode;
  capture_protection: boolean;
  render_state: Record<string, unknown>;
}

export interface StatePatchPayload {
  base_revision: number;
  next_revision: number;
  visibility_requested?: boolean;
  bounds_dip?: DipRectangle;
  mode?: OverlayMode;
  capture_protection?: boolean;
  render_state_patch?: Record<string, unknown>;
}

export interface SurfaceSetBoundsPayload {
  bounds_dip: DipRectangle;
}

export interface SurfaceSetVisibilityPayload {
  visible: boolean;
}

export interface SurfaceSetCaptureProtectionPayload {
  enabled: boolean;
}

export interface AiStreamDeltaPayload {
  stream_id: string;
  delta: string;
  sequence: number;
}

export interface AiStreamCompletedPayload {
  stream_id: string;
  final_sequence: number;
}

export interface AiStreamFailedPayload {
  stream_id: string;
  error_code: string;
}

export interface OperationResultPayload {
  operation_id: string;
  success: boolean;
  error_code?: string;
  data?: Record<string, unknown>;
}

// --- Sidecar → Controller Payloads ---

export interface LifecycleReadyPayload {
  launch_id: string;
  sidecar_version: string;
  protocol_major: number;
  protocol_minor: number;
  bridge_schema_version: number;
  capabilities: string[];
  webview2_runtime_version: string;
}

export interface LifecycleShutdownAckPayload {
  launch_id: string;
}

export interface SurfaceFirstFrameReadyPayload {
  revision: number;
}

export interface StateSnapshotAckPayload {
  revision: number;
}

export interface StatePatchAckPayload {
  revision: number;
}

export interface SurfaceBoundsChangedPayload {
  bounds_dip: DipRectangle;
}

export interface SurfaceCaptureProtectionResultPayload {
  enabled: boolean;
  success: boolean;
  read_back_value: boolean;
}

export interface IntentOverlayPayload {
  action: string;
  parameters?: Record<string, unknown>;
}

export interface IntentAiPayload {
  action: string;
  parameters?: Record<string, unknown>;
}

export interface IntentAudioPayload {
  action: string;
  parameters?: Record<string, unknown>;
}

export interface IntentScreenCapturePayload {
  action: string;
  parameters?: Record<string, unknown>;
}

export interface DiagnosticContentPolicyEventPayload {
  event_type: string;
  detail: string;
}

// ────────────────────────────────────────────────────────────────────
// Payload type map for type-safe dispatch
// ────────────────────────────────────────────────────────────────────

export interface ControllerToSidecarPayloadMap {
  [ControllerToSidecarType.LIFECYCLE_SHUTDOWN]: LifecycleShutdownPayload;
  [ControllerToSidecarType.STATE_SNAPSHOT]: StateSnapshotPayload;
  [ControllerToSidecarType.STATE_PATCH]: StatePatchPayload;
  [ControllerToSidecarType.SURFACE_SET_BOUNDS]: SurfaceSetBoundsPayload;
  [ControllerToSidecarType.SURFACE_SET_VISIBILITY]: SurfaceSetVisibilityPayload;
  [ControllerToSidecarType.SURFACE_SET_CAPTURE_PROTECTION]: SurfaceSetCaptureProtectionPayload;
  [ControllerToSidecarType.AI_STREAM_DELTA]: AiStreamDeltaPayload;
  [ControllerToSidecarType.AI_STREAM_COMPLETED]: AiStreamCompletedPayload;
  [ControllerToSidecarType.AI_STREAM_FAILED]: AiStreamFailedPayload;
  [ControllerToSidecarType.OPERATION_RESULT]: OperationResultPayload;
}

export interface SidecarToControllerPayloadMap {
  [SidecarToControllerType.LIFECYCLE_READY]: LifecycleReadyPayload;
  [SidecarToControllerType.LIFECYCLE_SHUTDOWN_ACK]: LifecycleShutdownAckPayload;
  [SidecarToControllerType.SURFACE_FIRST_FRAME_READY]: SurfaceFirstFrameReadyPayload;
  [SidecarToControllerType.STATE_SNAPSHOT_ACK]: StateSnapshotAckPayload;
  [SidecarToControllerType.STATE_PATCH_ACK]: StatePatchAckPayload;
  [SidecarToControllerType.SURFACE_BOUNDS_CHANGED]: SurfaceBoundsChangedPayload;
  [SidecarToControllerType.SURFACE_CAPTURE_PROTECTION_RESULT]: SurfaceCaptureProtectionResultPayload;
  [SidecarToControllerType.INTENT_OVERLAY]: IntentOverlayPayload;
  [SidecarToControllerType.INTENT_AI]: IntentAiPayload;
  [SidecarToControllerType.INTENT_AUDIO]: IntentAudioPayload;
  [SidecarToControllerType.INTENT_SCREEN_CAPTURE]: IntentScreenCapturePayload;
  [SidecarToControllerType.DIAGNOSTIC_CONTENT_POLICY_EVENT]: DiagnosticContentPolicyEventPayload;
}

// ────────────────────────────────────────────────────────────────────
// Exact field definitions for validation
// ────────────────────────────────────────────────────────────────────

const DIP_RECTANGLE_FIELDS: readonly string[] = ['left', 'top', 'width', 'height'];

/** Maps each message type to its required and optional field sets. */
export interface FieldSpec {
  required: readonly string[];
  optional: readonly string[];
}

export const PAYLOAD_FIELD_SPECS: Readonly<Record<string, FieldSpec>> = {
  // Controller → Sidecar
  [ControllerToSidecarType.LIFECYCLE_SHUTDOWN]: {
    required: ['reason'],
    optional: [],
  },
  [ControllerToSidecarType.STATE_SNAPSHOT]: {
    required: ['revision', 'visibility_requested', 'bounds_dip', 'mode', 'capture_protection', 'render_state'],
    optional: [],
  },
  [ControllerToSidecarType.STATE_PATCH]: {
    required: ['base_revision', 'next_revision'],
    optional: ['visibility_requested', 'bounds_dip', 'mode', 'capture_protection', 'render_state_patch'],
  },
  [ControllerToSidecarType.SURFACE_SET_BOUNDS]: {
    required: ['bounds_dip'],
    optional: [],
  },
  [ControllerToSidecarType.SURFACE_SET_VISIBILITY]: {
    required: ['visible'],
    optional: [],
  },
  [ControllerToSidecarType.SURFACE_SET_CAPTURE_PROTECTION]: {
    required: ['enabled'],
    optional: [],
  },
  [ControllerToSidecarType.AI_STREAM_DELTA]: {
    required: ['stream_id', 'delta', 'sequence'],
    optional: [],
  },
  [ControllerToSidecarType.AI_STREAM_COMPLETED]: {
    required: ['stream_id', 'final_sequence'],
    optional: [],
  },
  [ControllerToSidecarType.AI_STREAM_FAILED]: {
    required: ['stream_id', 'error_code'],
    optional: [],
  },
  [ControllerToSidecarType.OPERATION_RESULT]: {
    required: ['operation_id', 'success'],
    optional: ['error_code', 'data'],
  },

  // Sidecar → Controller
  [SidecarToControllerType.LIFECYCLE_READY]: {
    required: ['launch_id', 'sidecar_version', 'protocol_major', 'protocol_minor', 'bridge_schema_version', 'capabilities', 'webview2_runtime_version'],
    optional: [],
  },
  [SidecarToControllerType.LIFECYCLE_SHUTDOWN_ACK]: {
    required: ['launch_id'],
    optional: [],
  },
  [SidecarToControllerType.SURFACE_FIRST_FRAME_READY]: {
    required: ['revision'],
    optional: [],
  },
  [SidecarToControllerType.STATE_SNAPSHOT_ACK]: {
    required: ['revision'],
    optional: [],
  },
  [SidecarToControllerType.STATE_PATCH_ACK]: {
    required: ['revision'],
    optional: [],
  },
  [SidecarToControllerType.SURFACE_BOUNDS_CHANGED]: {
    required: ['bounds_dip'],
    optional: [],
  },
  [SidecarToControllerType.SURFACE_CAPTURE_PROTECTION_RESULT]: {
    required: ['enabled', 'success', 'read_back_value'],
    optional: [],
  },
  [SidecarToControllerType.INTENT_OVERLAY]: {
    required: ['action'],
    optional: ['parameters'],
  },
  [SidecarToControllerType.INTENT_AI]: {
    required: ['action'],
    optional: ['parameters'],
  },
  [SidecarToControllerType.INTENT_AUDIO]: {
    required: ['action'],
    optional: ['parameters'],
  },
  [SidecarToControllerType.INTENT_SCREEN_CAPTURE]: {
    required: ['action'],
    optional: ['parameters'],
  },
  [SidecarToControllerType.DIAGNOSTIC_CONTENT_POLICY_EVENT]: {
    required: ['event_type', 'detail'],
    optional: [],
  },
};

// ────────────────────────────────────────────────────────────────────
// Validation Errors
// ────────────────────────────────────────────────────────────────────

export enum ValidationErrorCode {
  UNKNOWN_FIELD = 'UNKNOWN_FIELD',
  MISSING_FIELD = 'MISSING_FIELD',
  INVALID_TYPE = 'INVALID_TYPE',
  INVALID_VALUE = 'INVALID_VALUE',
  WRONG_DIRECTION = 'WRONG_DIRECTION',
  UNKNOWN_MESSAGE_TYPE = 'UNKNOWN_MESSAGE_TYPE',
  SIZE_EXCEEDED = 'SIZE_EXCEEDED',
  INVALID_REVISION = 'INVALID_REVISION',
  INCOMPATIBLE_PROTOCOL = 'INCOMPATIBLE_PROTOCOL',
}

export interface ValidationError {
  code: ValidationErrorCode;
  field?: string;
  message: string;
}

export type ValidationResult =
  | { valid: true }
  | { valid: false; errors: ValidationError[] };

// ────────────────────────────────────────────────────────────────────
// Schema Validators
// ────────────────────────────────────────────────────────────────────

/**
 * Validates that an object has exactly the fields defined for a message type.
 * Rejects unknown/extra fields, missing required fields, and duplicates.
 */
export function validatePayloadFields(
  messageType: string,
  payload: Record<string, unknown>,
): ValidationResult {
  const spec = PAYLOAD_FIELD_SPECS[messageType];
  if (!spec) {
    return {
      valid: false,
      errors: [{ code: ValidationErrorCode.UNKNOWN_MESSAGE_TYPE, message: `Unknown message type: ${messageType}` }],
    };
  }

  const errors: ValidationError[] = [];
  const allowedFields = new Set([...spec.required, ...spec.optional]);
  const presentFields = Object.keys(payload);

  // Check for unknown fields
  for (const field of presentFields) {
    if (!allowedFields.has(field)) {
      errors.push({
        code: ValidationErrorCode.UNKNOWN_FIELD,
        field,
        message: `Unknown field '${field}' in ${messageType} payload`,
      });
    }
  }

  // Check for missing required fields
  for (const field of spec.required) {
    if (!(field in payload)) {
      errors.push({
        code: ValidationErrorCode.MISSING_FIELD,
        field,
        message: `Missing required field '${field}' in ${messageType} payload`,
      });
    }
  }

  // Check for duplicate fields (handled by JSON parsing, but guard at model level)
  const seen = new Set<string>();
  for (const field of presentFields) {
    if (seen.has(field)) {
      errors.push({
        code: ValidationErrorCode.UNKNOWN_FIELD,
        field,
        message: `Duplicate field '${field}' in ${messageType} payload`,
      });
    }
    seen.add(field);
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

/**
 * Validates that a DipRectangle has exactly the required fields with numeric values.
 */
export function validateDipRectangle(value: unknown, fieldName: string): ValidationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      valid: false,
      errors: [{ code: ValidationErrorCode.INVALID_TYPE, field: fieldName, message: `${fieldName} must be an object` }],
    };
  }

  const rect = value as Record<string, unknown>;
  const errors: ValidationError[] = [];
  const rectKeys = Object.keys(rect);

  for (const key of rectKeys) {
    if (!DIP_RECTANGLE_FIELDS.includes(key)) {
      errors.push({
        code: ValidationErrorCode.UNKNOWN_FIELD,
        field: `${fieldName}.${key}`,
        message: `Unknown field '${key}' in ${fieldName}`,
      });
    }
  }

  for (const key of DIP_RECTANGLE_FIELDS) {
    if (!(key in rect)) {
      errors.push({
        code: ValidationErrorCode.MISSING_FIELD,
        field: `${fieldName}.${key}`,
        message: `Missing field '${key}' in ${fieldName}`,
      });
    } else if (typeof rect[key] !== 'number' || !Number.isFinite(rect[key] as number)) {
      errors.push({
        code: ValidationErrorCode.INVALID_TYPE,
        field: `${fieldName}.${key}`,
        message: `${fieldName}.${key} must be a finite number`,
      });
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

/**
 * Returns the expected direction for a message type, or null if unknown.
 */
export function getMessageDirection(type: string): MessageDirection | null {
  if (CONTROLLER_TO_SIDECAR_TYPES.has(type)) {
    return MessageDirection.CONTROLLER_TO_SIDECAR;
  }
  if (SIDECAR_TO_CONTROLLER_TYPES.has(type)) {
    return MessageDirection.SIDECAR_TO_CONTROLLER;
  }
  return null;
}

/**
 * Validates that a message type is used in the correct direction.
 */
export function validateMessageDirection(
  type: string,
  actualDirection: MessageDirection,
): ValidationResult {
  const expectedDirection = getMessageDirection(type);
  if (expectedDirection === null) {
    return {
      valid: false,
      errors: [{ code: ValidationErrorCode.UNKNOWN_MESSAGE_TYPE, message: `Unknown message type: ${type}` }],
    };
  }
  if (expectedDirection !== actualDirection) {
    return {
      valid: false,
      errors: [{
        code: ValidationErrorCode.WRONG_DIRECTION,
        message: `Message type '${type}' is not valid for direction '${actualDirection}'`,
      }],
    };
  }
  return { valid: true };
}
