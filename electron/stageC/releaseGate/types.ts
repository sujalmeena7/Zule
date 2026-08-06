/**
 * Stage C Release Gate — Evidence Schema and Type Definitions.
 *
 * Defines exact-schema types for gate evidence records, environment matrix rows,
 * and the complete evidence set required for a fail-closed production decision.
 *
 * Every result and raw summary is bound to build/artifact hashes. Missing rows,
 * fields, measurements, or results cause rejection.
 *
 * Requirements: 17.1–17.3, 17.23–17.26
 */

import type { SupportedArchitecture } from '../types';

// ────────────────────────────────────────────────────────────────────
// Environment Matrix Row
// ────────────────────────────────────────────────────────────────────

/**
 * Supported Windows OS identifiers for the environment matrix.
 * Windows 10 22H2 is the minimum; Windows 11 23H2+ are supported.
 */
export type WindowsOsBuild =
  | 'win10_22h2'
  | 'win11_23h2'
  | 'win11_24h2';

/**
 * Human-readable labels for each OS build.
 */
export const OS_BUILD_LABELS: Readonly<Record<WindowsOsBuild, string>> = {
  win10_22h2: 'Windows 10 22H2 (19045)',
  win11_23h2: 'Windows 11 23H2 (22631)',
  win11_24h2: 'Windows 11 24H2 (26100)',
} as const;

/**
 * One row in the environment matrix. Each combination of OS, architecture,
 * and WebView2 version constitutes a unique test environment.
 *
 * Requirement 17.1: Enumerate exact environment matrix.
 */
export interface EnvironmentMatrixRow {
  /** Windows OS build identifier */
  readonly osBuild: WindowsOsBuild;

  /** Distributed architecture for this row */
  readonly architecture: SupportedArchitecture;

  /** Supported WebView2 Runtime version under test */
  readonly webView2Version: string;
}

// ────────────────────────────────────────────────────────────────────
// Gate Identifiers
// ────────────────────────────────────────────────────────────────────

/**
 * All release gates that must pass for production enablement.
 * Each gate is executed once per environment matrix row.
 */
export enum ReleaseGateId {
  METADATA = 'metadata',
  SCOPE_HONESTY = 'scope_honesty',
  RUNTIME_PROBE = 'runtime_probe',
  STARTUP = 'startup',
  TRANSPARENCY = 'transparency',
  INPUT = 'input',
  GEOMETRY = 'geometry',
  IPC_SECURITY = 'ipc_security',
  BRIDGE_SECURITY = 'bridge_security',
  CAPTURE = 'capture',
  CAPTURE_FALLBACK = 'capture_fallback',
  FALLBACK = 'fallback',
  DIAGNOSTIC_RETRY = 'diagnostic_retry',
  PERFORMANCE = 'performance',
  STABILITY = 'stability',
  PACKAGING = 'packaging',
  TELEMETRY_PRIVACY = 'telemetry_privacy',
  TELEMETRY_SCHEMA = 'telemetry_schema',
  STATE_UPDATE = 'state_update',
}

/**
 * Complete list of gate IDs for enumeration.
 */
export const ALL_GATE_IDS: readonly ReleaseGateId[] = Object.values(ReleaseGateId);

// ────────────────────────────────────────────────────────────────────
// Gate Result Record
// ────────────────────────────────────────────────────────────────────

/**
 * Pass or fail result for a single gate execution.
 */
export type GateVerdict = 'pass' | 'fail';

/**
 * A single gate result record, bound to build hash and environment context.
 *
 * Requirement 17.3: Bind test build hash, OS build, architecture,
 * WebView2_Runtime version, App_Core version, sidecar version,
 * raw measurement summary, and pass-or-fail result.
 */
export interface GateResultRecord {
  /** The gate that was executed */
  readonly gateId: ReleaseGateId;

  /** SHA-256 hash of the build under test */
  readonly buildHash: string;

  /** Windows OS build of the test environment */
  readonly osBuild: WindowsOsBuild;

  /** Architecture of the test environment */
  readonly architecture: SupportedArchitecture;

  /** WebView2 Runtime version in the test environment */
  readonly webView2Version: string;

  /** App Core version under test */
  readonly appVersion: string;

  /** Sidecar version under test */
  readonly sidecarVersion: string;

  /** Machine-readable raw measurement summary for this gate */
  readonly rawMeasurementSummary: string;

  /** Pass or fail verdict */
  readonly verdict: GateVerdict;

  /** ISO-8601 timestamp of when the gate was executed */
  readonly executedAt: string;
}

// ────────────────────────────────────────────────────────────────────
// Complete Evidence Set
// ────────────────────────────────────────────────────────────────────

/**
 * The complete evidence set for a release decision.
 * Must contain one passing GateResultRecord per (gate × matrix row).
 *
 * Requirement 17.2: Execute every applicable gate for every environment row.
 * Requirement 17.23: Any missing row, result, field, or measurement → failed.
 * Requirement 17.24: Approve only when EVERY gate passes for EVERY row.
 */
export interface ReleaseEvidenceSet {
  /** SHA-256 hash of the build these results apply to */
  readonly buildHash: string;

  /** SHA-256 hashes of each distributed artifact, keyed by relative path */
  readonly artifactHashes: Readonly<Record<string, string>>;

  /** The full environment matrix that was tested */
  readonly matrix: readonly EnvironmentMatrixRow[];

  /** All gate result records — must cover every (gate × row) combination */
  readonly results: readonly GateResultRecord[];

  /** ISO-8601 timestamp when evidence assembly completed */
  readonly assembledAt: string;
}

// ────────────────────────────────────────────────────────────────────
// Release Decision
// ────────────────────────────────────────────────────────────────────

/**
 * The outcome of the fail-closed release decision.
 */
export type ReleaseDecisionOutcome = 'approved' | 'failed';

/**
 * A single reason why the release decision failed.
 */
export interface ReleaseDecisionFailure {
  /** Human-readable description of what is missing or failed */
  readonly reason: string;

  /** The gate ID involved, if applicable */
  readonly gateId?: ReleaseGateId;

  /** The environment matrix row involved, if applicable */
  readonly matrixRow?: EnvironmentMatrixRow;
}

/**
 * The complete release decision result.
 *
 * Requirement 17.24: Approve only when every gate has complete passing
 * evidence for every required environment-matrix row and distributed artifact.
 * Requirement 17.26: Reject waivers from runtime flags, env vars, persisted
 * settings, remote content, or diagnostic retry.
 */
export interface ReleaseDecision {
  /** Approved only when every gate passes for every row */
  readonly outcome: ReleaseDecisionOutcome;

  /** SHA-256 build hash this decision is bound to (null on failure) */
  readonly buildHash: string | null;

  /** Approval identifier (non-null only when outcome is 'approved') */
  readonly approvalId: string | null;

  /** All failures that caused rejection (empty when approved) */
  readonly failures: readonly ReleaseDecisionFailure[];
}
