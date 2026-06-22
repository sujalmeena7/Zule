// Feature: auto-updater, Property 8: Progress display computation
// Validates: Requirements 5.2
//
// For any DownloadProgress event with bytesReceived in [0, totalBytes] and
// totalBytes > 0, the computed display values satisfy:
//   percent === Math.round(bytesReceived / totalBytes * 100) (clamped to [0, 100])
//   displayReceived === (bytesReceived / 1_048_576).toFixed(1) (MB with 1 decimal)
//   displayTotal === (totalBytes / 1_048_576).toFixed(1) (MB with 1 decimal)

import { describe, test, expect } from 'vitest';
import * as fc from 'fast-check';
import { computeProgressDisplay } from '../progressDisplay';

describe('Property 8: Progress display computation', () => {
  // **Validates: Requirements 5.2**
  test('computed display values match specification for any valid (bytesReceived, totalBytes) pair', () => {
    fc.assert(
      fc.property(
        // Generate totalBytes > 0 (up to 2 GB range typical for installers)
        fc.integer({ min: 1, max: 2_147_483_647 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (totalBytes, ratio) => {
          // bytesReceived in [0, totalBytes]
          const bytesReceived = Math.floor(ratio * totalBytes);

          const result = computeProgressDisplay(bytesReceived, totalBytes);

          // Percent should be Math.round(bytesReceived / totalBytes * 100) clamped to [0, 100]
          const expectedPercent = Math.max(
            0,
            Math.min(100, Math.round((bytesReceived / totalBytes) * 100)),
          );
          expect(result.percent).toBe(expectedPercent);

          // displayReceived should be MB with 1 decimal
          const expectedReceived = (bytesReceived / 1_048_576).toFixed(1);
          expect(result.displayReceived).toBe(expectedReceived);

          // displayTotal should be MB with 1 decimal
          const expectedTotal = (totalBytes / 1_048_576).toFixed(1);
          expect(result.displayTotal).toBe(expectedTotal);
        },
      ),
      { numRuns: 200 }, // Above minimum 100 iterations
    );
  });

  test('percent is always clamped to [0, 100]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2_147_483_647 }),
        fc.integer({ min: 0, max: 2_147_483_647 }),
        (totalBytes, bytesReceived) => {
          // Allow bytesReceived to potentially exceed totalBytes to test clamping
          const result = computeProgressDisplay(bytesReceived, totalBytes);

          expect(result.percent).toBeGreaterThanOrEqual(0);
          expect(result.percent).toBeLessThanOrEqual(100);
        },
      ),
      { numRuns: 100 },
    );
  });

  test('percent is 0 when bytesReceived is 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2_147_483_647 }),
        (totalBytes) => {
          const result = computeProgressDisplay(0, totalBytes);
          expect(result.percent).toBe(0);
          expect(result.displayReceived).toBe('0.0');
        },
      ),
      { numRuns: 100 },
    );
  });

  test('percent is 100 when bytesReceived equals totalBytes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2_147_483_647 }),
        (totalBytes) => {
          const result = computeProgressDisplay(totalBytes, totalBytes);
          expect(result.percent).toBe(100);
          expect(result.displayReceived).toBe(result.displayTotal);
        },
      ),
      { numRuns: 100 },
    );
  });
});
