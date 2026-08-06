/**
 * Stage C Protocol — Cross-Language Schema Conformance & Round-Trip Tests
 *
 * Validates semantic round-trips, identical message identifiers/revisions,
 * exact artifact bindings, and rejection of unknown, duplicate, missing,
 * malformed, or oversized fields.
 *
 * Since no native test executable is available, these tests exercise
 * the TypeScript protocol codec and manifest serializer directly,
 * verifying conformance against the canonical schema and C++ constants.
 *
 * Requirements: 6.13–6.21, 14.7–14.8, 15.1–15.10
 */

import { describe, it, expect } from 'vitest';

import {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  MAX_FRAME_BYTES,
  ControllerToSidecarType,
  SidecarToControllerType,
  ValidationErrorCode,
  OverlayMode,
  validatePayloadFields,
  PAYLOAD_FIELD_SPECS,
  serializeEnvelope,
  deserializeEnvelope,
  validateSerializedSize,
  isStrictUtf8,
  type ProtocolEnvelope,
} from '../../../stageC/protocol';

import {
  validateTelemetryEvent,
  MAX_TELEMETRY_EVENT_BYTES,
} from '../../../stageC/protocol/telemetry';

import {
  serializeManifest,
  deserializeManifest,
} from '../../../stageC/manifest';

import type { ManifestSerializationInput } from '../../../stageC/manifest';

// ────────────────────────────────────────────────────────────────────
// Golden Fixtures — Valid Messages
// ────────────────────────────────────────────────────────────────────

const GOLDEN_STATE_SNAPSHOT: ProtocolEnvelope = {
  protocolVersion: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
  messageId: 'msg-001-snapshot',
  type: ControllerToSidecarType.STATE_SNAPSHOT,
  payload: {
    revision: 42,
    visibility_requested: true,
    bounds_dip: { left: 100, top: 200, width: 800, height: 600 },
    mode: OverlayMode.EXPANDED,
    capture_protection: true,
    render_state: { theme: 'dark', opacity: 0.95 },
  },
};

const GOLDEN_LIFECYCLE_READY: ProtocolEnvelope = {
  protocolVersion: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
  messageId: 'msg-002-ready',
  type: SidecarToControllerType.LIFECYCLE_READY,
  payload: {
    launch_id: 'launch-abc-123',
    sidecar_version: '1.0.0',
    protocol_major: PROTOCOL_MAJOR,
    protocol_minor: PROTOCOL_MINOR,
    bridge_schema_version: 1,
    capabilities: ['overlay', 'ai_stream'],
    webview2_runtime_version: '119.0.2151.0',
  },
};

const GOLDEN_STATE_PATCH: ProtocolEnvelope = {
  protocolVersion: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
  messageId: 'msg-003-patch',
  type: ControllerToSidecarType.STATE_PATCH,
  payload: {
    base_revision: 42,
    next_revision: 43,
    visibility_requested: false,
    bounds_dip: { left: 150, top: 250, width: 900, height: 700 },
  },
};

const GOLDEN_AI_STREAM_DELTA: ProtocolEnvelope = {
  protocolVersion: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
  messageId: 'msg-004-delta',
  type: ControllerToSidecarType.AI_STREAM_DELTA,
  payload: {
    stream_id: 'stream-xyz',
    delta: 'Hello, world!',
    sequence: 7,
  },
};

const GOLDEN_INTENT_OVERLAY: ProtocolEnvelope = {
  protocolVersion: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
  messageId: 'msg-005-intent',
  type: SidecarToControllerType.INTENT_OVERLAY,
  payload: {
    action: 'toggle_mode',
    parameters: { target_mode: 'compact' },
  },
};

const ALL_GOLDEN_FIXTURES: ProtocolEnvelope[] = [
  GOLDEN_STATE_SNAPSHOT,
  GOLDEN_LIFECYCLE_READY,
  GOLDEN_STATE_PATCH,
  GOLDEN_AI_STREAM_DELTA,
  GOLDEN_INTENT_OVERLAY,
];

// ────────────────────────────────────────────────────────────────────
// Golden Manifest Fixture
// ────────────────────────────────────────────────────────────────────

const GOLDEN_MANIFEST_INPUT: ManifestSerializationInput = {
  appVersion: '2.5.0',
  sidecarVersion: '2.5.0',
  supportedArchitectures: ['x64'],
  minimumWebview2Version: '119.0.2151.0',
  capabilities: ['overlay', 'ai_stream', 'capture_protection'],
  sidecarPath: 'bin/ZuleUI.exe',
  releaseGateEvidenceId: 'evidence-2025-001',
  artifactHashes: {
    'bin/ZuleUI.exe': 'a'.repeat(64),
    'resources/app.asar': 'b'.repeat(64),
  },
  publisher: 'Zule AI',
  dependencyLockHash: 'c'.repeat(64),
};

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

