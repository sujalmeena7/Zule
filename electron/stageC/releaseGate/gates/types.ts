/**
 * Stage C Release Gate — Gate Harness Shared Types.
 *
 * Defines injectable dependency interfaces and shared configuration
 * for individual gate harness modules. Each gate accepts dependencies
 * that can be satisfied by real Windows implementations in CI or by
 * mocks in unit tests.
 *
 * Requirements: 17.4–17.8
 */

import type { EnvironmentMatrixRow, GateResultRecord } from '../types';

// ────────────────────────────────────────────────────────────────────
// Gate Configuration
// ────────────────────────────────────────────────────────────────────

/**
 * Common build context provided to all gate executions.
 */
export interface GateBuildContext {
  /** SHA-256 hash of the build under test */
  readonly buildHash: string;

  /** App Core version under test */
  readonly appVersion: string;

  /** Sidecar version under test */
  readonly sidecarVersion: string;
}

// ────────────────────────────────────────────────────────────────────
// Metadata Gate Dependencies (Req 17.4)
// ────────────────────────────────────────────────────────────────────

/**
 * Window identity information returned from a cold launch enumeration.
 */
export interface WindowIdentity {
  /** Win32 class name of the window */
  readonly className: string;

  /** Window title text */
  readonly title: string;

  /** Image (executable) name of the owning process */
  readonly imageName: string;

  /** OriginalFilename from the version resource */
  readonly originalFilename: string;

  /** CompanyName from the version resource */
  readonly companyName: string;

  /** ProductName from the version resource */
  readonly productName: string;

  /** Whether this is the Floating_Surface window */
  readonly isFloatingSurface: boolean;
}

/**
 * Result from a single cold launch enumeration.
 */
export interface ColdLaunchResult {
  /** All top-level windows owned by the sidecar after launch */
  readonly windows: readonly WindowIdentity[];

  /** All top-level Chrome_WidgetWin overlay windows detected */
  readonly chromeWidgetWinOverlayCount: number;
}

/**
 * Injectable dependency for the metadata gate.
 */
export interface MetadataGateDeps {
  /**
   * Perform a cold launch and enumerate windows.
   * Resolves with window identity info after a full cold start.
   */
  coldLaunch(env: EnvironmentMatrixRow): Promise<ColdLaunchResult>;
}

// ────────────────────────────────────────────────────────────────────
// Scope-and-Honesty Gate Dependencies (Req 17.5)
// ────────────────────────────────────────────────────────────────────

/**
 * Observable artifacts that the scope-and-honesty gate verifies.
 */
export interface ObservabilityReport {
  /** Dashboard window is observable */
  readonly dashboardObservable: boolean;

  /** Process tree is observable */
  readonly processObservable: boolean;

  /** Loaded modules are observable */
  readonly moduleObservable: boolean;

  /** Child windows are observable */
  readonly childWindowObservable: boolean;

  /** WebView2 Runtime artifacts are observable */
  readonly webView2Observable: boolean;
}

/**
 * Release material claim scan result.
 */
export interface ClaimScanResult {
  /** Number of undetectability claims found */
  readonly undetectabilityClaims: number;

  /** Number of evasion claims found */
  readonly evasionClaims: number;

  /** Number of capture-impossibility claims found */
  readonly captureImpossibilityClaims: number;

  /** Number of impersonation claims found */
  readonly impersonationClaims: number;
}

/**
 * Injectable dependency for the scope-and-honesty gate.
 */
export interface ScopeHonestyGateDeps {
  /** Verify continued observability of all required components */
  verifyObservability(env: EnvironmentMatrixRow): Promise<ObservabilityReport>;

  /** Scan release material for prohibited claims */
  scanReleaseMaterial(): Promise<ClaimScanResult>;
}

// ────────────────────────────────────────────────────────────────────
// Runtime-Probe Gate Dependencies (Req 17.6)
// ────────────────────────────────────────────────────────────────────

