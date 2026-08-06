/**
 * Stage C Strategy Selector — Hard-deny Stage A/B, allow only LAYER_0 or STAGE_C.
 *
 * This module is the single point of runtime strategy selection for the
 * Stage C controller. It enforces that:
 *
 * 1. Only LAYER_0 and STAGE_C are selectable host strategies (Req 1.1).
 * 2. Stage A is permanently FAILED_DISABLED_A5_A6 (Req 1.2).
 * 3. Stage B is permanently DISABLED_NOT_EVALUATED (Req 1.3).
 * 4. Stage A selection is rejected from every input surface (Req 1.4).
 * 5. Stage B selection is rejected from every input surface (Req 1.5).
 * 6. Production gate waivers are rejected from runtime flags, env vars,
 *    persisted settings, remote content, or diagnostic retry (Req 17.26).
 *
 * Historical source (Stage A/B code in win32/) may remain for diagnostics,
 * but this selector never imports, calls, or delegates to it.
 *
 * Requirements: 1.1–1.5, 17.25–17.26
 */

import { HostStrategy } from './protocol/schema';

// Re-export HostStrategy for consumers that only need the selector
export { HostStrategy };

// ────────────────────────────────────────────────────────────────────
// Immutable Historical Status Constants
// ────────────────────────────────────────────────────────────────────

/**
 * Stage A status: failed and permanently disabled.
 * Mandatory real-Windows gates A5 (interaction) and A6 (geometry/lifecycle)
 * failed. This value is immutable and for diagnostic reporting only.
 */
export const STAGE_A_STATUS = 'FAILED_DISABLED_A5_A6' as const;

/**
 * Stage B status: disabled, never evaluated.
 * No release evidence exists; implementation presence does not imply approval.
 * This value is immutable and for diagnostic reporting only.
 */
export const STAGE_B_STATUS = 'DISABLED_NOT_EVALUATED' as const;

export type StageAStatus = typeof STAGE_A_STATUS;
export type StageBStatus = typeof STAGE_B_STATUS;

// ────────────────────────────────────────────────────────────────────
// Rejection Error
// ────────────────────────────────────────────────────────────────────

/**
 * Sources from which Stage A/B selection might be attempted.
 * Every source is explicitly rejected.
 */
export type RejectionSource =
  | 'build_flag'
  | 'runtime_flag'
  | 'environment_variable'
  | 'persisted_setting'
  | 'retry_logic'
  | 'fallback_logic'
  | 'remote_content'
  | 'gate_waiver';

export interface StrategyRejection {
  /** Which defunct stage was requested */
  readonly stage: 'A' | 'B';
  /** The source that attempted the selection */
  readonly source: RejectionSource;
  /** Immutable status of the rejected stage */
  readonly status: StageAStatus | StageBStatus;
  /** Human-readable reason */
  readonly reason: string;
}

// ────────────────────────────────────────────────────────────────────
// Known Stage A/B Identifiers — used to detect and reject attempts
// ────────────────────────────────────────────────────────────────────

/** Identifiers that map to Stage A (reparenting) in any input surface. */
const STAGE_A_IDENTIFIERS: ReadonlySet<string> = new Set([
  'stage_a',
  'stagea',
  'stage-a',
  'reparent',
  'stealth_host',
  'stealthhost',
  'stealth-host',
]);

/** Identifiers that map to Stage B (layered/offscreen) in any input surface. */
const STAGE_B_IDENTIFIERS: ReadonlySet<string> = new Set([
  'stage_b',
  'stageb',
  'stage-b',
  'layered',
  'offscreen',
  'offscreen_render',
]);

/** Environment variable names that historically controlled Stage A/B. */
const DENIED_ENV_VARS: ReadonlySet<string> = new Set([
  'ZULE_HOST_STRATEGY',
  'ZULE_STEALTH_MODE',
  'ZULE_STAGE_A',
  'ZULE_STAGE_B',
  'ZULE_REPARENT',
  'ZULE_LAYERED',
  'ZULE_OFFSCREEN',
]);

// ────────────────────────────────────────────────────────────────────
// Rejection Functions
// ────────────────────────────────────────────────────────────────────

/**
 * Hard-deny any attempt to select Stage A from any input surface.
 * Returns a StrategyRejection describing why the request was denied.
 */
export function rejectStageA(source: RejectionSource): StrategyRejection {
  return Object.freeze({
    stage: 'A',
    source,
    status: STAGE_A_STATUS,
    reason: `Stage A selection denied from ${source}: mandatory gates A5 and A6 failed. Status: ${STAGE_A_STATUS}`,
  });
}

/**
 * Hard-deny any attempt to select Stage B from any input surface.
 * Returns a StrategyRejection describing why the request was denied.
 */
export function rejectStageB(source: RejectionSource): StrategyRejection {
  return Object.freeze({
    stage: 'B',
    source,
    status: STAGE_B_STATUS,
    reason: `Stage B selection denied from ${source}: not evaluated, no release evidence. Status: ${STAGE_B_STATUS}`,
  });
}

// ────────────────────────────────────────────────────────────────────
// Input Surface Validation
// ────────────────────────────────────────────────────────────────────

/**
 * Check if a value string maps to a Stage A identifier.
 */
