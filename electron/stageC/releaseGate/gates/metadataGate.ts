/**
 * Stage C Release Gate — Metadata Gate.
 *
 * Performs 30 cold launches per environment and asserts:
 * - Win32 class exactly `ZuleUIWindow`
 * - Image exactly `ZuleUI.exe`
 * - OriginalFilename exactly `ZuleUI.exe`
 * - CompanyName and ProductName exactly `Zule AI`
 * - Blank title only on the Floating_Surface
 * - Zero `Chrome_WidgetWin` overlay windows
 *
 * Requirement 17.4
 */

import type { EnvironmentMatrixRow, GateResultRecord } from '../types';
import { ReleaseGateId } from '../types';
import type { GateBuildContext, MetadataGateDeps, ColdLaunchResult, WindowIdentity } from './types';

// ────────────────────────────────────────────────────────────────────
// Thresholds
// ────────────────────────────────────────────────────────────────────

/** Number of cold launches required per environment */
export const METADATA_COLD_LAUNCH_COUNT = 30;

/** Expected Win32 class name */
export const EXPECTED_CLASS_NAME = 'ZuleUIWindow';

/** Expected executable/image name */
export const EXPECTED_IMAGE_NAME = 'ZuleUI.exe';

/** Expected OriginalFilename version resource value */
export const EXPECTED_ORIGINAL_FILENAME = 'ZuleUI.exe';

/** Expected CompanyName version resource value */
export const EXPECTED_COMPANY_NAME = 'Zule AI';

/** Expected ProductName version resource value */
export const EXPECTED_PRODUCT_NAME = 'Zule AI';

/** Maximum allowed Chrome_WidgetWin overlay windows */
export const MAX_CHROME_WIDGET_WIN_OVERLAYS = 0;

// ────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────

/**
 * Validates a single window's identity against metadata requirements.
 * Returns an array of violation descriptions (empty if valid).
 */
export function validateWindowIdentity(window: WindowIdentity): readonly string[] {
  const violations: string[] = [];

  if (window.className !== EXPECTED_CLASS_NAME) {
    violations.push(`class '${window.className}' !== '${EXPECTED_CLASS_NAME}'`);
  }

  if (window.imageName !== EXPECTED_IMAGE_NAME) {
    violations.push(`image '${window.imageName}' !== '${EXPECTED_IMAGE_NAME}'`);
  }

  if (window.originalFilename !== EXPECTED_ORIGINAL_FILENAME) {
    violations.push(`OriginalFilename '${window.originalFilename}' !== '${EXPECTED_ORIGINAL_FILENAME}'`);
  }

  if (window.companyName !== EXPECTED_COMPANY_NAME) {
    violations.push(`CompanyName '${window.companyName}' !== '${EXPECTED_COMPANY_NAME}'`);
  }

  if (window.productName !== EXPECTED_PRODUCT_NAME) {
    violations.push(`ProductName '${window.productName}' !== '${EXPECTED_PRODUCT_NAME}'`);
  }

  // Blank title only on Floating_Surface
  if (window.isFloatingSurface && window.title !== '') {
    violations.push(`Floating_Surface has non-empty title '${window.title}'`);
  }

  if (!window.isFloatingSurface && window.title === '') {
    violations.push('Non-Floating_Surface window has blank title');
  }

  return violations;
}

/**
 * Validates a single cold launch result against all metadata requirements.
 * Returns an array of violation descriptions (empty if valid).
 */
export function validateColdLaunch(result: ColdLaunchResult): readonly string[] {
  const violations: string[] = [];

  for (const window of result.windows) {
    const windowViolations = validateWindowIdentity(window);
    violations.push(...windowViolations);
  }

  if (result.chromeWidgetWinOverlayCount > MAX_CHROME_WIDGET_WIN_OVERLAYS) {
    violations.push(
      `${result.chromeWidgetWinOverlayCount} Chrome_WidgetWin overlay(s) detected (max ${MAX_CHROME_WIDGET_WIN_OVERLAYS})`,
    );
  }

  return violations;
}

// ────────────────────────────────────────────────────────────────────
// Gate Execution
// ────────────────────────────────────────────────────────────────────

/**
 * Executes the metadata gate for a single environment row.
 *
 * Performs METADATA_COLD_LAUNCH_COUNT cold launches and validates
 * every window identity against the exact metadata requirements.
 *
 * Requirement 17.4: 30 cold launches, exact class/image/resource checks,
 * blank title only on Floating_Surface, zero Chrome_WidgetWin overlays.
 */
export async function executeMetadataGate(
  env: EnvironmentMatrixRow,
  buildContext: GateBuildContext,
  deps: MetadataGateDeps,
): Promise<GateResultRecord> {
  const allViolations: string[] = [];
  let passedLaunches = 0;

  for (let i = 0; i < METADATA_COLD_LAUNCH_COUNT; i++) {
    const result = await deps.coldLaunch(env);
    const violations = validateColdLaunch(result);

    if (violations.length === 0) {
      passedLaunches++;
    } else {
      allViolations.push(`Launch ${i + 1}: ${violations.join('; ')}`);
    }
  }

  const verdict = allViolations.length === 0 ? 'pass' : 'fail';

  const rawMeasurementSummary = JSON.stringify({
    gate: ReleaseGateId.METADATA,
    totalLaunches: METADATA_COLD_LAUNCH_COUNT,
    passedLaunches,
    failedLaunches: METADATA_COLD_LAUNCH_COUNT - passedLaunches,
    violations: allViolations,
    thresholds: {
      expectedClass: EXPECTED_CLASS_NAME,
      expectedImage: EXPECTED_IMAGE_NAME,
      expectedOriginalFilename: EXPECTED_ORIGINAL_FILENAME,
      expectedCompanyName: EXPECTED_COMPANY_NAME,
      expectedProductName: EXPECTED_PRODUCT_NAME,
      maxChromeWidgetWinOverlays: MAX_CHROME_WIDGET_WIN_OVERLAYS,
    },
  });

  return {
    gateId: ReleaseGateId.METADATA,
    buildHash: buildContext.buildHash,
    osBuild: env.osBuild,
    architecture: env.architecture,
    webView2Version: env.webView2Version,
    appVersion: buildContext.appVersion,
    sidecarVersion: buildContext.sidecarVersion,
    rawMeasurementSummary,
    verdict,
    executedAt: new Date().toISOString(),
  };
}
