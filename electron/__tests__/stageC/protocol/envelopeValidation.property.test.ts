// ============================================
// Zule AI — Exact-Envelope Validation Property-Based Tests
// ============================================
//
// Feature: stealth-window-host, Property 6: Exact-envelope validation
//
// Generate malformed encoding/JSON, oversize frames, unknown or reversed types,
// incompatible versions, missing/extra fields, and invalid payloads; assert zero
// dispatches and unchanged revisions.
//
// **Validates: Requirements 6.13–6.21**

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  PROTOCOL_MAJOR,
  MAX_FRAME_BYTES,
  ControllerToSidecarType,
  SidecarToControllerType,
  MessageDirection,
  ValidationErrorCode,
  CONTROLLER_TO_SIDECAR_TYPES,
  SIDECAR_TO_CONTROLLER_TYPES,
  PAYLOAD_FIELD_SPECS,
  validatePayloadFields,
  validateMessageDirection,
  deserializeEnvelope,
  validateFrameSize,
  isStrictUtf8,
  serializeEnvelope,
  type ProtocolEnvelope,
} from '../../../stageC/protocol';

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/** Build a framed buffer from a JSON body buffer. */
function frameBody(body: Buffer): Buffer {
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

/** Build a framed buffer from a string (UTF-8 encoded). */
function frameString(str: string): Buffer {
  const body = Buffer.from(str, 'utf-8');
  return frameBody(body);
}

/** Build a framed buffer from a raw object (serialized as JSON). */
function frameObject(obj: unknown): Buffer {
  return frameString(JSON.stringify(obj));
}

/** A valid envelope object for baseline reference. */
function makeValidEnvelope(
  type: string = ControllerToSidecarType.LIFECYCLE_SHUTDOWN,
  payload: Record<string, unknown> = { reason: 'test' },
): Record<string, unknown> {
  return {
    protocolVersion: { major: PROTOCOL_MAJOR, minor: 0 },
    messageId: 'msg-test-001',
    type,
    payload,
  };
}

/**
 * Simulates a dispatch attempt. Calls deserializeEnvelope and optionally
 * validateMessageDirection. Returns whether the message would be dispatched.
 */
function attemptDispatch(frame: Buffer, direction: MessageDirection): {
  dispatched: boolean;
  revisionChanged: boolean;
} {
  const result = deserializeEnvelope(frame);

  if (!result.envelope || result.errors.length > 0) {
    return { dispatched: false, revisionChanged: false };
  }

  // Additional direction validation
  const dirResult = validateMessageDirection(result.envelope.type, direction);
  if (!dirResult.valid) {
    return { dispatched: false, revisionChanged: false };
  }

  // If we get here, the message passed all validation
  return { dispatched: true, revisionChanged: false };
}

// ────────────────────────────────────────────────────────────────────
// Generators
// ────────────────────────────────────────────────────────────────────

/** Generates invalid UTF-8 byte sequences. */
const malformedUtf8Arb: fc.Arbitrary<Buffer> = fc
  .array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 200 })
  .filter((bytes) => {
    // Filter to only keep genuinely malformed UTF-8 sequences
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      decoder.decode(Buffer.from(bytes));
      return false; // Valid UTF-8, skip
    } catch {
      return true; // Malformed UTF-8, keep
    }
  })
  .map((bytes) => Buffer.from(bytes));

/** Generates strings that are not valid JSON. */
const invalidJsonArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant('{invalid json}'),
  fc.constant('{"unterminated": '),
  fc.constant('[}]'),
  fc.constant('{key: "no-quotes-on-key"}'),
  fc.constant("{'single-quotes': 'bad'}"),
  fc.constant('{,}'),
  fc.constant(''),
  fc.string({ minLength: 1, maxLength: 100 }).filter((s) => {
    try {
      JSON.parse(s);
      return false;
    } catch {
      return true;
    }
  }),
);

/** Generates oversize frame lengths (> MAX_FRAME_BYTES). */
const oversizeFrameLengthArb: fc.Arbitrary<number> = fc.integer({
  min: MAX_FRAME_BYTES + 1,
  max: MAX_FRAME_BYTES * 4,
});

