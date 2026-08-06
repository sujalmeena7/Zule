/**
 * Stage C Release Gate — Input Gate.
 *
 * Verifies that the Stage C sidecar correctly routes clicks, keyboard/IME actions,
 * scroll events, and drags at each tested scale with zero misroutes, coordinate
 * error ≤ 1 physical pixel, and zero retained pointer captures.
 *
 * Requirement 17.9: 100 click targets, 100 keyboard and IME actions,
 * 100 vertical and horizontal scroll actions, and 20 drags per tested scale
 * with zero misroutes, coordinate error ≤ 1 physical pixel, and zero retained
 * pointer captures.
 */

import { type EnvironmentMatrixRow, type GateResultRecord, ReleaseGateId } from '../types';

// ────────────────────────────────────────────────────────────────────
// Gate Thresholds (Req 17.9)
// ────────────────────────────────────────────────────────────────────

/** Number of click targets that must be tested per tested scale. */
export const REQUIRED_CLICK_TARGETS = 100;

/** Number of keyboard and IME actions that must be tested per tested scale. */
export const REQUIRED_KEYBOARD_IME_ACTIONS = 100;

/** Number of vertical and horizontal scroll actions that must be tested per tested scale. */
export const REQUIRED_SCROLL_ACTIONS = 100;

/** Number of drags that must be tested per tested scale. */
export const REQUIRED_DRAGS_PER_SCALE = 20;

/** Maximum allowed coordinate error in physical pixels. */
export const MAX_COORDINATE_ERROR_PX = 1;

/** Maximum allowed misroutes (must be zero). */
export const MAX_MISROUTES = 0;

/** Maximum allowed retained pointer captures (must be zero). */
export const MAX_RETAINED_POINTER_CAPTURES = 0;

// ────────────────────────────────────────────────────────────────────
// Input Gate Dependencies (injectable for testing)
// ────────────────────────────────────────────────────────────────────

/**
 * Result from a single input action measurement.
 */
export interface InputActionResult {
  /** Whether the action was correctly routed to the intended target. */
  readonly routed: boolean;

  /** Coordinate error in physical pixels (distance from intended target). */
  readonly coordinateErrorPx: number;

  /** Whether a pointer capture was retained after the action completed. */
  readonly retainedCapture: boolean;
}

/**
 * Injectable dependency interface for the input gate.
 * Allows test harness to provide real or simulated input measurements.
 */
export interface InputGateDeps {
  /** Execute click target tests and return results for each target. */
  runClickTargets(scale: number): Promise<readonly InputActionResult[]>;

  /** Execute keyboard and IME action tests and return results. */
  runKeyboardImeActions(scale: number): Promise<readonly InputActionResult[]>;

  /** Execute vertical and horizontal scroll action tests and return results. */
  runScrollActions(scale: number): Promise<readonly InputActionResult[]>;

  /** Execute drag tests and return results for each drag. */
  runDragActions(scale: number): Promise<readonly InputActionResult[]>;

  /** Return the list of scale factors to test for this environment. */
  getTestedScales(): readonly number[];
}

// ────────────────────────────────────────────────────────────────────
// Gate Execution
// ────────────────────────────────────────────────────────────────────

interface InputGateMetrics {
  totalClicks: number;
  totalKeyboardIme: number;
  totalScrolls: number;
  totalDrags: number;
  misroutes: number;
  maxCoordinateErrorPx: number;
  retainedCaptures: number;
  testedScales: readonly number[];
}

function evaluateResults(
  results: readonly InputActionResult[],
  metrics: { misroutes: number; maxCoordinateErrorPx: number; retainedCaptures: number },
): void {
  for (const result of results) {
    if (!result.routed) {
      metrics.misroutes++;
    }
    if (result.coordinateErrorPx > metrics.maxCoordinateErrorPx) {
      metrics.maxCoordinateErrorPx = result.coordinateErrorPx;
    }
    if (result.retainedCapture) {
      metrics.retainedCaptures++;
    }
  }
}

