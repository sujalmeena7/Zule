/**
 * Stage C Runtime Probe — Type definitions.
 *
 * Shared types for the Electron prelaunch runtime probe and Stage C controller.
 * These types enforce content-free failure reporting and exact schema matching.
 *
 * Requirements: 4.2–4.10, 16.1–16.7
 */

// --------------------------------------------------------------------
// Failure Reason Enum — content-free typed probe failures
// --------------------------------------------------------------------

/**
 * Every probe failure is identified by exactly one typed reason.
 * Reasons are content-free: they identify the check that failed without
 * embedding user data, paths, secrets, or payloads.
 */
export enum ProbeFailureReason {
  /** process.platform !== 'win32' */
  NON_WINDOWS = 'NON_WINDOWS',

  /** App Core architecture not in supported set (x64, arm64) */
  UNSUPPORTED_ARCHITECTURE = 'UNSUPPORTED_ARCHITECTURE',

  /** Stage C manifest file missing or unreadable */
  MANIFEST_MISSING = 'MANIFEST_MISSING',

  /** Stage C manifest does not match exact schema */
  MANIFEST_SCHEMA_INVALID = 'MANIFEST_SCHEMA_INVALID',

  /** Stage C manifest integrity check failed */
  MANIFEST_INTEGRITY_FAILURE = 'MANIFEST_INTEGRITY_FAILURE',

  /** Sidecar binary not found at manifest-declared resource path */
  SIDECAR_NOT_FOUND = 'SIDECAR_NOT_FOUND',

  /** Sidecar architecture does not match App Core architecture */
  SIDECAR_ARCHITECTURE_MISMATCH = 'SIDECAR_ARCHITECTURE_MISMATCH',

  /** Protocol major version does not match between App Core and manifest */
  PROTOCOL_MAJOR_MISMATCH = 'PROTOCOL_MAJOR_MISMATCH',

  /** Bridge schema version incompatible */
  BRIDGE_SCHEMA_INCOMPATIBLE = 'BRIDGE_SCHEMA_INCOMPATIBLE',

  /** WebView2 Runtime not installed */
  WEBVIEW2_NOT_FOUND = 'WEBVIEW2_NOT_FOUND',

  /** WebView2 Runtime version below manifest minimum */
  WEBVIEW2_VERSION_TOO_OLD = 'WEBVIEW2_VERSION_TOO_OLD',

  /** Dependency lock integrity check failed */
  DEPENDENCY_LOCK_INTEGRITY_FAILURE = 'DEPENDENCY_LOCK_INTEGRITY_FAILURE',

  /** Dependency lock missing or unreadable */
  DEPENDENCY_LOCK_MISSING = 'DEPENDENCY_LOCK_MISSING',

  /** Production: release-gate approval identifier missing or invalid */
  RELEASE_GATE_MISSING = 'RELEASE_GATE_MISSING',

  /** Production: sidecar signature not explicitly valid */
  SIGNATURE_INVALID = 'SIGNATURE_INVALID',

  /** Production: sidecar signature bound to wrong publisher */
  SIGNATURE_WRONG_PUBLISHER = 'SIGNATURE_WRONG_PUBLISHER',

  /** Production: sidecar signature verification is unknown/offline/warning/indeterminate */
  SIGNATURE_INDETERMINATE = 'SIGNATURE_INDETERMINATE',

  /** Production: App Core and sidecar release versions do not match exactly */
  VERSION_MISMATCH = 'VERSION_MISMATCH',

  /** Diagnostic: local diagnostic marker missing */
  DIAGNOSTIC_MARKER_MISSING = 'DIAGNOSTIC_MARKER_MISSING',

  /** Absolute 3-second deadline expired */
  DEADLINE_EXPIRED = 'DEADLINE_EXPIRED',

  /** Native boundary failed to load on Windows */
  NATIVE_BOUNDARY_FAILURE = 'NATIVE_BOUNDARY_FAILURE',
}

// --------------------------------------------------------------------
// Runtime Probe Result
// --------------------------------------------------------------------

export interface RuntimeProbeResult {
  /** Whether the sidecar is eligible for launch */
  eligible: boolean;

  /** Typed content-free failure reason; null when eligible */
  reason: ProbeFailureReason | null;
}

// --------------------------------------------------------------------
// Stage C Manifest — exact schema
// --------------------------------------------------------------------

export type SupportedArchitecture = 'x64' | 'arm64';

export interface StageCManifest {
  /** Exact App Core version this manifest was built with */
  app_version: string;

  /** Exact sidecar release version */
  sidecar_version: string;

  /** Protocol major version — must equal App Core's expected major */
  protocol_major: number;

  /** Protocol minor version */
  protocol_minor: number;

  /** Bridge schema version */
  bridge_schema_version: number;

  /** Supported sidecar architectures */
  supported_architectures: SupportedArchitecture[];

  /** Minimum WebView2 Runtime version required */
  minimum_webview2_version: string;

  /** Capability identifiers */
  capabilities: string[];

  /** SHA-256 hash of the dependency lock file */
  dependency_lock_hash: string;

  /** Relative path to sidecar binary within resources */
  sidecar_path: string;

  /** Release gate evidence identifier (null in diagnostic builds) */
  release_gate_evidence_id: string | null;

  /** SHA-256 hash of each packaged artifact, keyed by relative path */
  artifact_hashes: Record<string, string>;

  /** Publisher identity for signature verification */
  publisher: string;
}

// --------------------------------------------------------------------
// Manifest Schema Fields — for exact validation
// --------------------------------------------------------------------

export const MANIFEST_REQUIRED_FIELDS: readonly string[] = [
  'app_version',
  'sidecar_version',
  'protocol_major',
  'protocol_minor',
  'bridge_schema_version',
  'supported_architectures',
  'minimum_webview2_version',
  'capabilities',
  'dependency_lock_hash',
  'sidecar_path',
  'release_gate_evidence_id',
  'artifact_hashes',
  'publisher',
] as const;

// --------------------------------------------------------------------
// App Core protocol expectations
// --------------------------------------------------------------------

/**
 * The protocol major version App Core expects.
 * Exact equality with the manifest's protocol_major is required.
 */
export const APP_CORE_PROTOCOL_MAJOR = 1;

/**
 * The minimum bridge schema version App Core supports.
 * The manifest's bridge_schema_version must be >= this value.
 */
export const APP_CORE_MIN_BRIDGE_SCHEMA = 1;

/**
 * The maximum bridge schema version App Core supports.
 * The manifest's bridge_schema_version must be <= this value.
 */
export const APP_CORE_MAX_BRIDGE_SCHEMA = 1;

// --------------------------------------------------------------------
// Probe configuration
// --------------------------------------------------------------------

/** Absolute deadline in milliseconds for the entire probe */
export const PROBE_DEADLINE_MS = 3000;

/** Stage C resources subdirectory relative to process.resourcesPath */
export const STAGE_C_RESOURCES_DIR = 'stage-c';

/** Expected manifest filename */
export const MANIFEST_FILENAME = 'manifest.json';

/** Expected dependency lock filename */
export const DEPENDENCY_LOCK_FILENAME = 'dependency-lock.json';

/** Diagnostic build marker filename */
export const DIAGNOSTIC_MARKER_FILENAME = '.stage-c-diagnostic';