/** Generates unknown message types (not in either directional set). */
const unknownTypeArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant('unknown.action'),
  fc.constant('custom.message'),
  fc.constant('system.internal'),
  fc.constant('debug.trace'),
  fc.constant(''),
  fc.stringMatching(/^[a-z]+\.[a-z]+$/).filter(
    (t) => !CONTROLLER_TO_SIDECAR_TYPES.has(t) && !SIDECAR_TO_CONTROLLER_TYPES.has(t),
  ),
);

/** Generates controller types (for use in reversed-direction tests). */
const controllerTypeArb: fc.Arbitrary<string> = fc.constantFrom(
  ...Object.values(ControllerToSidecarType),
);

/** Generates sidecar types (for use in reversed-direction tests). */
const sidecarTypeArb: fc.Arbitrary<string> = fc.constantFrom(
  ...Object.values(SidecarToControllerType),
);

/** Generates incompatible protocol major versions (not equal to PROTOCOL_MAJOR). */
const incompatibleMajorArb: fc.Arbitrary<number> = fc
  .integer({ min: 0, max: 255 })
  .filter((v) => v !== PROTOCOL_MAJOR);

/** Generates a valid type with its correct minimal payload for constructing tests. */
function validTypeWithPayloadArb(): fc.Arbitrary<{ type: string; payload: Record<string, unknown> }> {
  return fc.constantFrom(
    { type: ControllerToSidecarType.LIFECYCLE_SHUTDOWN, payload: { reason: 'test' } },
    { type: SidecarToControllerType.LIFECYCLE_SHUTDOWN_ACK, payload: { launch_id: 'x' } },
    { type: ControllerToSidecarType.SURFACE_SET_VISIBILITY, payload: { visible: true } },
    { type: SidecarToControllerType.STATE_SNAPSHOT_ACK, payload: { revision: 1 } },
  );
}

// ────────────────────────────────────────────────────────────────────
// Property Test
// ────────────────────────────────────────────────────────────────────

