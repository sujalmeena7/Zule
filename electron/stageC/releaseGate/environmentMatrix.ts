/**
 * Stage C Release Gate — Environment Matrix Definition.
 *
 * Enumerates the exact environment matrix: Windows 10 22H2, supported
 * Windows 11 23H2-or-newer builds, distributed architectures, and
 * supported WebView2 Runtime versions.
 *
 * Requirement 17.1: Enumerate an exact environment matrix containing
 * Windows 10 22H2, each supported Windows 11 23H2-or-newer build,
 * each distributed architecture, and each WebView2_Runtime version
 * declared for production support.
 */

import type { SupportedArchitecture } from '../types';
import type { EnvironmentMatrixRow, WindowsOsBuild } from './types';

// ────────────────────────────────────────────────────────────────────
// Supported OS Builds
// ────────────────────────────────────────────────────────────────────

/**
 * All supported Windows OS builds for the release gate matrix.
 * Windows 10 22H2 is required; Windows 11 23H2+ builds are included.
 */
export const SUPPORTED_OS_BUILDS: readonly WindowsOsBuild[] = [
  'win10_22h2',
  'win11_23h2',
  'win11_24h2',
] as const;

// ────────────────────────────────────────────────────────────────────
// Distributed Architectures
// ────────────────────────────────────────────────────────────────────

/**
 * All architectures for which production artifacts are distributed.
 * Currently x64 only; arm64 requires a matching Electron artifact,
 * sidecar binary, gate matrix row, and dependency review (per design).
 */
export const DISTRIBUTED_ARCHITECTURES: readonly SupportedArchitecture[] = [
  'x64',
] as const;

// ────────────────────────────────────────────────────────────────────
// Supported WebView2 Runtime Versions
// ────────────────────────────────────────────────────────────────────

/**
 * All WebView2 Runtime versions declared for production support.
 * These represent the minimum supported version and actively tested
 * newer releases in the field.
 */
export const SUPPORTED_WEBVIEW2_VERSIONS: readonly string[] = [
  '119.0.2151.0',
  '120.0.2210.0',
  '124.0.2478.0',
] as const;

// ────────────────────────────────────────────────────────────────────
// Matrix Generation
// ────────────────────────────────────────────────────────────────────

/**
 * Generates the complete environment matrix: the Cartesian product of
 * supported OS builds × distributed architectures × WebView2 versions.
 *
 * Every combination is a required test row. Missing rows reject the
 * release decision.
 *
 * Requirement 17.1: Enumerate exact environment matrix.
 */
export function generateEnvironmentMatrix(): readonly EnvironmentMatrixRow[] {
  const rows: EnvironmentMatrixRow[] = [];

  for (const osBuild of SUPPORTED_OS_BUILDS) {
    for (const architecture of DISTRIBUTED_ARCHITECTURES) {
      for (const webView2Version of SUPPORTED_WEBVIEW2_VERSIONS) {
        rows.push({
          osBuild,
          architecture,
          webView2Version,
        });
      }
    }
  }

  return rows;
}

/**
 * Returns the total number of expected matrix rows.
 * Used for validation without generating the full matrix.
 */
export function getExpectedMatrixRowCount(): number {
  return (
    SUPPORTED_OS_BUILDS.length *
    DISTRIBUTED_ARCHITECTURES.length *
    SUPPORTED_WEBVIEW2_VERSIONS.length
  );
}

/**
 * Creates a unique key for an environment matrix row.
 * Used to index evidence records by environment.
 */
export function matrixRowKey(row: EnvironmentMatrixRow): string {
  return `${row.osBuild}|${row.architecture}|${row.webView2Version}`;
}

/**
 * Validates that a given matrix matches the expected complete matrix.
 * Returns an array of error messages (empty if valid).
 */
export function validateMatrixCompleteness(
  matrix: readonly EnvironmentMatrixRow[],
): readonly string[] {
  const errors: string[] = [];
  const expected = generateEnvironmentMatrix();
  const expectedKeys = new Set(expected.map(matrixRowKey));
  const actualKeys = new Set(matrix.map(matrixRowKey));

  // Check for missing rows
  for (const key of expectedKeys) {
    if (!actualKeys.has(key)) {
      errors.push(`Missing required environment matrix row: ${key}`);
    }
  }

  // Check for unexpected rows (not strictly required to reject, but noted)
  for (const key of actualKeys) {
    if (!expectedKeys.has(key)) {
      errors.push(`Unexpected environment matrix row: ${key}`);
    }
  }

  return errors;
}
