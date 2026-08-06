/**
 * Stage C Bridge — Authoritative Native Bridge
 *
 * Revalidates every page message natively (version, exact fields, type, range,
 * count, size). Maps methods one-to-one to allowed IPC messages and events
 * one-to-one to bridge callbacks. Invalid messages return typed errors with
 * zero native side effects.
 *
 * Requirements: 7.4–7.9, 7.15
 */

import {
  MAX_BRIDGE_MESSAGE_BYTES,
  BRIDGE_SCHEMA_VERSION,
  SidecarToControllerType,
  ControllerToSidecarType,
  type ValidationResult,
  type ValidationError,
  ValidationErrorCode,
} from '../protocol/schema';

import {
  BridgeMethodType,
  BridgeEventType,
  validateBridgeMethod,
  validateBridgeEvent,
  type BridgeMethodMessage,
  type BridgeEventMessage,
  type BridgeRegion,
} from '../protocol/bridge';

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

/** Maximum regions in a single report (Req 7.7 range/count). */
export const MAX_BRIDGE_REGIONS = 256;

/** Maximum action string length. */
export const MAX_ACTION_STRING_LENGTH = 256;

/** Maximum parameters keys. */
export const MAX_PARAMETERS_KEYS = 32;

/** Current bridge version expected. */
export const EXPECTED_BRIDGE_VERSION = BRIDGE_SCHEMA_VERSION;

// ────────────────────────────────────────────────────────────────────
// Error Types
// ────────────────────────────────────────────────────────────────────

export interface NativeBridgeError {
  code: string;
  message: string;
  field?: string;
}

export type NativeBridgeResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: NativeBridgeError };

// ────────────────────────────────────────────────────────────────────
// Method → IPC Message Mapping (Req 7.4)
// ────────────────────────────────────────────────────────────────────

/**
 * One-to-one mapping from bridge methods to IPC message types.
 * Each method maps to exactly one sidecar→controller intent message.
 */
export const METHOD_TO_IPC_TYPE: Readonly<Record<BridgeMethodType, SidecarToControllerType>> = {
  [BridgeMethodType.REQUEST_OVERLAY_ACTION]: SidecarToControllerType.INTENT_OVERLAY,
  [BridgeMethodType.REQUEST_AI]: SidecarToControllerType.INTENT_AI,
  [BridgeMethodType.REQUEST_AUDIO]: SidecarToControllerType.INTENT_AUDIO,
  [BridgeMethodType.REQUEST_SCREEN_CAPTURE]: SidecarToControllerType.INTENT_SCREEN_CAPTURE,
  [BridgeMethodType.REPORT_DRAG_REGIONS]: SidecarToControllerType.SURFACE_BOUNDS_CHANGED,
  [BridgeMethodType.REPORT_INTERACTIVE_REGIONS]: SidecarToControllerType.SURFACE_BOUNDS_CHANGED,
};

/**
 * One-to-one mapping from IPC event types to bridge event types.
 * Each controller→sidecar event maps to exactly one bridge callback.
 */
export const IPC_TYPE_TO_EVENT: Readonly<Record<string, BridgeEventType>> = {
  [ControllerToSidecarType.STATE_SNAPSHOT]: BridgeEventType.ON_STATE_SNAPSHOT,
  [ControllerToSidecarType.STATE_PATCH]: BridgeEventType.ON_STATE_PATCH,
  [ControllerToSidecarType.OPERATION_RESULT]: BridgeEventType.ON_OPERATION_RESULT,
};

// ────────────────────────────────────────────────────────────────────
// IPC Payload Interfaces
// ────────────────────────────────────────────────────────────────────

export interface IntentIpcPayload {
  action: string;
  parameters?: Record<string, unknown>;
}

export interface DragRegionsIpcPayload {
  revision: number;
  regions: BridgeRegion[];
  type: 'drag' | 'interactive';
}

export type IpcPayload = IntentIpcPayload | DragRegionsIpcPayload;

// ────────────────────────────────────────────────────────────────────
// Native Bridge — Authoritative Revalidation
// ────────────────────────────────────────────────────────────────────

/**
 * Authoritative native revalidation of a raw page message.
 * This is the native-side validation that repeats all checks regardless of
 * whether the page adapter already validated (Req 7.8, 7.15 — treat as untrusted).
 *
 * Validates: version, exact fields, type, range, count, and size.
 * Returns typed error with zero native side effects on failure (Req 7.9).
 */
