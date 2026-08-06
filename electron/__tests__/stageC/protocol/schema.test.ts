/**
 * Stage C Protocol Schema — Unit Tests
 *
 * Covers exact field validation, message type directional enforcement,
 * size limit enforcement, and schema version constants.
 *
 * Requirements: 5.5–5.6, 6.13–6.21, 7.1–7.10, 14.6–14.8, 15.1–15.12
 */

import { describe, it, expect } from 'vitest';

import {
  // Constants
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  BRIDGE_SCHEMA_VERSION,
  SCHEMA_HASH_VERSION,
  MAX_FRAME_BYTES,
  MAX_BRIDGE_MESSAGE_BYTES,
  MAX_TELEMETRY_EVENT_BYTES,
  MAX_REPLAY_CACHE_ENTRIES,
  MAX_QUEUED_MESSAGES,
  MAX_QUEUED_BYTES,

  // Enums
  ControllerToSidecarType,
  SidecarToControllerType,
  MessageDirection,
  OverlayMode,
  HostStrategy,
  StageCPhase,
  StageCFailureReason,
  ValidationErrorCode,

  // Validators from schema
  validatePayloadFields,
  validateDipRectangle,
  getMessageDirection,
  validateMessageDirection,
  CONTROLLER_TO_SIDECAR_TYPES,
  SIDECAR_TO_CONTROLLER_TYPES,
  PAYLOAD_FIELD_SPECS,
} from '../../../stageC/protocol';

import {
  // Envelope
  serializeEnvelope,
  deserializeEnvelope,
  validateFrameSize,
  isStrictUtf8,
  type ProtocolEnvelope,
} from '../../../stageC/protocol';

import {
  // Projection
  validateProjection,
  validatePatch,
} from '../../../stageC/protocol';

import {
  // Handshake
  validateHandshake,
  verifyHandshake,
  type ReadyHandshake,
} from '../../../stageC/protocol';

import {
  // Bridge
  BridgeMethodType,
  BridgeEventType,
  validateBridgeMethod,
  validateBridgeEvent,
  validateBridgeMessageSize,
} from '../../../stageC/protocol';

import {
  // Telemetry
  validateTelemetryEvent,
  MAX_MEASUREMENT_ENTRIES,
} from '../../../stageC/protocol';


// ────────────────────────────────────────────────────────────────────
// Schema Version Constants
// ────────────────────────────────────────────────────────────────────

describe('Schema version constants', () => {
  it('has expected protocol version values', () => {
    expect(PROTOCOL_MAJOR).toBe(1);
    expect(PROTOCOL_MINOR).toBe(0);
    expect(BRIDGE_SCHEMA_VERSION).toBe(1);
    expect(SCHEMA_HASH_VERSION).toBe('1.0.0');
  });

  it('has expected size limit constants', () => {
    expect(MAX_FRAME_BYTES).toBe(1_048_576);
    expect(MAX_BRIDGE_MESSAGE_BYTES).toBe(65_536);
    expect(MAX_TELEMETRY_EVENT_BYTES).toBe(4_096);
    expect(MAX_REPLAY_CACHE_ENTRIES).toBe(4_096);
    expect(MAX_QUEUED_MESSAGES).toBe(256);
    expect(MAX_QUEUED_BYTES).toBe(1_048_576);
  });

  it('has all expected message types in both directions', () => {
    expect(CONTROLLER_TO_SIDECAR_TYPES.size).toBe(10);
    expect(SIDECAR_TO_CONTROLLER_TYPES.size).toBe(12);
  });
});


// ────────────────────────────────────────────────────────────────────
// Exact Field Validation
// ────────────────────────────────────────────────────────────────────