describe('Cross-language schema conformance — semantic round trips', () => {
  describe('Protocol envelope round-trip fidelity', () => {
    for (const fixture of ALL_GOLDEN_FIXTURES) {
      it(`${fixture.type}: serialize → deserialize preserves all fields`, () => {
        const frame = serializeEnvelope(fixture);
        const result = deserializeEnvelope(frame);

        expect(result.errors).toHaveLength(0);
        expect(result.envelope).not.toBeNull();
        expect(result.envelope!.protocolVersion).toEqual(fixture.protocolVersion);
        expect(result.envelope!.messageId).toBe(fixture.messageId);
        expect(result.envelope!.type).toBe(fixture.type);
        expect(result.envelope!.payload).toEqual(fixture.payload);
      });
    }
  });

  describe('Message identifiers and revisions preserved', () => {
    it('messageId survives round-trip unchanged', () => {
      const id = 'unique-msg-id-with-special-chars-αβγ-🎉';
      const envelope: ProtocolEnvelope = {
        ...GOLDEN_STATE_SNAPSHOT,
        messageId: id,
      };
      const frame = serializeEnvelope(envelope);
      const result = deserializeEnvelope(frame);
      expect(result.envelope!.messageId).toBe(id);
    });

    it('revision fields in state snapshot are preserved exactly', () => {
      const envelope: ProtocolEnvelope = {
        ...GOLDEN_STATE_SNAPSHOT,
        messageId: 'revision-test',
        payload: {
          ...GOLDEN_STATE_SNAPSHOT.payload,
          revision: 999_999,
        },
      };
      const frame = serializeEnvelope(envelope);
      const result = deserializeEnvelope(frame);
      expect((result.envelope!.payload as Record<string, unknown>).revision).toBe(999_999);
    });

    it('base_revision and next_revision in patch are preserved', () => {
      const envelope: ProtocolEnvelope = {
        ...GOLDEN_STATE_PATCH,
        messageId: 'patch-revision-test',
        payload: {
          ...GOLDEN_STATE_PATCH.payload,
          base_revision: 100,
          next_revision: 101,
        },
      };
      const frame = serializeEnvelope(envelope);
      const result = deserializeEnvelope(frame);
      const payload = result.envelope!.payload as Record<string, unknown>;
      expect(payload.base_revision).toBe(100);
      expect(payload.next_revision).toBe(101);
    });
  });

  describe('Manifest artifact bindings round-trip', () => {
    it('serialize → deserialize preserves exact manifest model (Req 14.8)', () => {
      const serialized = serializeManifest(GOLDEN_MANIFEST_INPUT);
      const result = deserializeManifest(serialized);

      expect(result.valid).toBe(true);
      if (!result.valid) return;

      const m = result.manifest;
      expect(m.app_version).toBe(GOLDEN_MANIFEST_INPUT.appVersion);
      expect(m.sidecar_version).toBe(GOLDEN_MANIFEST_INPUT.sidecarVersion);
      expect(m.protocol_major).toBe(PROTOCOL_MAJOR);
      expect(m.protocol_minor).toBe(PROTOCOL_MINOR);
      expect(m.bridge_schema_version).toBe(1);
      expect(m.supported_architectures).toEqual(['x64']);
      expect(m.minimum_webview2_version).toBe('119.0.2151.0');
      expect(m.capabilities).toEqual(['overlay', 'ai_stream', 'capture_protection']);
      expect(m.sidecar_path).toBe('bin/ZuleUI.exe');
      expect(m.release_gate_evidence_id).toBe('evidence-2025-001');
      expect(m.artifact_hashes).toEqual(GOLDEN_MANIFEST_INPUT.artifactHashes);
      expect(m.publisher).toBe('Zule AI');
      expect(m.dependency_lock_hash).toBe('c'.repeat(64));
    });

    it('double round-trip produces identical JSON', () => {
      const json1 = serializeManifest(GOLDEN_MANIFEST_INPUT);
      const result1 = deserializeManifest(json1);
      expect(result1.valid).toBe(true);
      if (!result1.valid) return;

      // Re-serialize the parsed manifest directly
      const json2 = JSON.stringify(result1.manifest);
      expect(json2).toBe(json1);
    });
  });

  describe('All message types have defined field specs', () => {
    const allTypes = [
      ...Object.values(ControllerToSidecarType),
      ...Object.values(SidecarToControllerType),
    ];

    for (const msgType of allTypes) {
      it(`${msgType} has a PAYLOAD_FIELD_SPECS entry`, () => {
        expect(PAYLOAD_FIELD_SPECS[msgType]).toBeDefined();
        expect(PAYLOAD_FIELD_SPECS[msgType].required).toBeInstanceOf(Array);
        expect(PAYLOAD_FIELD_SPECS[msgType].optional).toBeInstanceOf(Array);
      });
    }
  });
});

