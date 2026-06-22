// ============================================
// Zule AI — Progress Display Computation
// ============================================
//
// Pure utility that computes human-readable display values from raw
// DownloadProgress data (bytesReceived, totalBytes).
//
// Extracted as a standalone helper so it can be tested in isolation
// via property-based tests without needing React rendering.
//
// Requirements: 5.2

export interface ProgressDisplayValues {
  /** Integer percent of bytes received, clamped to [0, 100]. */
  percent: number;
  /** Bytes received expressed in megabytes, rounded to 1 decimal place. */
  displayReceived: string;
  /** Total bytes expressed in megabytes, rounded to 1 decimal place. */
  displayTotal: string;
}

const BYTES_PER_MB = 1_048_576;

/**
 * Computes display-friendly progress values from raw byte counts.
 *
 * @param bytesReceived - Number of bytes received so far (non-negative, ≤ totalBytes).
 * @param totalBytes - Total bytes expected (must be > 0).
 * @returns Display values with clamped percent and MB strings.
 */
export function computeProgressDisplay(
  bytesReceived: number,
  totalBytes: number,
): ProgressDisplayValues {
  const rawPercent = Math.round((bytesReceived / totalBytes) * 100);
  const percent = Math.max(0, Math.min(100, rawPercent));
  const displayReceived = (bytesReceived / BYTES_PER_MB).toFixed(1);
  const displayTotal = (totalBytes / BYTES_PER_MB).toFixed(1);

  return { percent, displayReceived, displayTotal };
}