describe('Payload field validation', () => {
  it('accepts a valid state.snapshot payload with exact fields', () => {
    const payload = {
      revision: 1,
      visibility_requested: true,
      bounds_dip: { left: 0, top: 0, width: 400, height: 300 },
      mode: 'compact',
      capture_protection: false,
      render_state: { text: 'hello' },
    };
    const result = validatePayloadFields(ControllerToSidecarType.STATE_SNAPSHOT, payload);
    expect(result.valid).toBe(true);
  });

  it('rejects extra/unknown fields in payload', () => {
    const payload = {
      revision: 1,
      visibility_requested: true,
      bounds_dip: { left: 0, top: 0, width: 400, height: 300 },
      mode: 'compact',
      capture_protection: false,
      render_state: {},
      extra_field: 'should not be here',
    };
    const result = validatePayloadFields(ControllerToSidecarType.STATE_SNAPSHOT, payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0].code).toBe(ValidationErrorCode.UNKNOWN_FIELD);
      expect(result.errors[0].field).toBe('extra_field');
    }
  });

  it('rejects missing required fields in payload', () => {
    const payload = {
      revision: 1,
      // missing visibility_requested, bounds_dip, mode, etc.
    };
    const result = validatePayloadFields(ControllerToSidecarType.STATE_SNAPSHOT, payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const missingFields = result.errors.filter(e => e.code === ValidationErrorCode.MISSING_FIELD);
      expect(missingFields.length).toBeGreaterThan(0);
    }
  });

  it('rejects unknown message types', () => {
    const result = validatePayloadFields('unknown.type', { foo: 'bar' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0].code).toBe(ValidationErrorCode.UNKNOWN_MESSAGE_TYPE);
    }
  });

  it('accepts valid lifecycle.ready payload', () => {
    const payload = {
      launch_id: 'abc-123',
      sidecar_version: '1.0.0',
      protocol_major: 1,
      protocol_minor: 0,
      bridge_schema_version: 1,
      capabilities: ['overlay'],
      webview2_runtime_version: '119.0.2151.0',
    };
    const result = validatePayloadFields(SidecarToControllerType.LIFECYCLE_READY, payload);
    expect(result.valid).toBe(true);
  });

  it('accepts valid operation.result payload with optional fields', () => {
    const payload = {
      operation_id: 'op-1',
      success: true,
      data: { key: 'value' },
    };
    const result = validatePayloadFields(ControllerToSidecarType.OPERATION_RESULT, payload);
    expect(result.valid).toBe(true);
  });

  it('accepts valid operation.result payload without optional fields', () => {
    const payload = { operation_id: 'op-1', success: false };
    const result = validatePayloadFields(ControllerToSidecarType.OPERATION_RESULT, payload);
    expect(result.valid).toBe(true);
  });
});


// ────────────────────────────────────────────────────────────────────
// DipRectangle Validation
// ────────────────────────────────────────────────────────────────────

describe('DipRectangle validation', () => {
  it('accepts a valid rectangle', () => {
    const result = validateDipRectangle({ left: -10, top: 0, width: 400, height: 300 }, 'bounds');
    expect(result.valid).toBe(true);
  });

  it('rejects non-object values', () => {
    const result = validateDipRectangle(null, 'bounds');
    expect(result.valid).toBe(false);
  });

  it('rejects extra fields in rectangle', () => {
    const result = validateDipRectangle({ left: 0, top: 0, width: 100, height: 100, extra: 1 }, 'bounds');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0].code).toBe(ValidationErrorCode.UNKNOWN_FIELD);
    }
  });

  it('rejects non-finite numbers', () => {
    const result = validateDipRectangle({ left: Infinity, top: 0, width: 100, height: 100 }, 'bounds');
    expect(result.valid).toBe(false);
  });

  it('rejects missing fields', () => {
    const result = validateDipRectangle({ left: 0, top: 0 }, 'bounds');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const missing = result.errors.filter(e => e.code === ValidationErrorCode.MISSING_FIELD);
      expect(missing.length).toBe(2); // width, height
    }
  });
});


// ────────────────────────────────────────────────────────────────────
// Message Direction Enforcement
// ────────────────────────────────────────────────────────────────────