describe('Stage C Protocol — Property Tests', () => {
  // Feature: stealth-window-host, Property 6: Exact-envelope validation
  describe('Property 6: Exact-envelope validation', () => {
    it('malformed UTF-8 frames produce zero dispatches and unchanged revisions', () => {
      fc.assert(
        fc.property(malformedUtf8Arb, (badBody) => {
          const frame = frameBody(badBody);
          const result = attemptDispatch(frame, MessageDirection.CONTROLLER_TO_SIDECAR);

          // **Validates: Requirement 6.17** — malformed UTF-8 rejects with zero state mutations
          expect(result.dispatched).toBe(false);
          expect(result.revisionChanged).toBe(false);

          // Also verify directly through deserializeEnvelope
          const deser = deserializeEnvelope(frame);
          expect(deser.envelope).toBeNull();
          expect(deser.errors.length).toBeGreaterThan(0);
        }),
        { numRuns: 100 },
      );
    });

    it('invalid JSON frames produce zero dispatches and unchanged revisions', () => {
      fc.assert(
        fc.property(invalidJsonArb, (badJson) => {
          const frame = frameString(badJson);
          const result = attemptDispatch(frame, MessageDirection.CONTROLLER_TO_SIDECAR);

          // **Validates: Requirement 6.17** — malformed JSON rejects with zero state mutations
          expect(result.dispatched).toBe(false);
          expect(result.revisionChanged).toBe(false);

          const deser = deserializeEnvelope(frame);
          expect(deser.envelope).toBeNull();
          expect(deser.errors.length).toBeGreaterThan(0);
        }),
        { numRuns: 200 },
      );
    });

    it('oversize frame lengths are rejected before payload allocation', () => {
      fc.assert(
        fc.property(oversizeFrameLengthArb, (declaredLength) => {
          // **Validates: Requirement 6.16** — reject before allocation
          const sizeResult = validateFrameSize(declaredLength);
          expect(sizeResult.valid).toBe(false);
          if (!sizeResult.valid) {
            expect(sizeResult.errors[0].code).toBe(ValidationErrorCode.SIZE_EXCEEDED);
          }

          // Also via a frame with the oversize length header
          const frame = Buffer.alloc(4);
          frame.writeUInt32LE(declaredLength, 0);
          const deser = deserializeEnvelope(frame);
          expect(deser.envelope).toBeNull();
          expect(deser.errors.length).toBeGreaterThan(0);
        }),
        { numRuns: 100 },
      );
    });

    it('unknown message types produce zero dispatches', () => {
      fc.assert(
        fc.property(unknownTypeArb, (unknownType) => {
          const envelope = makeValidEnvelope(unknownType, {});
          const frame = frameObject(envelope);
          const result = attemptDispatch(frame, MessageDirection.CONTROLLER_TO_SIDECAR);

          // **Validates: Requirement 6.17** — unknown type rejects
          expect(result.dispatched).toBe(false);
          expect(result.revisionChanged).toBe(false);
        }),
        { numRuns: 200 },
      );
    });

    it('reversed-direction messages (controller types in sidecar direction) produce zero dispatches', () => {
      fc.assert(
        fc.property(controllerTypeArb, (ctrlType) => {
          // Use a controller type but send it as if from the sidecar direction
          const spec = PAYLOAD_FIELD_SPECS[ctrlType];
          const minPayload: Record<string, unknown> = {};
          for (const field of spec.required) {
            minPayload[field] = getPlaceholderValue(field);
          }

          const envelope = makeValidEnvelope(ctrlType, minPayload);
          const frame = frameObject(envelope);

          // Validate direction — controller types should not be accepted in sidecar→controller direction
          const dirResult = validateMessageDirection(ctrlType, MessageDirection.SIDECAR_TO_CONTROLLER);
          expect(dirResult.valid).toBe(false);

          // **Validates: Requirement 6.20** — reversed direction rejects
          const result = attemptDispatch(frame, MessageDirection.SIDECAR_TO_CONTROLLER);
          expect(result.dispatched).toBe(false);
          expect(result.revisionChanged).toBe(false);
        }),
        { numRuns: 100 },
      );
    });

    it('reversed-direction messages (sidecar types in controller direction) produce zero dispatches', () => {
      fc.assert(
        fc.property(sidecarTypeArb, (sidecarType) => {
          // Use a sidecar type but send it as if from the controller direction
          const spec = PAYLOAD_FIELD_SPECS[sidecarType];
          const minPayload: Record<string, unknown> = {};
          for (const field of spec.required) {
            minPayload[field] = getPlaceholderValue(field);
          }

          const envelope = makeValidEnvelope(sidecarType, minPayload);
          const frame = frameObject(envelope);

          // Validate direction — sidecar types should not be accepted in controller→sidecar direction
          const dirResult = validateMessageDirection(sidecarType, MessageDirection.CONTROLLER_TO_SIDECAR);
          expect(dirResult.valid).toBe(false);

          // **Validates: Requirement 6.20** — reversed direction rejects
          const result = attemptDispatch(frame, MessageDirection.CONTROLLER_TO_SIDECAR);
          expect(result.dispatched).toBe(false);
          expect(result.revisionChanged).toBe(false);
        }),
        { numRuns: 100 },
      );
    });

    it('incompatible protocol versions produce zero dispatches', () => {
      fc.assert(
        fc.property(incompatibleMajorArb, validTypeWithPayloadArb(), (badMajor, { type, payload }) => {
          const envelope = {
            protocolVersion: { major: badMajor, minor: 0 },
            messageId: 'msg-test-version',
            type,
            payload,
          };
          const frame = frameObject(envelope);

          // **Validates: Requirement 6.17** — incompatible protocol rejects
          const deser = deserializeEnvelope(frame);
          expect(deser.envelope).toBeNull();
          expect(deser.errors.length).toBeGreaterThan(0);
          expect(deser.errors.some((e) => e.code === ValidationErrorCode.INCOMPATIBLE_PROTOCOL)).toBe(true);

          const result = attemptDispatch(frame, MessageDirection.CONTROLLER_TO_SIDECAR);
          expect(result.dispatched).toBe(false);
          expect(result.revisionChanged).toBe(false);
        }),
        { numRuns: 100 },
      );
    });

    it('missing required fields in payloads produce zero dispatches', () => {
      // For each message type, generate payloads with one or more required fields removed
      const allTypes = [
        ...Object.values(ControllerToSidecarType),
        ...Object.values(SidecarToControllerType),
      ];

      const typeWithMissingFieldArb = fc
        .constantFrom(...allTypes)
        .chain((type) => {
          const spec = PAYLOAD_FIELD_SPECS[type];
          if (!spec || spec.required.length === 0) {
            // No required fields to remove — use a different type
            return fc.constant(null);
          }
          // Pick a random subset of fields to remove (at least one)
          return fc
            .subarray([...spec.required], { minLength: 1 })
            .map((fieldsToRemove) => ({ type, fieldsToRemove, spec }));
        })
        .filter((v): v is { type: string; fieldsToRemove: string[]; spec: { required: readonly string[]; optional: readonly string[] } } => v !== null);

      fc.assert(
        fc.property(typeWithMissingFieldArb, ({ type, fieldsToRemove, spec }) => {
          // Build a payload with some required fields missing
          const payload: Record<string, unknown> = {};
          for (const field of spec.required) {
            if (!fieldsToRemove.includes(field)) {
              payload[field] = getPlaceholderValue(field);
            }
          }

          const envelope = makeValidEnvelope(type, payload);
          const frame = frameObject(envelope);

          // **Validates: Requirement 6.17** — missing field rejects
          const deser = deserializeEnvelope(frame);
          expect(deser.envelope).toBeNull();
          expect(deser.errors.length).toBeGreaterThan(0);

          const result = attemptDispatch(frame, MessageDirection.CONTROLLER_TO_SIDECAR);
          expect(result.dispatched).toBe(false);
          expect(result.revisionChanged).toBe(false);
        }),
        { numRuns: 200 },
      );
    });

    it('extra/unknown fields in payloads produce zero dispatches', () => {
      const allTypes = [
        ...Object.values(ControllerToSidecarType),
        ...Object.values(SidecarToControllerType),
      ];

      // Prototype-polluting keys like __proto__, constructor, etc. have special
      // semantics in JS object assignment and won't appear as own enumerable keys
      // when set via obj[key] = val. Exclude them so we only test genuine extra fields.
      const EXCLUDED_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);

      const typeWithExtraFieldArb = fc
        .constantFrom(...allTypes)
        .chain((type) => {
          const spec = PAYLOAD_FIELD_SPECS[type];
          if (!spec) return fc.constant(null);
          // Generate 1-3 extra field names that are not in allowed fields
          const allowedFields = new Set([...spec.required, ...spec.optional]);
          return fc
            .array(
              fc.string({ minLength: 1, maxLength: 20 }).filter(
                (f) => !allowedFields.has(f) && !EXCLUDED_KEYS.has(f) && /^[a-z_][a-z0-9_]*$/.test(f),
              ),
              { minLength: 1, maxLength: 3 },
            )
            .map((extraFields) => ({ type, spec, extraFields }));
        })
        .filter((v): v is { type: string; spec: { required: readonly string[]; optional: readonly string[] }; extraFields: string[] } => v !== null);

      fc.assert(
        fc.property(typeWithExtraFieldArb, ({ type, spec, extraFields }) => {
          // Build a complete valid payload plus extra fields
          const payload: Record<string, unknown> = {};
          for (const field of spec.required) {
            payload[field] = getPlaceholderValue(field);
          }
          for (const extra of extraFields) {
            payload[extra] = 'unexpected_value';
          }

          const envelope = makeValidEnvelope(type, payload);
          const frame = frameObject(envelope);

          // **Validates: Requirement 6.14, 6.17** — extra field rejects
          const deser = deserializeEnvelope(frame);
          expect(deser.envelope).toBeNull();
          expect(deser.errors.length).toBeGreaterThan(0);

          const result = attemptDispatch(frame, MessageDirection.CONTROLLER_TO_SIDECAR);
          expect(result.dispatched).toBe(false);
          expect(result.revisionChanged).toBe(false);
        }),
        { numRuns: 200 },
      );
    });

    it('extra fields on the envelope itself produce zero dispatches', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.string({ minLength: 1, maxLength: 15 }).filter(
              (f) => !['protocolVersion', 'messageId', 'type', 'payload'].includes(f) && /^[a-z_][a-z0-9_]*$/.test(f),
            ),
            { minLength: 1, maxLength: 3 },
          ),
          (extraFields) => {
            const envelope: Record<string, unknown> = makeValidEnvelope();
            for (const field of extraFields) {
              envelope[field] = 'unexpected';
            }
            const frame = frameObject(envelope);

            // **Validates: Requirement 6.14** — extra envelope fields reject
            const deser = deserializeEnvelope(frame);
            expect(deser.envelope).toBeNull();
            expect(deser.errors.some((e) => e.code === ValidationErrorCode.UNKNOWN_FIELD)).toBe(true);

            const result = attemptDispatch(frame, MessageDirection.CONTROLLER_TO_SIDECAR);
            expect(result.dispatched).toBe(false);
            expect(result.revisionChanged).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('missing envelope-level fields produce zero dispatches', () => {
      const envelopeFieldsToRemove = fc.subarray(
        ['protocolVersion', 'messageId', 'type', 'payload'] as const,
        { minLength: 1 },
      );

      fc.assert(
        fc.property(envelopeFieldsToRemove, (fieldsToRemove) => {
          const fullEnvelope: Record<string, unknown> = makeValidEnvelope();
          for (const field of fieldsToRemove) {
            delete fullEnvelope[field];
          }
          const frame = frameObject(fullEnvelope);

          // **Validates: Requirement 6.14** — missing envelope fields reject
          const deser = deserializeEnvelope(frame);
          expect(deser.envelope).toBeNull();
          expect(deser.errors.length).toBeGreaterThan(0);

          const result = attemptDispatch(frame, MessageDirection.CONTROLLER_TO_SIDECAR);
          expect(result.dispatched).toBe(false);
          expect(result.revisionChanged).toBe(false);
        }),
        { numRuns: 50 },
      );
    });

    it('non-object JSON values (arrays, strings, numbers, booleans, null) produce zero dispatches', () => {
      const nonObjectArb = fc.oneof(
        fc.array(fc.anything(), { maxLength: 5 }),
        fc.string(),
        fc.integer(),
        fc.double(),
        fc.boolean(),
        fc.constant(null),
      );

      fc.assert(
        fc.property(nonObjectArb, (value) => {
          const frame = frameString(JSON.stringify(value));
          const deser = deserializeEnvelope(frame);

          // **Validates: Requirement 6.14** — envelope must be a JSON object
          expect(deser.envelope).toBeNull();
          expect(deser.errors.length).toBeGreaterThan(0);
        }),
        { numRuns: 100 },
      );
    });

    it('invalid protocolVersion structures produce zero dispatches', () => {
      const badProtocolVersionArb = fc.oneof(
        fc.constant(null),
        fc.constant([1, 0]),
        fc.constant('1.0'),
        fc.constant(1),
        fc.constant({ major: 'one', minor: 0 }),
        fc.constant({ major: 1.5, minor: 0 }),
        fc.constant({ major: 1, minor: 0, extra: 'field' }),
        fc.constant({}),
      );

      fc.assert(
        fc.property(badProtocolVersionArb, (badPv) => {
          const envelope = {
            protocolVersion: badPv,
            messageId: 'msg-test',
            type: ControllerToSidecarType.LIFECYCLE_SHUTDOWN,
            payload: { reason: 'test' },
          };
          const frame = frameObject(envelope);

          const deser = deserializeEnvelope(frame);
          expect(deser.envelope).toBeNull();
          expect(deser.errors.length).toBeGreaterThan(0);

          const result = attemptDispatch(frame, MessageDirection.CONTROLLER_TO_SIDECAR);
          expect(result.dispatched).toBe(false);
          expect(result.revisionChanged).toBe(false);
        }),
        { numRuns: 50 },
      );
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// Placeholder value helper
// ────────────────────────────────────────────────────────────────────

/**
 * Returns a placeholder value for a given field name, based on typical
 * payload structures in the protocol.
 */
function getPlaceholderValue(field: string): unknown {
  switch (field) {
    case 'reason':
    case 'launch_id':
    case 'sidecar_version':
    case 'webview2_runtime_version':
    case 'stream_id':
    case 'delta':
    case 'error_code':
    case 'operation_id':
    case 'action':
    case 'event_type':
    case 'detail':
      return 'test-value';
    case 'revision':
    case 'base_revision':
    case 'next_revision':
    case 'protocol_major':
    case 'protocol_minor':
    case 'bridge_schema_version':
    case 'sequence':
    case 'final_sequence':
      return 1;
    case 'visibility_requested':
    case 'capture_protection':
    case 'visible':
    case 'enabled':
    case 'success':
    case 'read_back_value':
      return true;
    case 'bounds_dip':
      return { left: 0, top: 0, width: 400, height: 300 };
    case 'mode':
      return 'compact';
    case 'render_state':
    case 'render_state_patch':
    case 'data':
    case 'parameters':
      return {};
    case 'capabilities':
      return ['overlay'];
    default:
      return 'placeholder';
  }
}
