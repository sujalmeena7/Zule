// ============================================
// Zule AI — Telemetry Exclusion Property-Based Tests
// ============================================
//
// Feature: stealth-window-host, Property 21: Telemetry noninterference and content exclusion
//
// Generate unknown fields, bound overflows, prohibited canaries, and sink failures;
// assert rejected output contains no canary and supervision/fallback outcomes are unchanged.
//
// **Validates: Requirements 15.1–15.14**

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  StageCTelemetrySink,
  LocalOnlySinkAdapter,
  type TelemetrySinkAdapter,
} from '../../stageC/telemetrySink';

import {
  type TelemetryEvent,
  TELEMETRY_COMMON_FIELDS,
  CANARY_EXCLUSION_PATTERNS,
  MAX_MEASUREMENT_ENTRIES,
  MAX_MEASUREMENT_KEY_BYTES,
} from '../../stageC/protocol/telemetry';

import { MAX_TELEMETRY_EVENT_BYTES } from '../../stageC/protocol/schema';

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/** Create a minimal valid TelemetryEvent for baseline use. */
function baseValidEvent(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    eventName: 'stage_c_test',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/** Creates a sink adapter that always throws (simulates sink failure). */
function createFailingSinkAdapter(): TelemetrySinkAdapter {
  return {
    async send(): Promise<void> {
      throw new Error('Simulated sink delivery failure');
    },
  };
}

/** Creates a recording sink adapter that stores what it receives. */
function createRecordingSinkAdapter(): TelemetrySinkAdapter & { received: TelemetryEvent[][] } {
  const received: TelemetryEvent[][] = [];
  return {
    received,
    async send(events: TelemetryEvent[]): Promise<void> {
      received.push([...events]);
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// Generators
// ────────────────────────────────────────────────────────────────────

/**
 * Generates events with unknown/extra fields that should be rejected.
 */
const unknownFieldEventArb: fc.Arbitrary<Record<string, unknown>> = fc.record({
  eventName: fc.string({ minLength: 1, maxLength: 30 }),
  timestamp: fc.constant(new Date().toISOString()),
}).chain((base) =>
  fc.tuple(
    fc.string({ minLength: 1, maxLength: 30 }).filter(
      (k) => !new Set(TELEMETRY_COMMON_FIELDS).has(k) && /^[a-zA-Z_]/.test(k),
    ),
    fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
  ).map(([key, val]) => ({ ...base, [key]: val })),
);

/**
 * Generates events with field values exceeding 64-byte limits.
 */
const oversized64ByteFieldArb: fc.Arbitrary<Record<string, unknown>> = fc.constantFrom(
  'eventName', 'result', 'failureReason',
).map((field) => ({
  eventName: field === 'eventName' ? 'x'.repeat(65) : 'test_event',
  timestamp: new Date().toISOString(),
  ...(field !== 'eventName' ? { [field]: 'x'.repeat(65) } : {}),
}));

/**
 * Generates events with field values exceeding 32-byte limits.
 */
const oversized32ByteFieldArb: fc.Arbitrary<Record<string, unknown>> = fc.constantFrom(
  'hostStrategy', 'lifecyclePhase', 'direction', 'osBuild', 'architecture',
).map((field) => ({
  eventName: 'test_event',
  timestamp: new Date().toISOString(),
  [field]: 'y'.repeat(33),
}));

/**
 * Generates events exceeding the MAX_TELEMETRY_EVENT_BYTES (4096) total size.
 */
const oversizedTotalEventArb: fc.Arbitrary<Record<string, unknown>> = fc.nat({ max: 10 }).map(
  (seed) => {
    // Build measurements to push over 4096 bytes total
    const measurements: Record<string, number> = {};
    for (let i = 0; i < 16; i++) {
      measurements[`metric_${seed}_${i}_pad`.slice(0, 60)] = i * 100;
    }
    return {
      eventName: 'oversize_event',
      timestamp: new Date().toISOString(),
      hostStrategy: 'a'.repeat(32),
      lifecyclePhase: 'b'.repeat(32),
      result: 'c'.repeat(64),
      failureReason: 'd'.repeat(64),
      osBuild: 'e'.repeat(32),
      architecture: 'f'.repeat(32),
      appCoreVersion: 'g'.repeat(64),
      sidecarVersion: 'h'.repeat(64),
      protocolVersion: 'i'.repeat(64),
      webView2RuntimeVersion: 'j'.repeat(64),
      measurements,
    };
  },
);

/**
 * Generates canary strings that match the prohibited content patterns
 * AND fit within the 64-byte field limit (so the canary check is actually triggered
 * rather than the size check). Base64 blobs are excluded here because they require
 * 100+ chars which exceeds the 64-byte field limit.
 */
const canaryStringArb: fc.Arbitrary<string> = fc.oneof(
  // Pipe paths (fits in 64 bytes easily)
  fc.stringOf(fc.constantFrom(...'abcdef0123456789'.split('')), { minLength: 3, maxLength: 20 }).map(
    (suffix) => `\\\\.\\pipe\\${suffix}`,
  ),
  // Hex credentials (32+ hex chars, max 64)
  fc.integer({ min: 32, max: 64 }).chain((len) =>
    fc.stringOf(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: len, maxLength: len }),
  ),
  // API keys (sk- + 20-40 alphanum = 23-43 chars total, fits 64)
  fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')), {
    minLength: 20,
    maxLength: 40,
  }).map((s) => `sk-${s}`),
  // Bearer tokens (7 + some content, fits 64)
  fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { minLength: 5, maxLength: 30 }).map(
    (s) => `Bearer ${s}`,
  ),
  // Multi-line content (transcript/prompt) — keep short lines to fit 64 bytes total
  fc.tuple(
    fc.stringOf(fc.constantFrom(...'abc'.split('')), { minLength: 1, maxLength: 10 }),
    fc.stringOf(fc.constantFrom(...'def'.split('')), { minLength: 1, maxLength: 10 }),
    fc.stringOf(fc.constantFrom(...'ghi'.split('')), { minLength: 1, maxLength: 10 }),
    fc.stringOf(fc.constantFrom(...'jkl'.split('')), { minLength: 1, maxLength: 10 }),
  ).map(([a, b, c, d]) => `${a}\n${b}\n${c}\n${d}`),
  // Windows file paths (e.g. "C:\path" — fits in 64)
  fc.constantFrom('C', 'D', 'E').chain((drive) =>
    fc.stringOf(fc.constantFrom(...'abcdefghij'.split('')), { minLength: 3, maxLength: 20 }).map(
      (path) => `${drive}:\\${path}`,
    ),
  ),
);