describe('Message direction enforcement', () => {
  it('identifies controller→sidecar types correctly', () => {
    for (const type of Object.values(ControllerToSidecarType)) {
      expect(getMessageDirection(type)).toBe(MessageDirection.CONTROLLER_TO_SIDECAR);
    }
  });

  it('identifies sidecar→controller types correctly', () => {
    for (const type of Object.values(SidecarToControllerType)) {
      expect(getMessageDirection(type)).toBe(MessageDirection.SIDECAR_TO_CONTROLLER);
    }
  });

  it('returns null for unknown types', () => {
    expect(getMessageDirection('unknown.type')).toBeNull();
  });

  it('rejects controller messages sent in sidecar direction', () => {
    const result = validateMessageDirection(
      ControllerToSidecarType.STATE_SNAPSHOT,
      MessageDirection.SIDECAR_TO_CONTROLLER,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0].code).toBe(ValidationErrorCode.WRONG_DIRECTION);
    }
  });

  it('rejects sidecar messages sent in controller direction', () => {
    const result = validateMessageDirection(
      SidecarToControllerType.LIFECYCLE_READY,
      MessageDirection.CONTROLLER_TO_SIDECAR,
    );
    expect(result.valid).toBe(false);
  });

  it('accepts correctly-directed messages', () => {
    const result = validateMessageDirection(
      ControllerToSidecarType.STATE_SNAPSHOT,
      MessageDirection.CONTROLLER_TO_SIDECAR,
    );
    expect(result.valid).toBe(true);
  });
});


// ────────────────────────────────────────────────────────────────────
// Envelope Serialization & Validation
// ────────────────────────────────────────────────────────────────────

describe('Protocol envelope', () => {
  const validEnvelope: ProtocolEnvelope = {
    protocolVersion: { major: 1, minor: 0 },
    messageId: 'msg-001',
    type: ControllerToSidecarType.LIFECYCLE_SHUTDOWN,
    payload: { reason: 'user-requested' },
  };

  it('round-trips serialize/deserialize without extra fields', () => {
    const frame = serializeEnvelope(validEnvelope);
    const result = deserializeEnvelope(frame);
    expect(result.errors).toHaveLength(0);
    expect(result.envelope).not.toBeNull();
    expect(result.envelope!.protocolVersion).toEqual({ major: 1, minor: 0 });
    expect(result.envelope!.messageId).toBe('msg-001');
    expect(result.envelope!.type).toBe(ControllerToSidecarType.LIFECYCLE_SHUTDOWN);
    expect(result.envelope!.payload).toEqual({ reason: 'user-requested' });
  });

  it('rejects frames exceeding MAX_FRAME_BYTES', () => {
    const result = validateFrameSize(MAX_FRAME_BYTES + 1);
    expect(result.valid).toBe(false);
  });

  it('accepts frames at exactly MAX_FRAME_BYTES', () => {
    const result = validateFrameSize(MAX_FRAME_BYTES);
    expect(result.valid).toBe(true);
  });

  it('rejects invalid UTF-8', () => {
    expect(isStrictUtf8(Buffer.from([0xff, 0xfe]))).toBe(false);
  });

  it('accepts valid UTF-8', () => {
    expect(isStrictUtf8(Buffer.from('hello world', 'utf-8'))).toBe(true);
  });

  it('rejects malformed JSON in frame body', () => {
    const body = Buffer.from('{invalid json}', 'utf-8');
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    const result = deserializeEnvelope(frame);
    expect(result.envelope).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects envelope with unknown fields', () => {
    const obj = { ...validEnvelope, unknownField: true };
    const json = JSON.stringify(obj);
    const body = Buffer.from(json, 'utf-8');
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    const result = deserializeEnvelope(frame);
    expect(result.envelope).toBeNull();
    expect(result.errors.some(e => e.code === ValidationErrorCode.UNKNOWN_FIELD)).toBe(true);
  });

  it('rejects envelope with missing fields', () => {
    const obj = { protocolVersion: { major: 1, minor: 0 }, messageId: 'x' }; // missing type, payload
    const json = JSON.stringify(obj);
    const body = Buffer.from(json, 'utf-8');
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    const result = deserializeEnvelope(frame);
    expect(result.envelope).toBeNull();
    expect(result.errors.some(e => e.code === ValidationErrorCode.MISSING_FIELD)).toBe(true);
  });

  it('rejects incompatible protocol major version', () => {
    const obj = { protocolVersion: { major: 99, minor: 0 }, messageId: 'x', type: 'lifecycle.shutdown', payload: { reason: 'test' } };
    const json = JSON.stringify(obj);
    const body = Buffer.from(json, 'utf-8');
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    const result = deserializeEnvelope(frame);
    expect(result.envelope).toBeNull();
    expect(result.errors.some(e => e.code === ValidationErrorCode.INCOMPATIBLE_PROTOCOL)).toBe(true);
  });

  it('rejects unknown message type in envelope', () => {
    const obj = { protocolVersion: { major: 1, minor: 0 }, messageId: 'x', type: 'unknown.action', payload: {} };
    const json = JSON.stringify(obj);
    const body = Buffer.from(json, 'utf-8');
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    const result = deserializeEnvelope(frame);
    expect(result.envelope).toBeNull();
  });
});


