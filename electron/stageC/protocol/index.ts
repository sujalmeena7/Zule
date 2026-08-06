/**
 * Stage C Protocol — Public API
 *
 * Re-exports all protocol schemas, validators, and type definitions.
 */

// Canonical schema source — types, enums, constants, validators
export {
  // Version constants
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  BRIDGE_SCHEMA_VERSION,
  SCHEMA_HASH_VERSION,

  // Size limits
  MAX_FRAME_BYTES,
  MAX_BRIDGE_MESSAGE_BYTES,
  MAX_TELEMETRY_EVENT_BYTES,
  MAX_REPLAY_CACHE_ENTRIES,
  MAX_QUEUED_MESSAGES,
  MAX_QUEUED_BYTES,

  // Message type enums
  ControllerToSidecarType,
  SidecarToControllerType,
  MessageDirection,

  // Type sets
  CONTROLLER_TO_SIDECAR_TYPES,
  SIDECAR_TO_CONTROLLER_TYPES,

  // Domain enums
  OverlayMode,
  HostStrategy,
  StageCPhase,
  StageCFailureReason,
  ValidationErrorCode,

  // Geometry
  type DipRectangle,

  // Payload interfaces — Controller → Sidecar
  type LifecycleShutdownPayload,
  type StateSnapshotPayload,
  type StatePatchPayload,
  type SurfaceSetBoundsPayload,
  type SurfaceSetVisibilityPayload,
  type SurfaceSetCaptureProtectionPayload,
  type AiStreamDeltaPayload,
  type AiStreamCompletedPayload,
  type AiStreamFailedPayload,
  type OperationResultPayload,

  // Payload interfaces — Sidecar → Controller
  type LifecycleReadyPayload,
  type LifecycleShutdownAckPayload,
  type SurfaceFirstFrameReadyPayload,
  type StateSnapshotAckPayload,
  type StatePatchAckPayload,
  type SurfaceBoundsChangedPayload,
  type SurfaceCaptureProtectionResultPayload,
  type IntentOverlayPayload,
  type IntentAiPayload,
  type IntentAudioPayload,
  type IntentScreenCapturePayload,
  type DiagnosticContentPolicyEventPayload,

  // Payload maps
  type ControllerToSidecarPayloadMap,
  type SidecarToControllerPayloadMap,

  // Field specs
  type FieldSpec,
  PAYLOAD_FIELD_SPECS,

  // Validators
  type AllowedMessageType,
  type ValidationError,
  type ValidationResult,
  validatePayloadFields,
  validateDipRectangle,
  getMessageDirection,
  validateMessageDirection,
} from './schema';

// Protocol envelope
export {
  type ProtocolVersion,
  type ProtocolEnvelope,
  type DeserializeResult,
  serializeEnvelope,
  readFrameLength,
  validateFrameSize,
  isStrictUtf8,
  deserializeEnvelope,
  validateSerializedSize,
} from './envelope';

// Overlay projection
export {
  type OverlayProjection,
  type OverlayPatch,
  validateProjection,
  validatePatch,
} from './projection';

// Ready handshake
export {
  type ReadyHandshake,
  validateHandshake,
  verifyHandshake,
} from './handshake';

// Bridge adapter messages
export {
  BridgeMethodType,
  BridgeEventType,
  type BridgeRegion,
  type BridgeMethodBase,
  type RequestOverlayActionMessage,
  type RequestAIMessage,
  type RequestAudioMessage,
  type RequestScreenCaptureMessage,
  type ReportDragRegionsMessage,
  type ReportInteractiveRegionsMessage,
  type BridgeMethodMessage,
  type BridgeEventBase,
  type OnStateSnapshotEvent,
  type OnStatePatchEvent,
  type OnOperationResultEvent,
  type BridgeEventMessage,
  validateBridgeMessageSize,
  validateBridgeMethod,
  validateBridgeEvent,
} from './bridge';

// Telemetry
export {
  TELEMETRY_COMMON_FIELDS,
  TELEMETRY_REJECTION_FIELDS,
  ALL_TELEMETRY_FIELDS,
  TELEMETRY_REQUIRED_FIELDS,
  MAX_MEASUREMENT_ENTRIES,
  MAX_MEASUREMENT_KEY_BYTES,
  CANARY_EXCLUSION_PATTERNS,
  type TelemetryEvent,
  validateTelemetryEvent,
} from './telemetry';