/**
 * Generates events containing canary content in 64-byte-limit fields.
 * Uses only fields that have the 64-byte limit to avoid size-limit rejections
 * masking the canary rejection we're testing.
 */
const canaryEventArb: fc.Arbitrary<Record<string, unknown>> = fc.tuple(
  canaryStringArb,
  fc.constantFrom('result', 'failureReason'),
).map(([canary, field]) => ({
  eventName: 'canary_test',
  timestamp: new Date().toISOString(),
  [field]: canary,
}));

/**
 * Generates events with measurement bounds exceeded.
 */
const measurementOverflowArb: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  // Too many entries
  fc.constant(null).map(() => {
    const measurements: Record<string, number> = {};
    for (let i = 0; i <= MAX_MEASUREMENT_ENTRIES; i++) {
      measurements[`k${i}`] = i;
    }
    return {
      eventName: 'meas_overflow',
      timestamp: new Date().toISOString(),
      measurements,
    };
  }),
  // Key too long
  fc.constant(null).map(() => ({
    eventName: 'meas_key_overflow',
    timestamp: new Date().toISOString(),
    measurements: { ['k'.repeat(MAX_MEASUREMENT_KEY_BYTES + 1)]: 42 },
  })),
  // Negative measurement value
  fc.integer({ min: -1000, max: -1 }).map((val) => ({
    eventName: 'meas_neg',
    timestamp: new Date().toISOString(),
    measurements: { test_metric: val },
  })),
);

/**
 * Union of all invalid-event generators.
 */
const invalidEventArb: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  { weight: 3, arbitrary: unknownFieldEventArb },
  { weight: 2, arbitrary: oversized64ByteFieldArb },
  { weight: 2, arbitrary: oversized32ByteFieldArb },
  { weight: 2, arbitrary: oversizedTotalEventArb },
  { weight: 4, arbitrary: canaryEventArb },
  { weight: 2, arbitrary: measurementOverflowArb },
);

// ────────────────────────────────────────────────────────────────────
// Property Test
// ────────────────────────────────────────────────────────────────────