// ────────────────────────────────────────────────────────────────────
// Overlay Projection Validation
// ────────────────────────────────────────────────────────────────────

describe('Overlay projection validation', () => {
  const validProjection = {
    revision: 5,
    visibility_requested: true,
    bounds_dip: { left: 100, top: 200, width: 400, height: 300 },
    mode: 'expanded',
    capture_protection: true,
    render_state: { transcript: [] },
  };

  it('accepts a valid projection', () => {
    expect(validateProjection(validProjection).valid).toBe(true);
  });

  it('rejects projection with extra fields', () => {
    const result = validateProjection({ ...validProjection, extra: true });
    expect(result.valid).toBe(false);
  });

  it('rejects projection with missing fields', () => {
    const { render_state, ...partial } = validProjection;
    const result = validateProjection(partial);
    expect(result.valid).toBe(false);
  });

  it('rejects negative revision', () => {
    const result = validateProjection({ ...validProjection, revision: -1 });
    expect(result.valid).toBe(false);
  });

  it('rejects invalid mode', () => {
    const result = validateProjection({ ...validProjection, mode: 'invalid' });
    expect(result.valid).toBe(false);
  });
});

describe('Overlay patch validation', () => {
  const validPatch = {
    base_revision: 5,
    next_revision: 6,
    visibility_requested: false,
  };

  it('accepts a valid patch', () => {
    expect(validatePatch(validPatch).valid).toBe(true);
  });

  it('rejects patch with extra fields', () => {
    const result = validatePatch({ ...validPatch, unknown: 'x' });
    expect(result.valid).toBe(false);
  });

  it('rejects patch where next_revision <= base_revision', () => {
    const result = validatePatch({ base_revision: 5, next_revision: 5 });
    expect(result.valid).toBe(false);
  });

  it('accepts patch with only required fields', () => {
    const result = validatePatch({ base_revision: 0, next_revision: 1 });
    expect(result.valid).toBe(true);
  });
});


// ────────────────────────────────────────────────────────────────────
// Handshake Validation
// ────────────────────────────────────────────────────────────────────

