/**
 * Stage C Protocol — Envelope Definition
 *
 * Defines the ProtocolEnvelope structure, serialization/deserialization,
 * framing (32-bit LE length + UTF-8 JSON), and size validation.
 *
 * Requirements: 6.13–6.17
 */

import {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  MAX_FRAME_BYTES,
  AllowedMessageType,
  ValidationResult,
  ValidationError,
  ValidationErrorCode,
  CONTROLLER_TO_SIDECAR_TYPES,
  SIDECAR_TO_CONTROLLER_TYPES,
  validatePayloadFields,
} from './schema';

// ────────────────────────────────────────────────────────────────────
// Protocol Envelope Interface
// ────────────────────────────────────────────────────────────────────

export interface ProtocolVersion {
  major: number;
  minor: number;
}

export interface ProtocolEnvelope {
  protocolVersion: ProtocolVersion;
  messageId: string;
  type: AllowedMessageType;
  payload: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────────────
// Envelope field spec
// ────────────────────────────────────────────────────────────────────

const ENVELOPE_REQUIRED_FIELDS: readonly string[] = [
  'protocolVersion',
  'messageId',
  'type',
  'payload',
] as const;

const PROTOCOL_VERSION_FIELDS: readonly string[] = ['major', 'minor'] as const;

// ────────────────────────────────────────────────────────────────────
// Serialization
// ────────────────────────────────────────────────────────────────────

/**
 * Serializes a ProtocolEnvelope into a framed buffer.
 * Frame: [4-byte LE length][UTF-8 JSON body]
 */
export function serializeEnvelope(envelope: ProtocolEnvelope): Buffer {
  const json = JSON.stringify(envelope);
  const body = Buffer.from(json, 'utf-8');
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

/**
 * Extracts the declared frame length from a buffer's first 4 bytes.
 * Returns null if the buffer has fewer than 4 bytes.
 */
export function readFrameLength(buffer: Buffer): number | null {
  if (buffer.length < 4) return null;
  return buffer.readUInt32LE(0);
}

// ────────────────────────────────────────────────────────────────────
// Deserialization & Validation
// ────────────────────────────────────────────────────────────────────

export interface DeserializeResult {
  envelope: ProtocolEnvelope | null;
  errors: ValidationError[];
}

/**
 * Validates that a frame length does not exceed the limit before allocation.
 * Requirement 6.16: reject before payload allocation or JSON parsing.
 */
export function validateFrameSize(declaredLength: number): ValidationResult {
  if (declaredLength > MAX_FRAME_BYTES) {
    return {
      valid: false,
      errors: [{
        code: ValidationErrorCode.SIZE_EXCEEDED,
        message: `Frame length ${declaredLength} exceeds maximum ${MAX_FRAME_BYTES} bytes`,
      }],
    };
  }
  return { valid: true };
}

/**
 * Validates strict UTF-8 encoding of a buffer.
 * Returns false if the buffer contains invalid UTF-8 sequences.
 */
export function isStrictUtf8(buffer: Buffer): boolean {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    decoder.decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deserializes a framed buffer into a ProtocolEnvelope.
 * Validates: frame size, UTF-8, JSON, exact schema, protocol version.
 */
export function deserializeEnvelope(frame: Buffer): DeserializeResult {
  const errors: ValidationError[] = [];

  // Must have at least 4 bytes for length
  if (frame.length < 4) {
    errors.push({
      code: ValidationErrorCode.INVALID_TYPE,
      message: 'Frame too short to contain length header',
    });
    return { envelope: null, errors };
  }

  // Read and validate frame length
  const declaredLength = frame.readUInt32LE(0);
  const sizeResult = validateFrameSize(declaredLength);
  if (!sizeResult.valid) {
    return { envelope: null, errors: sizeResult.errors };
  }

  // Extract body
  const body = frame.subarray(4, 4 + declaredLength);
  if (body.length < declaredLength) {
    errors.push({
      code: ValidationErrorCode.INVALID_TYPE,
      message: 'Frame body shorter than declared length',
    });
    return { envelope: null, errors };
  }

  // Validate strict UTF-8
  if (!isStrictUtf8(body)) {
    errors.push({
      code: ValidationErrorCode.INVALID_TYPE,
      message: 'Frame body is not valid UTF-8',
    });
    return { envelope: null, errors };
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf-8'));
  } catch {
    errors.push({
      code: ValidationErrorCode.INVALID_TYPE,
      message: 'Frame body is not valid JSON',
    });
    return { envelope: null, errors };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    errors.push({
      code: ValidationErrorCode.INVALID_TYPE,
      message: 'Envelope must be a JSON object',
    });
    return { envelope: null, errors };
  }

  const obj = parsed as Record<string, unknown>;

  // Validate envelope fields — reject unknown
  const objKeys = Object.keys(obj);
  for (const key of objKeys) {
    if (!ENVELOPE_REQUIRED_FIELDS.includes(key)) {
      errors.push({
        code: ValidationErrorCode.UNKNOWN_FIELD,
        field: key,
        message: `Unknown envelope field '${key}'`,
      });
    }
  }

  // Validate required envelope fields
  for (const field of ENVELOPE_REQUIRED_FIELDS) {
    if (!(field in obj)) {
      errors.push({
        code: ValidationErrorCode.MISSING_FIELD,
        field,
        message: `Missing envelope field '${field}'`,
      });
    }
  }

  if (errors.length > 0) {
    return { envelope: null, errors };
  }

  // Validate protocolVersion structure
  const pv = obj.protocolVersion;
  if (typeof pv !== 'object' || pv === null || Array.isArray(pv)) {
    errors.push({
      code: ValidationErrorCode.INVALID_TYPE,
      field: 'protocolVersion',
      message: 'protocolVersion must be an object',
    });
    return { envelope: null, errors };
  }

  const pvObj = pv as Record<string, unknown>;
  const pvKeys = Object.keys(pvObj);
  for (const key of pvKeys) {
    if (!PROTOCOL_VERSION_FIELDS.includes(key)) {
      errors.push({
        code: ValidationErrorCode.UNKNOWN_FIELD,
        field: `protocolVersion.${key}`,
        message: `Unknown field '${key}' in protocolVersion`,
      });
    }
  }

  for (const field of PROTOCOL_VERSION_FIELDS) {
    if (!(field in pvObj)) {
      errors.push({
        code: ValidationErrorCode.MISSING_FIELD,
        field: `protocolVersion.${field}`,
        message: `Missing field '${field}' in protocolVersion`,
      });
    } else if (typeof pvObj[field] !== 'number' || !Number.isInteger(pvObj[field] as number)) {
      errors.push({
        code: ValidationErrorCode.INVALID_TYPE,
        field: `protocolVersion.${field}`,
        message: `protocolVersion.${field} must be an integer`,
      });
    }
  }

  if (errors.length > 0) {
    return { envelope: null, errors };
  }

  // Validate protocol major compatibility
  if ((pvObj.major as number) !== PROTOCOL_MAJOR) {
    errors.push({
      code: ValidationErrorCode.INCOMPATIBLE_PROTOCOL,
      field: 'protocolVersion.major',
      message: `Protocol major ${pvObj.major} is incompatible with expected ${PROTOCOL_MAJOR}`,
    });
    return { envelope: null, errors };
  }

  // Validate messageId
  if (typeof obj.messageId !== 'string' || obj.messageId.length === 0) {
    errors.push({
      code: ValidationErrorCode.INVALID_TYPE,
      field: 'messageId',
      message: 'messageId must be a non-empty string',
    });
    return { envelope: null, errors };
  }

  // Validate type is a known message type
  const type = obj.type as string;
  if (!CONTROLLER_TO_SIDECAR_TYPES.has(type) && !SIDECAR_TO_CONTROLLER_TYPES.has(type)) {
    errors.push({
      code: ValidationErrorCode.UNKNOWN_MESSAGE_TYPE,
      message: `Unknown message type: ${type}`,
    });
    return { envelope: null, errors };
  }

  // Validate payload is an object
  if (typeof obj.payload !== 'object' || obj.payload === null || Array.isArray(obj.payload)) {
    errors.push({
      code: ValidationErrorCode.INVALID_TYPE,
      field: 'payload',
      message: 'payload must be a JSON object',
    });
    return { envelope: null, errors };
  }

  // Validate payload fields for the given type
  const payloadResult = validatePayloadFields(type, obj.payload as Record<string, unknown>);
  if (!payloadResult.valid) {
    return { envelope: null, errors: payloadResult.errors };
  }

  const envelope: ProtocolEnvelope = {
    protocolVersion: { major: pvObj.major as number, minor: pvObj.minor as number },
    messageId: obj.messageId as string,
    type: type as AllowedMessageType,
    payload: obj.payload as Record<string, unknown>,
  };

  return { envelope, errors: [] };
}

/**
 * Validates that a serialized envelope size does not exceed MAX_FRAME_BYTES.
 */
export function validateSerializedSize(envelope: ProtocolEnvelope): ValidationResult {
  const json = JSON.stringify(envelope);
  const byteLength = Buffer.byteLength(json, 'utf-8');
  if (byteLength > MAX_FRAME_BYTES) {
    return {
      valid: false,
      errors: [{
        code: ValidationErrorCode.SIZE_EXCEEDED,
        message: `Serialized envelope (${byteLength} bytes) exceeds maximum ${MAX_FRAME_BYTES} bytes`,
      }],
    };
  }
  return { valid: true };
}
