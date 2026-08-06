/**
 * Stage C Release Gate — Gate Implementations barrel export.
 *
 * Requirements: 17.19–17.21
 */

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