describe('Handshake validation', () => {
  const validHandshake = {
    launch_id: 'launch-abc-123',
    sidecar_version: '1.0.0',
    protocol_major: 1,
    protocol_minor: 0,
    bridge_schema_version: 1,
    capabilities: ['overlay'],
    webview2_runtime_version: '119.0.2151.0',
  };

  it('accepts a valid handshake', () => {
    expect(validateHandshake(validHandshake).valid).toBe(true);
  });

  it('rejects handshake with extra fields', () => {
    const result = validateHandshake({ ...validHandshake, extra: 'field' });
    expect(result.valid).toBe(false);
  });

  it('rejects handshake with missing fields', () => {
    const { capabilities, ...partial } = validHandshake;
    const result = validateHandshake(partial);
    expect(result.valid).toBe(false);
  });

  it('rejects incompatible protocol major', () => {
    const result = validateHandshake({ ...validHandshake, protocol_major: 99 });
    expect(result.valid).toBe(false);
  });

  it('verifies launch_id match', () => {
    const hs: ReadyHandshake = validHandshake as ReadyHandshake;
    const result = verifyHandshake(hs, 'wrong-id', []);
    expect(result.valid).toBe(false);
  });

  it('verifies required capabilities', () => {
    const hs: ReadyHandshake = validHandshake as ReadyHandshake;
    const result = verifyHandshake(hs, 'launch-abc-123', ['overlay', 'missing-cap']);
    expect(result.valid).toBe(false);
  });

  it('passes verification with matching expectations', () => {
    const hs: ReadyHandshake = validHandshake as ReadyHandshake;
    const result = verifyHandshake(hs, 'launch-abc-123', ['overlay']);
    expect(result.valid).toBe(true);
  });
});


// ────────────────────────────────────────────────────────────────────
// Bridge Message Validation
// ────────────────────────────────────────────────────────────────────

describe('Bridge message validation', () => {
  it('accepts a valid bridge method message', () => {
    const msg = {
      version: 1,
      method: BridgeMethodType.REQUEST_OVERLAY_ACTION,
      action: 'toggle',
    };
    expect(validateBridgeMethod(msg).valid).toBe(true);
  });

  it('rejects bridge method with extra fields', () => {
    const msg = {
      version: 1,
      method: BridgeMethodType.REQUEST_AI,
      action: 'query',
      extra: 'not-allowed',
    };
    const result = validateBridgeMethod(msg);
    expect(result.valid).toBe(false);
  });

  it('rejects unknown bridge method', () => {
    const msg = { version: 1, method: 'unknownMethod', action: 'x' };
    const result = validateBridgeMethod(msg);
    expect(result.valid).toBe(false);
  });

  it('validates region-based methods', () => {
    const msg = {
      version: 1,
      method: BridgeMethodType.REPORT_DRAG_REGIONS,
      revision: 3,
      regions: [{ left: 0, top: 0, width: 100, height: 30 }],
    };
    expect(validateBridgeMethod(msg).valid).toBe(true);
  });

  it('rejects region with extra field', () => {
    const msg = {
      version: 1,
      method: BridgeMethodType.REPORT_DRAG_REGIONS,
      revision: 3,
      regions: [{ left: 0, top: 0, width: 100, height: 30, extra: 1 }],
    };
    expect(validateBridgeMethod(msg).valid).toBe(false);
  });

  it('rejects bridge message exceeding 65,536 bytes', () => {
    const largeJson = JSON.stringify({ version: 1, method: 'requestAI', action: 'a'.repeat(70000) });
    const result = validateBridgeMessageSize(largeJson);
    expect(result.valid).toBe(false);
  });

  it('accepts bridge message at size limit', () => {
    const json = JSON.stringify({ version: 1, method: 'requestAI', action: 'x' });
    const result = validateBridgeMessageSize(json);
    expect(result.valid).toBe(true);
  });

  it('accepts a valid bridge event', () => {
    const event = {
      version: 1,
      event: BridgeEventType.ON_STATE_SNAPSHOT,
      revision: 1,
      state: { text: 'hello' },
    };
    expect(validateBridgeEvent(event).valid).toBe(true);
  });

  it('rejects bridge event with extra fields', () => {
    const event = {
      version: 1,
      event: BridgeEventType.ON_STATE_SNAPSHOT,
      revision: 1,
      state: {},
      extra: true,
    };
    expect(validateBridgeEvent(event).valid).toBe(false);
  });

  it('rejects unknown bridge event type', () => {
    const event = { version: 1, event: 'onUnknown', data: {} };
    expect(validateBridgeEvent(event).valid).toBe(false);
  });
});