/**
 * Result of a single cold probe execution.
 */
export interface ColdProbeResult {
  /** Whether the probe succeeded (eligible) */
  readonly success: boolean;

  /** Duration in milliseconds */
  readonly durationMs: number;

  /** Number of sidecar processes started during the probe */
  readonly sidecarProcessesStarted: number;
}

/**
 * Injectable dependency for the runtime-probe gate.
 */
export interface RuntimeProbeGateDeps {
  /**
   * Execute a single cold probe without starting the sidecar.
   * Returns probe outcome, duration, and any accidentally started processes.
   */
  executeColdProbe(env: EnvironmentMatrixRow): Promise<ColdProbeResult>;
}

// ────────────────────────────────────────────────────────────────────
// Startup Gate Dependencies (Req 17.7)
// ────────────────────────────────────────────────────────────────────

/**
 * Ordered startup milestone timestamps from a cold launch.
 */
export interface StartupMilestones {
  /** Timestamp when authentication completed (ms since epoch) */
  readonly authenticationAt: number;

  /** Timestamp when Ready_Handshake received (ms since epoch) */
  readonly readyHandshakeAt: number;

  /** Timestamp when snapshot acknowledgement received (ms since epoch) */
  readonly snapshotAckAt: number;

  /** Timestamp when first-frame readiness confirmed (ms since epoch) */
  readonly firstFrameAt: number;

  /** Total duration from cold start to first-frame (ms) */
  readonly totalDurationMs: number;
}

/**
 * Result of a single cold startup measurement.
 */
export interface ColdStartupResult {
  /** Whether all milestones occurred in order within the deadline */
  readonly success: boolean;

  /** Milestone timestamps (null if startup failed) */
  readonly milestones: StartupMilestones | null;

  /** Total startup duration in milliseconds */
  readonly durationMs: number;
}

/**
 * Injectable dependency for the startup gate.
 */
export interface StartupGateDeps {
  /**
   * Execute a cold launch and measure startup milestones.
   * Returns ordered milestone timestamps.
   */
  measureColdStartup(env: EnvironmentMatrixRow): Promise<ColdStartupResult>;
}

// ────────────────────────────────────────────────────────────────────
// Transparency Gate Dependencies (Req 17.8)
// ────────────────────────────────────────────────────────────────────

/**
 * Overlay display mode for transparency testing.
 */
export type OverlayMode = 'compact' | 'expanded' | 'maximized';

/**
 * DPI scale factor percentage for transparency testing.
 */
export type ScaleFactor = 100 | 125 | 150 | 200;

/**
 * Result of alpha analysis for declared transparent regions.
 */
export interface TransparencyAnalysis {
  /** Display mode tested */
  readonly mode: OverlayMode;

  /** Scale factor tested */
  readonly scaleFactor: ScaleFactor;

  /** Number of nonzero-alpha pixels found in transparent regions */
  readonly nonzeroAlphaPixelCount: number;

  /** Maximum partial-alpha error in 8-bit units (0–255) */
  readonly maxPartialAlphaError: number;
}

/**
 * Injectable dependency for the transparency gate.
 */
export interface TransparencyGateDeps {
  /**
   * Capture and analyze transparency for a given mode and scale.
   * Returns pixel-level alpha analysis of declared transparent regions.
   */
  analyzeTransparency(
    env: EnvironmentMatrixRow,
    mode: OverlayMode,
    scaleFactor: ScaleFactor,
  ): Promise<TransparencyAnalysis>;
}

// ────────────────────────────────────────────────────────────────────
// Gate Function Type
// ────────────────────────────────────────────────────────────────────

/**
 * Common gate function signature. Each gate takes an environment row,
 * build context, and its specific dependencies, returning an evidence record.
 */
export type GateFunction<TDeps> = (
  env: EnvironmentMatrixRow,
  buildContext: GateBuildContext,
  deps: TDeps,
) => Promise<GateResultRecord>;