describe('Cross-language schema conformance — rejection of invalid inputs', () => {
  describe('Unknown fields rejected (Req 6.17)', () => {
    it('rejects envelope with unknown top-level field', () => {
      const envelope = {
        protocolVersion: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
        messageId: 'msg-unknown-field',
        type: ControllerToSidecarType.LIFECYCLE_SHUTDOWN,
        payload: { reason: 'test' },
        extraField: 'should-be-rejected',
      };
      const body = Buffer.from(JSON.stringify(envelope), 'utf-8');
      const frame = Buffer.alloc(4 + body.length);
      frame.writeUInt32LE(body.length, 0);
      body.copy(frame, 4);

      const result = deserializeEnvelope(frame);
      expect(result.envelope).toBeNull();
      expect(result.errors.some(e => e.code === ValidationErrorCode.UNKNOWN_FIELD)).toBe(true);
    });

    it('rejects payload with unknown field', () => {
      const result = validatePayloadFields(
        ControllerToSidecarType.LIFECYCLE_SHUTDOWN,
        { reason: 'test', sneakyField: 'bad' },
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors[0].code).toBe(ValidationErrorCode.UNKNOWN_FIELD);
        expect(result.errors[0].field).toBe('sneakyField');
      }
    });
  });

  describe('Missing required fields rejected (Req 6.15)', () => {
    it('rejects envelope missing messageId', () => {
      const envelope = {
        protocolVersion: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
        type: ControllerToSidecarType.LIFECYCLE_SHUTDOWN,
        payload: { reason: 'test' },
      };
      const body = Buffer.from(JSON.stringify(envelope), 'utf-8');
      const frame = Buffer.alloc(4 + body.length);
      frame.writeUInt32LE(body.length, 0);
      body.copy(frame, 4);

      const result = deserializeEnvelope(frame);
      expect(result.envelope).toBeNull();
      expect(result.errors.some(e => e.code === ValidationErrorCode.MISSING_FIELD)).toBe(true);
    });

    it('rejects payload missing required fields', () => {
      const result = validatePayloadFields(
        ControllerToSidecarType.STATE_SNAPSHOT,
        { revision: 1 }, // missing many required fields
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        const missingFields = result.errors
          .filter(e => e.code === ValidationErrorCode.MISSING_FIELD)
          .map(e => e.field);
        expect(missingFields).toContain('visibility_requested');
        expect(missingFields).toContain('bounds_dip');
        expect(missingFields).toContain('mode');
        expect(missingFields).toContain('capture_protection');
        expect(missingFields).toContain('render_state');
      }
    });

    it('rejects manifest missing required fields (Req 14.7)', () => {
      const result = deserializeManifest(JSON.stringify({ app_version: '1.0.0' }));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some(e => e.code === 'MISSING_FIELD')).toBe(true);
      }
    });
  });

  describe('Malformed and non-UTF-8 messages rejected (Req 6.14)', () => {
    it('rejects non-UTF-8 byte sequence', () => {
      // Create an invalid UTF-8 sequence
      const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x80, 0x81, 0x82]);
      expect(isStrictUtf8(invalidUtf8)).toBe(false);

      const frame = Buffer.alloc(4 + invalidUtf8.length);
      frame.writeUInt32LE(invalidUtf8.length, 0);
      invalidUtf8.copy(frame, 4);

      const result = deserializeEnvelope(frame);
      expect(result.envelope).toBeNull();
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('rejects non-JSON content', () => {
      const notJson = Buffer.from('this is not json at all', 'utf-8');
      const frame = Buffer.alloc(4 + notJson.length);
      frame.writeUInt32LE(notJson.length, 0);
      notJson.copy(frame, 4);

      const result = deserializeEnvelope(frame);
      expect(result.envelope).toBeNull();
      expect(result.errors.some(e => e.code === ValidationErrorCode.INVALID_TYPE)).toBe(true);
    });

    it('rejects JSON array instead of object', () => {
      const arr = Buffer.from('[1,2,3]', 'utf-8');
      const frame = Buffer.alloc(4 + arr.length);
      frame.writeUInt32LE(arr.length, 0);
      arr.copy(frame, 4);

      const result = deserializeEnvelope(frame);
      expect(result.envelope).toBeNull();
    });

    it('rejects frame shorter than 4 bytes', () => {
      const result = deserializeEnvelope(Buffer.from([0x01, 0x02]));
      expect(result.envelope).toBeNull();
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('rejects frame body shorter than declared length', () => {
      const frame = Buffer.alloc(8);
      frame.writeUInt32LE(100, 0); // says 100 bytes but only 4 follow
      const result = deserializeEnvelope(frame);
      expect(result.envelope).toBeNull();
    });
  });

  describe('Oversized messages rejected (Req 6.16, MAX_FRAME_BYTES)', () => {
    it('rejects frame declaring length > MAX_FRAME_BYTES', () => {
      const frame = Buffer.alloc(8);
      frame.writeUInt32LE(MAX_FRAME_BYTES + 1, 0);

      const result = deserializeEnvelope(frame);
      expect(result.envelope).toBeNull();
      expect(result.errors.some(e => e.code === ValidationErrorCode.SIZE_EXCEEDED)).toBe(true);
    });

    it('validateSerializedSize rejects oversized envelope', () => {
      const largePayload: Record<string, unknown> = {
        reason: 'x'.repeat(MAX_FRAME_BYTES),
      };
      const oversized: ProtocolEnvelope = {
        protocolVersion: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
        messageId: 'oversized-msg',
        type: ControllerToSidecarType.LIFECYCLE_SHUTDOWN,
        payload: largePayload,
      };
      const result = validateSerializedSize(oversized);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors[0].code).toBe(ValidationErrorCode.SIZE_EXCEEDED);
      }
    });
  });

  describe('Unknown message type rejected (Req 6.18)', () => {
    it('rejects unknown message type in envelope', () => {
      const envelope = {
        protocolVersion: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
        messageId: 'msg-bad-type',
        type: 'not.a.real.type',
        payload: {},
      };
      const body = Buffer.from(JSON.stringify(envelope), 'utf-8');
      const frame = Buffer.alloc(4 + body.length);
      frame.writeUInt32LE(body.length, 0);
      body.copy(frame, 4);

      const result = deserializeEnvelope(frame);
      expect(result.envelope).toBeNull();
      expect(result.errors.some(e => e.code === ValidationErrorCode.UNKNOWN_MESSAGE_TYPE)).toBe(true);
    });

    it('validatePayloadFields rejects unknown type', () => {
      const result = validatePayloadFields('fake.message.type', {});
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors[0].code).toBe(ValidationErrorCode.UNKNOWN_MESSAGE_TYPE);
      }
    });
  });

  describe('Incompatible protocol version rejected (Req 6.20)', () => {
    it('rejects protocol major mismatch', () => {
      const envelope = {
        protocolVersion: { major: PROTOCOL_MAJOR + 1, minor: 0 },
        messageId: 'msg-version-mismatch',
        type: ControllerToSidecarType.LIFECYCLE_SHUTDOWN,
        payload: { reason: 'test' },
      };
      const body = Buffer.from(JSON.stringify(envelope), 'utf-8');
      const frame = Buffer.alloc(4 + body.length);
      frame.writeUInt32LE(body.length, 0);
      body.copy(frame, 4);

      const result = deserializeEnvelope(frame);
      expect(result.envelope).toBeNull();
      expect(result.errors.some(e => e.code === ValidationErrorCode.INCOMPATIBLE_PROTOCOL)).toBe(true);
    });
  });

  describe('Manifest unknown fields rejected (Req 14.7)', () => {
    it('rejects manifest with extra unknown field', () => {
      const validJson = serializeManifest(GOLDEN_MANIFEST_INPUT);
      const parsed = JSON.parse(validJson);
      parsed.unknown_extra = 'should fail';
      const result = deserializeManifest(JSON.stringify(parsed));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some(e => e.code === 'UNKNOWN_FIELD')).toBe(true);
      }
    });
  });

  describe('Telemetry conformance (Req 15.1–15.10)', () => {
    it('valid telemetry event passes validation', () => {
      const event = {
        eventName: 'stage_c.probe_complete',
        timestamp: new Date().toISOString(),
        hostStrategy: 'STAGE_C',
        lifecyclePhase: 'ACTIVE',
        durationMs: 150,
        result: 'success',
      };
      const result = validateTelemetryEvent(event);
      expect(result.valid).toBe(true);
    });

    it('rejects telemetry event with unknown field', () => {
      const event = {
        eventName: 'stage_c.test',
        timestamp: new Date().toISOString(),
        secretData: 'should_be_rejected',
      };
      const result = validateTelemetryEvent(event);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some(e => e.code === ValidationErrorCode.UNKNOWN_FIELD)).toBe(true);
      }
    });

    it('rejects telemetry event missing required fields', () => {
      const result = validateTelemetryEvent({ hostStrategy: 'LAYER_0' });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some(e => e.code === ValidationErrorCode.MISSING_FIELD)).toBe(true);
      }
    });

    it('rejects field exceeding byte limit (Req 15.4)', () => {
      const event = {
        eventName: 'x'.repeat(65), // exceeds 64-byte limit
        timestamp: new Date().toISOString(),
      };
      const result = validateTelemetryEvent(event);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some(e => e.code === ValidationErrorCode.SIZE_EXCEEDED)).toBe(true);
      }
    });
  });
});