// ────────────────────────────────────────────────────────────────────
// Telemetry Event Validation
// ────────────────────────────────────────────────────────────────────

describe('Telemetry event validation', () => {
  const validEvent = {
    eventName: 'stage_c_startup',
    timestamp: new Date().toISOString(),
    hostStrategy: 'STAGE_C',
    lifecyclePhase: 'ACTIVE',
    durationMs: 1500,
    result: 'success',
  };

  it('accepts a valid telemetry event', () => {
    expect(validateTelemetryEvent(validEvent).valid).toBe(true);
  });

  it('rejects unknown telemetry fields', () => {
    const result = validateTelemetryEvent({ ...validEvent, unknownField: 'x' });
    expect(result.valid).toBe(false);
  });

  it('rejects missing required fields', () => {
    const result = validateTelemetryEvent({ eventName: 'test' }); // missing timestamp
    expect(result.valid).toBe(false);
  });

  it('rejects eventName exceeding 64 bytes', () => {
    const result = validateTelemetryEvent({
      ...validEvent,
      eventName: 'x'.repeat(65),
    });
    expect(result.valid).toBe(false);
  });

  it('rejects hostStrategy exceeding 32 bytes', () => {
    const result = validateTelemetryEvent({
      ...validEvent,
      hostStrategy: 'x'.repeat(33),
    });
    expect(result.valid).toBe(false);
  });

  it('rejects negative durationMs', () => {
    const result = validateTelemetryEvent({ ...validEvent, durationMs: -1 });
    expect(result.valid).toBe(false);
  });

  it('rejects non-finite durationMs', () => {
    const result = validateTelemetryEvent({ ...validEvent, durationMs: Infinity });
    expect(result.valid).toBe(false);
  });

  it('rejects rejection-only fields on non-rejection events', () => {
    const result = validateTelemetryEvent({
      ...validEvent,
      category: 'protocol',
      direction: 'inbound',
    });
    expect(result.valid).toBe(false);
  });

  it('accepts rejection fields on rejection events', () => {
    const result = validateTelemetryEvent(
      {
        ...validEvent,
        category: 'protocol',
        direction: 'inbound',
        decodedType: 'unknown.type',
        byteCount: 512,
      },
      true, // isRejectionEvent
    );
    expect(result.valid).toBe(true);
  });

  it('rejects measurements with more than 16 entries', () => {
    const measurements: Record<string, number> = {};
    for (let i = 0; i < 17; i++) {
      measurements[`key_${i}`] = i;
    }
    const result = validateTelemetryEvent({ ...validEvent, measurements });
    expect(result.valid).toBe(false);
  });

  it('rejects measurement keys exceeding 64 bytes', () => {
    const result = validateTelemetryEvent({
      ...validEvent,
      measurements: { ['k'.repeat(65)]: 1 },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects event exceeding 4,096 bytes total', () => {
    const result = validateTelemetryEvent({
      ...validEvent,
      result: 'x'.repeat(4000), // push over limit
    });
    // result field limited to 64 bytes, so it will fail on that first
    expect(result.valid).toBe(false);
  });

  it('rejects events containing canary patterns (credential-like)', () => {
    const result = validateTelemetryEvent({
      ...validEvent,
      result: 'sk-abcdefghijklmnopqrstuvwxyz',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects events containing pipe path patterns', () => {
    const result = validateTelemetryEvent({
      ...validEvent,
      result: '\\\\.\\pipe\\zule-stage-c-123',
    });
    expect(result.valid).toBe(false);
  });

  it('validates timestamp is RFC 3339 UTC', () => {
    const result = validateTelemetryEvent({
      ...validEvent,
      timestamp: '2024-01-15 12:00:00', // not RFC 3339
    });
    expect(result.valid).toBe(false);
  });
});
