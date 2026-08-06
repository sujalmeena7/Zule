/**
 * Stage C Release Gate — Module barrel export.
 *
 * Public API for the release gate harness: environment matrix,
 * evidence schema types, and fail-closed release decision.
 *
 * Requirements: 17.1–17.3, 17.23–17.26
 */

export {
  type WindowsOsBuild,
  OS_BUILD_LABELS,
  type EnvironmentMatrixRow,
  ReleaseGateId,
  ALL_GATE_IDS,
  type GateVerdict,
  type GateResultRecord,
  type ReleaseEvidenceSet,
  type ReleaseDecisionOutcome,
  type ReleaseDecisionFailure,
  type ReleaseDecision,
} from './types';

export {
  SUPPORTED_OS_BUILDS,
  DISTRIBUTED_ARCHITECTURES,
  SUPPORTED_WEBVIEW2_VERSIONS,
  generateEnvironmentMatrix,
  getExpectedMatrixRowCount,
  matrixRowKey,
  validateMatrixCompleteness,
} from './environmentMatrix';

export {
  evaluateReleaseDecision,
  type ReleaseDecisionOptions,
} from './decision';

export {
  assembleEvidence,
  assembleEvidenceAt,
  computeEvidenceSignature,
  validateGateMatrixCompleteness,
  type EvidenceAssemblyInput,
  type SignedEvidenceArchive,
  type MatrixCompletenessResult,
  type MatrixGap,
} from './evidenceAssembler';

export {
  executeRunner,
  computeBuildHash,
  computeArtifactHashes,
  type RunnerBuildContext,
  type ToolchainVerification,
  type ToolchainComponent,
  type ToolchainVerifier,
  type GateExecutor,
  type RunnerOptions,
  type RunnerResult,
  type RunnerError,
} from './runner';

export {
  evaluatePerformanceGate,
  evaluatePerformanceMetrics,
  MIN_FPS,
  MAX_P95_INTENT_LATENCY_MS,
  PERFORMANCE_RUN_DURATION_MS,
  type PerformanceMetrics,
  type PerformanceMetricsCollector,
  type PerformanceGateInput,
  evaluateStabilityGate,
  evaluateStabilityMetrics,
  evaluateStartStopMetrics,
  SOAK_DURATION_MS,
  START_STOP_CYCLES,
  MAX_APP_CORE_CRASHES,
  MAX_SIDECAR_CRASHES,
  MAX_ORPHAN_PROCESSES,
  MAX_LEAKED_WINDOWS,
  MAX_MEMORY_GROWTH_BYTES,
  type StabilityMetrics,
  type StabilityProcessMonitor,
  type StabilityGateInput,
  evaluateStateUpdateGate,
  evaluateStateUpdateMetrics,
  MAX_QUEUE_MESSAGE_COUNT,
  MAX_QUEUE_SIZE_BYTES,
  type QueueBoundResult,
  type RevisionAckResult,
  type LatestValueResult,
  type CoalescingResult,
  type StateUpdateMetrics,
  type StateUpdateVerifier,
  type StateUpdateGateInput,
} from './gates';

// Gate harness modules (Req 17.4–17.8)
export {
  // Types
  type GateBuildContext,
  type MetadataGateDeps,
  type WindowIdentity,
  type ColdLaunchResult,
  type ScopeHonestyGateDeps,
  type ObservabilityReport,
  type ClaimScanResult,
  type RuntimeProbeGateDeps,
  type ColdProbeResult,
  type StartupGateDeps,
  type StartupMilestones,
  type ColdStartupResult,
  type TransparencyGateDeps,
  type TransparencyAnalysis,
  type OverlayMode,
  type ScaleFactor,
  type GateFunction,
  // Gate executors
  executeMetadataGate,
  executeScopeHonestyGate,
  executeRuntimeProbeGate,
  executeStartupGate,
  executeTransparencyGate,
  // Validators
  validateWindowIdentity,
  validateColdLaunch,
  validateObservability,
  validateClaimScan,
  validateColdProbe,
  validateMilestoneOrdering,
  validateColdStartup,
  computeP95,
  validateTransparencyAnalysis,
  // Thresholds
  METADATA_COLD_LAUNCH_COUNT,
  EXPECTED_CLASS_NAME,
  EXPECTED_IMAGE_NAME,
  EXPECTED_ORIGINAL_FILENAME,
  EXPECTED_COMPANY_NAME,
  EXPECTED_PRODUCT_NAME,
  MAX_CHROME_WIDGET_WIN_OVERLAYS,
  MAX_UNDETECTABILITY_CLAIMS,
  MAX_EVASION_CLAIMS,
  MAX_CAPTURE_IMPOSSIBILITY_CLAIMS,
  MAX_IMPERSONATION_CLAIMS,
  RUNTIME_PROBE_COLD_COUNT,
  PROBE_SUCCESS_DEADLINE_MS,
  FAILED_PROBE_MAX_SIDECAR_PROCESSES,
  STARTUP_COLD_LAUNCH_COUNT,
  STARTUP_DEADLINE_MS,
  STARTUP_P95_MS,
  REQUIRED_MODES,
  REQUIRED_SCALE_FACTORS,
  MAX_NONZERO_ALPHA_PIXELS,
  MAX_PARTIAL_ALPHA_ERROR,
} from './gates';
