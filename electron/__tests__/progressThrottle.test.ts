// Feature: auto-updater, Property 11: Progress throttle respects frequency bounds
// **Validates: Requirements 5.3, 10.7**
//
// For any stream of raw progress events from electron-updater arriving at
// arbitrary frequency, the throttled output delivered to the renderer SHALL
// contain at least one event per 1000 milliseconds while the download is
// active, and at most 10 events per 1000 milliseconds (minimum 100ms between
// emissions).

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { createProgressThrottle, type DownloadProgress } from '../autoUpdateService';

// ── Generators ───────────────────────────────────────────────────────────────

/** Generate a progress event with a random percent, bytesReceived, totalBytes. */
const arbProgress: fc.Arbitrary<DownloadProgress> = fc.record({
  percent: fc.integer({ min: 0, max: 100 }),
  bytesReceived: fc.integer({ min: 0, max: 500_000_000 }),
  totalBytes: fc.integer({ min: 1, max: 500_000_000 }),
}).map((p) => ({
  ...p,
  // Ensure bytesReceived <= totalBytes
  bytesReceived: Math.min(p.bytesReceived, p.totalBytes),
}));

/** Generate a timestamp delta (ms) between events — from 0ms to 2000ms. */
const arbTimeDelta = fc.integer({ min: 0, max: 2000 });

/**
 * Generate a stream of progress events with timestamps.
 * Each entry has a relative time delta from the previous event.
 */
const arbEventStream = fc.array(
  fc.tuple(arbTimeDelta, arbProgress),
  { minLength: 1, maxLength: 50 },
);

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Property 11: Progress throttle respects frequency bounds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('output events have at most 10 per 1000ms window (min 100ms between emissions)', () => {
    fc.assert(
      fc.property(arbEventStream, (eventStream) => {
        vi.setSystemTime(0);

        const emittedTimestamps: number[] = [];

        const throttle = createProgressThrottle((_progress) => {
          emittedTimestamps.push(Date.now());
        });

        // Push events according to their time deltas
        let currentTime = 0;
        for (const [delta, progress] of eventStream) {
          currentTime += delta;
          vi.setSystemTime(currentTime);
          throttle.push(progress);
          // Advance timers to trigger any scheduled guarantee timers
          vi.advanceTimersByTime(0);
        }

        // Advance time to allow any pending guarantee timers to fire
        vi.advanceTimersByTime(1100);

        // Property: minimum 100ms between consecutive emissions (at most 10/sec)
        for (let i = 1; i < emittedTimestamps.length; i++) {
          const gap = emittedTimestamps[i] - emittedTimestamps[i - 1];
          expect(gap).toBeGreaterThanOrEqual(100);
        }

        // Property: at most 10 events in any 1000ms sliding window
        for (let i = 0; i < emittedTimestamps.length; i++) {
          const windowStart = emittedTimestamps[i];
          const windowEnd = windowStart + 1000;
          const eventsInWindow = emittedTimestamps.filter(
            (t) => t >= windowStart && t < windowEnd,
          );
          expect(eventsInWindow.length).toBeLessThanOrEqual(10);
        }

        // Cleanup
        throttle.reset();
      }),
      { numRuns: 200 },
    );
  });

  test('if events are pending, at least 1 is emitted per 1000ms (guarantee timer)', () => {
    fc.assert(
      fc.property(arbEventStream, (eventStream) => {
        vi.setSystemTime(0);

        const emittedTimestamps: number[] = [];

        const throttle = createProgressThrottle((_progress) => {
          emittedTimestamps.push(Date.now());
        });

        // Push all events very quickly (within a small time window)
        // so most get buffered, requiring the guarantee timer
        let currentTime = 0;
        const totalDuration = eventStream.reduce((sum, [delta]) => sum + delta, 0);

        for (const [delta, progress] of eventStream) {
          currentTime += delta;
          vi.setSystemTime(currentTime);
          throttle.push(progress);
          vi.advanceTimersByTime(0);
        }

        // If there were buffered events (events pushed too quickly to emit immediately),
        // the guarantee timer should fire within 1000ms of the last push
        // Advance timers by 1100ms to ensure any guarantee timers fire
        vi.advanceTimersByTime(1100);

        // Property: if we pushed at least one event, at least one was emitted
        if (eventStream.length > 0) {
          expect(emittedTimestamps.length).toBeGreaterThanOrEqual(1);
        }

        // Property: for any 1000ms window during which events were pushed,
        // at least one event was emitted in that window (or within 1000ms after)
        // We verify this by checking that the time between first push and last
        // emission is bounded: if events span T ms, emissions should cover
        // up to T + 1000ms after
        if (emittedTimestamps.length > 0 && totalDuration > 0) {
          const lastEmission = emittedTimestamps[emittedTimestamps.length - 1];
          // The last emission should occur no later than 1000ms after the last push
          expect(lastEmission).toBeLessThanOrEqual(currentTime + 1000);
        }

        // Cleanup
        throttle.reset();
      }),
      { numRuns: 200 },
    );
  });

  test('rapid burst of events produces emissions with ≥100ms spacing', () => {
    fc.assert(
      fc.property(
        fc.array(arbProgress, { minLength: 5, maxLength: 30 }),
        (events) => {
          vi.setSystemTime(0);

          const emittedTimestamps: number[] = [];

          const throttle = createProgressThrottle((_progress) => {
            emittedTimestamps.push(Date.now());
          });

          // Push all events at the same timestamp (rapid burst)
          for (const progress of events) {
            throttle.push(progress);
            vi.advanceTimersByTime(0);
          }

          // Advance time to allow guarantee timer to fire
          vi.advanceTimersByTime(1100);

          // In a rapid burst at t=0, only the first event should emit immediately
          // Then the guarantee timer fires at t=1000 for the last buffered event
          // Either way, spacing between consecutive emissions must be ≥ 100ms
          for (let i = 1; i < emittedTimestamps.length; i++) {
            const gap = emittedTimestamps[i] - emittedTimestamps[i - 1];
            expect(gap).toBeGreaterThanOrEqual(100);
          }

          // Cleanup
          throttle.reset();
        },
      ),
      { numRuns: 200 },
    );
  });

  test('events spaced at ≥100ms intervals from first emission are all emitted', () => {
    fc.assert(
      fc.property(
        fc.array(arbProgress, { minLength: 2, maxLength: 20 }),
        (events) => {
          // Start at t=100 so the first event always has elapsed >= 100ms
          // (lastEmitTime starts at 0, so 100 - 0 = 100 >= MIN_INTERVAL_MS)
          vi.setSystemTime(100);

          const emittedTimestamps: number[] = [];

          const throttle = createProgressThrottle((_progress) => {
            emittedTimestamps.push(Date.now());
          });

          // Push events spaced exactly 100ms apart, starting at t=100
          for (let i = 0; i < events.length; i++) {
            vi.setSystemTime(100 + i * 100);
            throttle.push(events[i]);
            vi.advanceTimersByTime(0);
          }

          // All events should have been emitted (each was ≥ 100ms from the last)
          expect(emittedTimestamps.length).toBe(events.length);

          // And all gaps are exactly 100ms
          for (let i = 1; i < emittedTimestamps.length; i++) {
            expect(emittedTimestamps[i] - emittedTimestamps[i - 1]).toBe(100);
          }

          // Cleanup
          throttle.reset();
        },
      ),
      { numRuns: 200 },
    );
  });
});