export function revalidatePageMessage(rawJson: string): NativeBridgeResult<BridgeMethodMessage> {
  // Step 1: Size check (Req 7.6) — reject before dispatch
  const byteLength = Buffer.byteLength(rawJson, 'utf-8');
  if (byteLength > MAX_BRIDGE_MESSAGE_BYTES) {
    return {
      ok: false,
      error: {
        code: 'SIZE_EXCEEDED',
        message: `Message size ${byteLength} exceeds maximum ${MAX_BRIDGE_MESSAGE_BYTES} bytes`,
      },
    };
  }

  // Step 2: Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return {
      ok: false,
      error: {
        code: 'INVALID_JSON',
        message: 'Message is not valid JSON',
      },
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_TYPE',
        message: 'Message must be a JSON object',
      },
    };
  }

  const obj = parsed as Record<string, unknown>;

  // Step 3: Version check (Req 7.7 — validate version)
  if (typeof obj.version !== 'number' || !Number.isInteger(obj.version) || obj.version < 1) {
    return {
      ok: false,
      error: {
        code: 'INVALID_VERSION',
        field: 'version',
        message: 'version must be a positive integer',
      },
    };
  }

  if (obj.version !== EXPECTED_BRIDGE_VERSION) {
    return {
      ok: false,
      error: {
        code: 'INCOMPATIBLE_VERSION',
        field: 'version',
        message: `version ${obj.version} is incompatible with expected ${EXPECTED_BRIDGE_VERSION}`,
      },
    };
  }

  // Step 4: Use existing schema validation (exact fields, type)
  const schemaResult = validateBridgeMethod(parsed);
  if (!schemaResult.valid) {
    const firstError = schemaResult.errors[0];
    return {
      ok: false,
      error: {
        code: firstError.code,
        field: firstError.field,
        message: firstError.message,
      },
    };
  }

  // Step 5: Range, count, and semantic validation
  const method = obj.method as BridgeMethodType;
  const rangeResult = validateRangeAndCount(obj, method);
  if (!rangeResult.ok) {
    return rangeResult;
  }

  return { ok: true, value: parsed as BridgeMethodMessage };
}

/**
 * Validates range, count, and semantic constraints beyond exact-field validation.
 */
function validateRangeAndCount(
  obj: Record<string, unknown>,
  method: BridgeMethodType,
): NativeBridgeResult {
  if (
    method === BridgeMethodType.REPORT_DRAG_REGIONS ||
    method === BridgeMethodType.REPORT_INTERACTIVE_REGIONS
  ) {
    // Revision must be non-negative integer
    const revision = obj.revision as number;
    if (revision < 0 || revision > Number.MAX_SAFE_INTEGER) {
      return {
        ok: false,
        error: {
          code: 'INVALID_RANGE',
          field: 'revision',
          message: 'revision must be a non-negative safe integer',
        },
      };
    }

    // Regions count limit
    const regions = obj.regions as unknown[];
    if (regions.length > MAX_BRIDGE_REGIONS) {
      return {
        ok: false,
        error: {
          code: 'COUNT_EXCEEDED',
          field: 'regions',
          message: `regions count ${regions.length} exceeds maximum ${MAX_BRIDGE_REGIONS}`,
        },
      };
    }

    // Validate each region's range: finite coords, non-negative width/height
    for (let i = 0; i < regions.length; i++) {
      const region = regions[i] as Record<string, number>;
      if (region.width < 0 || region.height < 0) {
        return {
          ok: false,
          error: {
            code: 'INVALID_RANGE',
            field: `regions[${i}]`,
            message: `Region ${i} has negative width or height`,
          },
        };
      }
      // Coordinate range: must be safe integers
      if (
        Math.abs(region.left) > 32767 ||
        Math.abs(region.top) > 32767 ||
        region.width > 32767 ||
        region.height > 32767
      ) {
        return {
          ok: false,
          error: {
            code: 'INVALID_RANGE',
            field: `regions[${i}]`,
            message: `Region ${i} coordinate out of bounds`,
          },
        };
      }
    }
  } else {
    // Intent-based methods: validate action string length
    const action = obj.action as string;
    if (action.length > MAX_ACTION_STRING_LENGTH) {
      return {
        ok: false,
        error: {
          code: 'INVALID_RANGE',
          field: 'action',
          message: `action string length ${action.length} exceeds maximum ${MAX_ACTION_STRING_LENGTH}`,
        },
      };
    }

    // Parameters key count limit
    if (obj.parameters !== undefined) {
      const params = obj.parameters as Record<string, unknown>;
      const keys = Object.keys(params);
      if (keys.length > MAX_PARAMETERS_KEYS) {
        return {
          ok: false,
          error: {
            code: 'COUNT_EXCEEDED',
            field: 'parameters',
            message: `parameters key count ${keys.length} exceeds maximum ${MAX_PARAMETERS_KEYS}`,
          },
        };
      }
    }
  }

  return { ok: true, value: undefined };
}

// ────────────────────────────────────────────────────────────────────
// Method → IPC Payload Conversion
// ────────────────────────────────────────────────────────────────────

/**
 * Converts a validated bridge method message to its corresponding IPC payload.
 * This is the one-to-one mapping from bridge method to allowed IPC message (Req 7.4).
 */