describe('Stage C Telemetry — Property Tests', () => {
  // Feature: stealth-window-host, Property 21: Telemetry noninterference and content exclusion
  describe('Property 21: Telemetry noninterference and content exclusion', () => {

    it('rejected events never appear in the sink output (Req 15.9, 15.10)', () => {
      fc.assert(
        fc.property(invalidEventArb, (event) => {
          const recorder = createRecordingSinkAdapter();
          const sink = new StageCTelemetrySink(recorder);

          const accepted = sink.emit(event as unknown as TelemetryEvent);

          // Must be rejected
          expect(accepted).toBe(false);

          // Nothing should reach the external sink
          expect(recorder.received).toHaveLength(0);

          // Diagnostics reflect the rejection
          expect(sink.getDiagnostics().rejected).toBe(1);
          expect(sink.getDiagnostics().accepted).toBe(0);
        }),
        { numRuns: 300 },
      );
    });

    it('no canary content appears in any accepted sink output (Req 15.11)', () => {
      fc.assert(
        fc.property(canaryStringArb, (canary) => {
          const recorder = createRecordingSinkAdapter();
          const sink = new StageCTelemetrySink(recorder);

          // Try to emit an event containing the canary in the result field.
          // Truncate to stay within the 64-byte field limit so
          // we test canary rejection specifically, not size rejection.
          const truncated = canary.slice(0, 64);
          const event: Record<string, unknown> = {
            eventName: 'canary_probe',
            timestamp: new Date().toISOString(),
            result: truncated,
          };

          const accepted = sink.emit(event as unknown as TelemetryEvent);

          // If accepted (passed all checks), ensure no canary pattern in output
          if (accepted) {
            for (const batch of recorder.received) {
              for (const sentEvent of batch) {
                for (const val of Object.values(sentEvent)) {
                  if (typeof val === 'string') {
                    for (const pattern of CANARY_EXCLUSION_PATTERNS) {
                      expect(pattern.test(val)).toBe(false);
                    }
                  }
                }
              }
            }
          } else {
            // Rejected — nothing reaches sink
            expect(recorder.received).toHaveLength(0);
          }
        }),
        { numRuns: 300 },
      );
    });

    it('supervision and fallback outcomes are unchanged after sink failures (Req 15.14)', () => {
      fc.assert(
        fc.asyncProperty(
          fc.array(invalidEventArb, { minLength: 1, maxLength: 10 }),
          fc.array(
            fc.record({
              eventName: fc.constantFrom('probe_ok', 'startup_ok', 'active'),
              timestamp: fc.constant(new Date().toISOString()),
            }),
            { minLength: 1, maxLength: 5 },
          ),
          async (invalidEvents, validInputs) => {
            // Create a sink with a failing adapter
            const failingSink = createFailingSinkAdapter();
            const sink = new StageCTelemetrySink(failingSink);

            // Emit some valid events first — they'll be accepted but delivery fails
            for (const v of validInputs) {
              sink.emit(v as unknown as TelemetryEvent);
            }

            // Let async delivery fail
            await new Promise((r) => setTimeout(r, 20));

            // Now try invalid events — validation must still reject them
            for (const invalid of invalidEvents) {
              const result = sink.emit(invalid as unknown as TelemetryEvent);
              expect(result).toBe(false);
            }

            // Supervision is intact: diagnostics are accurate
            const diag = sink.getDiagnostics();
            expect(diag.accepted).toBe(validInputs.length);
            expect(diag.rejected).toBe(invalidEvents.length);

            // Sink continues to function — can still accept new valid events
            const afterEvent = baseValidEvent({ eventName: 'after_failure' });
            expect(sink.emit(afterEvent)).toBe(true);
            expect(sink.getDiagnostics().accepted).toBe(validInputs.length + 1);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('diagnostic counters remain accurate under mixed valid/invalid streams (Req 15.10, 15.14)', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.oneof(
              // Valid events
              fc.record({
                eventName: fc.constantFrom('ok_event', 'startup', 'probe'),
                timestamp: fc.constant(new Date().toISOString()),
              }).map((e) => ({ event: e, expectValid: true })),
              // Invalid events (unknown field)
              unknownFieldEventArb.map((e) => ({ event: e, expectValid: false })),
              // Invalid events (canary content)
              canaryEventArb.map((e) => ({ event: e, expectValid: false })),
            ),
            { minLength: 1, maxLength: 20 },
          ),
          (eventStream) => {
            const sink = new StageCTelemetrySink(new LocalOnlySinkAdapter());

            let expectedAccepted = 0;
            let expectedRejected = 0;

            for (const { event, expectValid } of eventStream) {
              const result = sink.emit(event as unknown as TelemetryEvent);
              if (expectValid) {
                // Valid events should be accepted
                expect(result).toBe(true);
                expectedAccepted++;
              } else {
                // Invalid events should be rejected
                expect(result).toBe(false);
                expectedRejected++;
              }
            }

            // Counters must match exactly
            const diag = sink.getDiagnostics();
            expect(diag.accepted).toBe(expectedAccepted);
            expect(diag.rejected).toBe(expectedRejected);
          },
        ),
        { numRuns: 200 },
      );
    });

    it('the sink continues functioning after sink failures — noninterference (Req 15.14)', () => {
      fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          async (failureCount) => {
            const failingSink = createFailingSinkAdapter();
            const sink = new StageCTelemetrySink(failingSink);

            // Emit events that trigger sink failures
            for (let i = 0; i < failureCount; i++) {
              const accepted = sink.emit(baseValidEvent({ eventName: `fail_${i}` }));
              expect(accepted).toBe(true);
            }

            // Let async sink failures resolve
            await new Promise((r) => setTimeout(r, 50));

            // Sink failures should have been counted
            expect(sink.getDiagnostics().sinkFailures).toBeGreaterThanOrEqual(1);

            // The sink must still accept valid events
            const afterEvent = baseValidEvent({ eventName: 'recovery_event' });
            expect(sink.emit(afterEvent)).toBe(true);
            expect(sink.getDiagnostics().accepted).toBe(failureCount + 1);

            // The sink must still reject invalid events (supervision preserved)
            const badEvent = { ...baseValidEvent(), extraField: 'leak' } as unknown as TelemetryEvent;
            expect(sink.emit(badEvent)).toBe(false);
            expect(sink.getDiagnostics().rejected).toBe(1);
          },
        ),
        { numRuns: 50 },
      );
    });
  });
});