function isStageAValue(value: string): boolean {
  return STAGE_A_IDENTIFIERS.has(value.toLowerCase().trim());
}

/**
 * Check if a value string maps to a Stage B identifier.
 */
function isStageBValue(value: string): boolean {
  return STAGE_B_IDENTIFIERS.has(value.toLowerCase().trim());
}

/**
 * Validate a strategy value from any input surface.
 * Returns null if the value is acceptable (LAYER_0 or STAGE_C),
 * or a StrategyRejection if the value targets Stage A or Stage B.
 */
export function validateStrategyInput(
  value: string,
  source: RejectionSource,
): StrategyRejection | null {
  const normalized = value.toUpperCase().trim();

  // Accept only the two valid strategies
  if (normalized === HostStrategy.LAYER_0 || normalized === HostStrategy.STAGE_C) {
    return null;
  }

  // Reject Stage A identifiers
  if (isStageAValue(value)) {
    return rejectStageA(source);
  }

  // Reject Stage B identifiers
  if (isStageBValue(value)) {
    return rejectStageB(source);
  }

  // Reject any unrecognized value as well — only LAYER_0 and STAGE_C are valid
  // Treat unknown values as attempted Stage A (since it was the historical default)
  return rejectStageA(source);
}

// ────────────────────────────────────────────────────────────────────
// Environment Scanning
// ────────────────────────────────────────────────────────────────────

/**
 * Scan environment variables for any Stage A/B selection attempts.
 * Returns all rejections found, or an empty array if environment is clean.
 */
export function scanEnvironmentForDenied(
  env: Record<string, string | undefined> = process.env,
): StrategyRejection[] {
  const rejections: StrategyRejection[] = [];

  for (const varName of DENIED_ENV_VARS) {
    const value = env[varName];
    if (value !== undefined && value !== '') {
      if (isStageAValue(value) || varName.includes('STAGE_A') || varName.includes('REPARENT')) {
        rejections.push(rejectStageA('environment_variable'));
      } else if (isStageBValue(value) || varName.includes('STAGE_B') || varName.includes('LAYERED') || varName.includes('OFFSCREEN')) {
        rejections.push(rejectStageB('environment_variable'));
      } else {
        // Any value in a denied env var is rejected
        rejections.push(rejectStageA('environment_variable'));
      }
    }
  }

  return rejections;
}

// ────────────────────────────────────────────────────────────────────
// Strategy Selection — The Only Runtime Output
// ────────────────────────────────────────────────────────────────────

export interface StrategySelectionContext {
  /** Whether the platform is Windows */
  isWindows: boolean;
  /** Whether Stage C has already failed this app launch */
  stageCFailedThisLaunch: boolean;
  /** Whether a runtime probe determined Stage C is eligible */
  stageCEligible: boolean;
}

/**
 * Select the runtime host strategy.
 *
 * This function has exactly TWO possible outputs: LAYER_0 or STAGE_C.
 * Stage A and Stage B are never returned regardless of input.
 *
 * The selector:
 * - Returns LAYER_0 on non-Windows platforms (Req 16.1)
 * - Returns LAYER_0 if Stage C failed this app launch (Req 4.12)
 * - Returns STAGE_C only if the runtime probe confirms eligibility
 * - Returns LAYER_0 in all other cases (safe default)
 *
 * Requirements: 1.1, 16.1, 17.25
 */
export function selectStrategy(context: StrategySelectionContext): HostStrategy {
  // Non-Windows: always Layer 0
  if (!context.isWindows) {
    return HostStrategy.LAYER_0;
  }

  // Stage C failed this launch: retain Layer 0
  if (context.stageCFailedThisLaunch) {
    return HostStrategy.LAYER_0;
  }

  // Stage C eligible: select Stage C
  if (context.stageCEligible) {
    return HostStrategy.STAGE_C;
  }

  // Default: Layer 0
  return HostStrategy.LAYER_0;
}

// ────────────────────────────────────────────────────────────────────
// Diagnostic Status Report
// ────────────────────────────────────────────────────────────────────

export interface StrategyStatusReport {
  /** Current selectable strategies (always exactly LAYER_0 and STAGE_C) */
  readonly selectableStrategies: readonly [typeof HostStrategy.LAYER_0, typeof HostStrategy.STAGE_C];
  /** Immutable Stage A status */
  readonly stageAStatus: StageAStatus;
  /** Immutable Stage B status */
  readonly stageBStatus: StageBStatus;
  /** Whether Stage A is eligible for runtime selection (always false) */
  readonly stageAEligible: false;
  /** Whether Stage B is eligible for runtime selection (always false) */
  readonly stageBEligible: false;
}

/**
 * Get the immutable strategy status report for diagnostics.
 * Stage A and Stage B statuses are fixed constants — they cannot be
 * changed by any runtime input.
 */
export function getStrategyStatus(): StrategyStatusReport {
  return Object.freeze({
    selectableStrategies: Object.freeze([HostStrategy.LAYER_0, HostStrategy.STAGE_C]) as readonly [typeof HostStrategy.LAYER_0, typeof HostStrategy.STAGE_C],
    stageAStatus: STAGE_A_STATUS,
    stageBStatus: STAGE_B_STATUS,
    stageAEligible: false,
    stageBEligible: false,
  });
}
