/**
 * Stage C Release Gate — Gate Implementations barrel export.
 *
 * Requirements: 17.9–17.10, 17.13–17.16, 17.19–17.21
 */

export {
  REQUIRED_CLICK_TARGETS,
  REQUIRED_KEYBOARD_IME_ACTIONS,
  REQUIRED_SCROLL_ACTIONS,
  REQUIRED_DRAGS_PER_SCALE,
  MAX_COORDINATE_ERROR_PX,
  type InputActionResult,
  type InputGateDeps,
  executeInputGate,
} from './inputGate';

export {
  REQUIRED_SCALE_FACTORS,
  REQUIRED_TOPOLOGIES,
  MAX_EDGE_ERROR_PX,
  type GeometryGateDeps,
  executeGeometryGate,
} from './geometryGate';

export {
  REQUIRED_CAPTURE_CYCLES,
  MAX_READBACK_LATENCY_MS,
  REQUIRED_RECORDERS,
  type CaptureGateDeps,
  executeCaptureGate,
} from './captureGate';

export {
  MAX_LAYER0_RECOVERY_MS,
  REQUIRED_CAPTURE_FAILURE_TYPES,
  type CaptureFallbackGateDeps,
  executeCaptureFallbackGate,
} from './captureFallbackGate';

export {
  REQUIRED_INJECTION_REPETITIONS,
  MAX_RECOVERY_DURATION_MS,
  MAX_DUPLICATE_VISIBLE_SURFACES,
  REQUIRED_FAILURE_TYPES,
  type LifecycleFailureInjectionResult,
  type FallbackGateDeps,
  executeFallbackGate,
} from './fallbackGate';

export {
  EXPECTED_ACCEPTED_RETRIES,
  REJECTION_VERIFICATION_ATTEMPTS,
  type DiagnosticRetryAttemptResult,
  type DiagnosticRetryGateDeps,
  executeDiagnosticRetryGate,
} from './diagnosticRetryGate';

export {
  executePackagingGate,
  type PackagingGateDeps,
  type PackageArtifact,
  type SignatureStatus,
  type SignatureVerificationResult,
  type UpdaterTransactionResult,
} from './packagingGate';

export {
  executeTelemetryPrivacyGate,
  type TelemetryPrivacyGateDeps,
  type CanaryInjection,
  type CanaryObservationResult,
  ProhibitedCategory,
  ALL_PROHIBITED_CATEGORIES,
  generateCanary,
  generateAllCanaryInjections,
} from './telemetryPrivacyGate';

export {
  executeTelemetrySchemaGate,
  createDefaultTelemetrySchemaGateDeps,
  type TelemetrySchemaGateDeps,
  type SchemaTestCase,
  type SchemaTestCaseResult,
  type SchemaViolationType,
  generateAllSchemaTestCases,
} from './telemetrySchemaGate';