/**
 * Executes the input gate for a given environment row.
 *
 * Requirement 17.9: 100 click targets, 100 keyboard/IME actions,
 * 100 scroll actions, 20 drags per tested scale. Zero misroutes,
 * coordinate error ≤ 1 physical pixel, zero retained pointer captures.
 */
export async function executeInputGate(
  row: EnvironmentMatrixRow,
  deps: InputGateDeps,
  buildHash: string,
  appVersion: string,
  sidecarVersion: string,
): Promise<GateResultRecord> {
  const testedScales = deps.getTestedScales();

  const metrics: InputGateMetrics = {
    totalClicks: 0,
    totalKeyboardIme: 0,
    totalScrolls: 0,
    totalDrags: 0,
    misroutes: 0,
    maxCoordinateErrorPx: 0,
    retainedCaptures: 0,
    testedScales,
  };

  const failures: string[] = [];

  for (const scale of testedScales) {
    // Click targets
    const clickResults = await deps.runClickTargets(scale);
    metrics.totalClicks += clickResults.length;
    if (clickResults.length < REQUIRED_CLICK_TARGETS) {
      failures.push(`Scale ${scale}: only ${clickResults.length}/${REQUIRED_CLICK_TARGETS} click targets tested`);
    }
    evaluateResults(clickResults, metrics);

    // Keyboard and IME actions
    const kbResults = await deps.runKeyboardImeActions(scale);
    metrics.totalKeyboardIme += kbResults.length;
    if (kbResults.length < REQUIRED_KEYBOARD_IME_ACTIONS) {
      failures.push(`Scale ${scale}: only ${kbResults.length}/${REQUIRED_KEYBOARD_IME_ACTIONS} keyboard/IME actions tested`);
    }
    evaluateResults(kbResults, metrics);

    // Scroll actions (vertical and horizontal)
    const scrollResults = await deps.runScrollActions(scale);
    metrics.totalScrolls += scrollResults.length;
    if (scrollResults.length < REQUIRED_SCROLL_ACTIONS) {
      failures.push(`Scale ${scale}: only ${scrollResults.length}/${REQUIRED_SCROLL_ACTIONS} scroll actions tested`);
    }
    evaluateResults(scrollResults, metrics);

    // Drags
    const dragResults = await deps.runDragActions(scale);
    metrics.totalDrags += dragResults.length;
    if (dragResults.length < REQUIRED_DRAGS_PER_SCALE) {
      failures.push(`Scale ${scale}: only ${dragResults.length}/${REQUIRED_DRAGS_PER_SCALE} drags tested`);
    }
    evaluateResults(dragResults, metrics);
  }

  // Threshold checks
  if (metrics.misroutes > MAX_MISROUTES) {
    failures.push(`${metrics.misroutes} misroutes detected (max: ${MAX_MISROUTES})`);
  }
  if (metrics.maxCoordinateErrorPx > MAX_COORDINATE_ERROR_PX) {
    failures.push(`Max coordinate error ${metrics.maxCoordinateErrorPx}px exceeds threshold ${MAX_COORDINATE_ERROR_PX}px`);
  }
  if (metrics.retainedCaptures > MAX_RETAINED_POINTER_CAPTURES) {
    failures.push(`${metrics.retainedCaptures} retained pointer captures (max: ${MAX_RETAINED_POINTER_CAPTURES})`);
  }

  const verdict = failures.length === 0 ? 'pass' : 'fail';

  const rawMeasurementSummary = JSON.stringify({
    testedScales,
    totalClicks: metrics.totalClicks,
    totalKeyboardIme: metrics.totalKeyboardIme,
    totalScrolls: metrics.totalScrolls,
    totalDrags: metrics.totalDrags,
    misroutes: metrics.misroutes,
    maxCoordinateErrorPx: metrics.maxCoordinateErrorPx,
    retainedCaptures: metrics.retainedCaptures,
    failures,
  });

  return {
    gateId: ReleaseGateId.INPUT,
    buildHash,
    osBuild: row.osBuild,
    architecture: row.architecture,
    webView2Version: row.webView2Version,
    appVersion,
    sidecarVersion,
    rawMeasurementSummary,
    verdict,
    executedAt: new Date().toISOString(),
  };
}