export function methodToIpcPayload(
  message: BridgeMethodMessage,
): { type: SidecarToControllerType; payload: IpcPayload } {
  switch (message.method) {
    case BridgeMethodType.REQUEST_OVERLAY_ACTION:
      return {
        type: SidecarToControllerType.INTENT_OVERLAY,
        payload: {
          action: message.action,
          parameters: message.parameters,
        },
      };
    case BridgeMethodType.REQUEST_AI:
      return {
        type: SidecarToControllerType.INTENT_AI,
        payload: {
          action: message.action,
          parameters: message.parameters,
        },
      };
    case BridgeMethodType.REQUEST_AUDIO:
      return {
        type: SidecarToControllerType.INTENT_AUDIO,
        payload: {
          action: message.action,
          parameters: message.parameters,
        },
      };
    case BridgeMethodType.REQUEST_SCREEN_CAPTURE:
      return {
        type: SidecarToControllerType.INTENT_SCREEN_CAPTURE,
        payload: {
          action: message.action,
          parameters: message.parameters,
        },
      };
    case BridgeMethodType.REPORT_DRAG_REGIONS:
      return {
        type: SidecarToControllerType.SURFACE_BOUNDS_CHANGED,
        payload: {
          revision: message.revision,
          regions: message.regions,
          type: 'drag',
        },
      };
    case BridgeMethodType.REPORT_INTERACTIVE_REGIONS:
      return {
        type: SidecarToControllerType.SURFACE_BOUNDS_CHANGED,
        payload: {
          revision: message.revision,
          regions: message.regions,
          type: 'interactive',
        },
      };
  }
}

// ────────────────────────────────────────────────────────────────────
// Event → Bridge Callback Conversion (IPC → page)
// ────────────────────────────────────────────────────────────────────

/**
 * Converts an IPC event type and payload to a bridge event message for the page.
 * Returns null if the IPC type is not mapped to a bridge event.
 */
export function ipcToEventMessage(
  ipcType: string,
  payload: Record<string, unknown>,
): NativeBridgeResult<BridgeEventMessage> {
  const eventType = IPC_TYPE_TO_EVENT[ipcType];
  if (!eventType) {
    return {
      ok: false,
      error: {
        code: 'UNMAPPED_EVENT',
        message: `IPC type '${ipcType}' has no bridge event mapping`,
      },
    };
  }

  let eventMessage: BridgeEventMessage;

  switch (eventType) {
    case BridgeEventType.ON_STATE_SNAPSHOT:
      eventMessage = {
        version: EXPECTED_BRIDGE_VERSION,
        event: BridgeEventType.ON_STATE_SNAPSHOT,
        revision: payload.revision as number,
        state: payload.render_state as Record<string, unknown>,
      };
      break;
    case BridgeEventType.ON_STATE_PATCH:
      eventMessage = {
        version: EXPECTED_BRIDGE_VERSION,
        event: BridgeEventType.ON_STATE_PATCH,
        base_revision: payload.base_revision as number,
        next_revision: payload.next_revision as number,
        patch: (payload.render_state_patch ?? {}) as Record<string, unknown>,
      };
      break;
    case BridgeEventType.ON_OPERATION_RESULT:
      eventMessage = {
        version: EXPECTED_BRIDGE_VERSION,
        event: BridgeEventType.ON_OPERATION_RESULT,
        operation_id: payload.operation_id as string,
        success: payload.success as boolean,
        ...(payload.error_code !== undefined ? { error_code: payload.error_code as string } : {}),
        ...(payload.data !== undefined ? { data: payload.data as Record<string, unknown> } : {}),
      };
      break;
  }

  // Validate the constructed event before sending to page
  const validation = validateBridgeEvent(eventMessage);
  if (!validation.valid) {
    return {
      ok: false,
      error: {
        code: 'INVALID_EVENT',
        message: `Constructed bridge event failed validation: ${validation.errors[0].message}`,
      },
    };
  }

  // Size check
  const json = JSON.stringify(eventMessage);
  const byteLength = Buffer.byteLength(json, 'utf-8');
  if (byteLength > MAX_BRIDGE_MESSAGE_BYTES) {
    return {
      ok: false,
      error: {
        code: 'SIZE_EXCEEDED',
        message: `Event message size ${byteLength} exceeds maximum ${MAX_BRIDGE_MESSAGE_BYTES} bytes`,
      },
    };
  }

  return { ok: true, value: eventMessage };
}

// ────────────────────────────────────────────────────────────────────
// Full Bridge Dispatch (revalidate + map)
// ────────────────────────────────────────────────────────────────────

export interface BridgeDispatchResult {
  ipcType: SidecarToControllerType;
  payload: IpcPayload;
}

/**
 * Full native bridge dispatch: revalidate page message, then map to IPC.
 * Returns typed error with zero native side effects on failure.
 */
export function dispatchPageMessage(rawJson: string): NativeBridgeResult<BridgeDispatchResult> {
  const revalidation = revalidatePageMessage(rawJson);
  if (!revalidation.ok) {
    return revalidation;
  }

  const mapped = methodToIpcPayload(revalidation.value);
  return {
    ok: true,
    value: {
      ipcType: mapped.type,
      payload: mapped.payload,
    },
  };
}
