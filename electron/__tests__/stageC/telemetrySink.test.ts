/**
 * Stage C — Content-Free Telemetry Validator and Sink Adapter Tests
 *
 * Tests for the complete telemetry sink pipeline:
 * - Exact field allowlist enforcement (Req 15.1, 15.2)
 * - Field/count/value/UTF-8/event-size bounds (Req 15.3–15.8)
 * - Canary-content exclusions (Req 15.11)
 * - Rejection-event subset (Req 15.12)
 * - Disabled-telemetry local routing (Req 15.13)
 * - Noninterference on sink failure (Req 15.14)
 *
 * Requirements: 15.1–15.14
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  StageCTelemetrySink,
  LocalOnlySinkAdapter,
  type TelemetrySinkAdapter,
} from '../../stageC/telemetrySink';

import { type TelemetryEvent } from '../../stageC/protocol/telemetry';

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function validEvent(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    eventName: 'stage_c_startup',
    timestamp: new Date().toISOString(),
    hostStrategy: 'STAGE_C',
    lifecyclePhase: 'ACTIVE',
    ...overrides,
  };
}

function validRejectionEvent(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    eventName: 'protocol_rejection',
    timestamp: new Date().toISOString(),
    hostStrategy: 'STAGE_C',
    category: 'schema',
    direction: 'inbound',
    decodedType: 'unknown_type',
    byteCount: 128,
    ...overrides,
  };
}

/** Creates a mock sink that tracks calls and can be configured to fail. */
function createMockSink(shouldFail = false): TelemetrySinkAdapter & { calls: TelemetryEvent[][] } {
  const calls: TelemetryEvent[][] = [];
  return {
    calls,
    async send(events: TelemetryEvent[]): Promise<void> {
      calls.push([...events]);
      if (shouldFail) {
        throw new Error('Sink delivery failure');
      }
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// Field Allowlist (Req 15.1, 15.2)
// ────────────────────────────────────────────────────────────────────

describe('StageCTelemetrySink — field allowlist', () => {
  let sink: StageCTelemetrySink;

  beforeEach(() => {
    sink = new StageCTelemetrySink(new LocalOnlySinkAdapter());
  });

  it('accepts events with only permitted common fields (Req 15.1)', () => {
    const event = validEvent({
      durationMs: 150,
      result: 'success',
      failureReason: 'NONE',
      measurements: { probe_ms: 42, launch_ms: 100 },
      osBuild: '22621.1',
      architecture: 'x64',
      appCoreVersion: '1.0.0',
      sidecarVersion: '1.0.0',
      protocolVersion: '1.0',
      webView2RuntimeVersion: '120.0.0',
    });
    expect(sink.emit(event)).toBe(true);
    expect(sink.getDiagnostics().accepted).toBe(1);
  });

  it('rejects events with unknown fields (Req 15.1)', () => {
    const event = { ...validEvent(), unknownField: 'test' } as unknown as TelemetryEvent;
    expect(sink.emit(event)).toBe(false);
    expect(sink.getDiagnostics().rejected).toBe(1);
  });

  it('rejects rejection-only fields on non-rejection events (Req 15.2)', () => {
    const event = { ...validEvent(), category: 'schema' } as TelemetryEvent;
    expect(sink.emit(event, false)).toBe(false);
    expect(sink.getDiagnostics().rejected).toBe(1);
  });

  it('accepts rejection-only fields on rejection events (Req 15.2, 15.12)', () => {
    const event = validRejectionEvent();
    expect(sink.emit(event, true)).toBe(true);
    expect(sink.getDiagnostics().accepted).toBe(1);
  });

  it('rejects rejection event with extra non-allowed fields (Req 15.12)', () => {
    const event = { ...validRejectionEvent(), sensitiveField: 'secret' } as unknown as TelemetryEvent;
    expect(sink.emit(event, true)).toBe(false);
    expect(sink.getDiagnostics().rejected).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// Value/Type Bounds (Req 15.3–15.7)
// ────────────────────────────────────────────────────────────────────

describe('StageCTelemetrySink — field/count/value/UTF-8 bounds', () => {
  let sink: StageCTelemetrySink;

  beforeEach(() => {
    sink = new StageCTelemetrySink(new LocalOnlySinkAdapter());
  });

  it('accepts valid RFC 3339 UTC timestamp (Req 15.3)', () => {
    const event = validEvent({ timestamp: '2024-06-15T10:30:00.000Z' });
    expect(sink.emit(event)).toBe(true);
  });

  it('rejects non-UTC timestamp (Req 15.3)', () => {
    const event = validEvent({ timestamp: '2024-06-15T10:30:00+05:00' });
    expect(sink.emit(event)).toBe(false);
  });

  it('rejects invalid timestamp format (Req 15.3)', () => {
    const event = validEvent({ timestamp: 'not-a-date' });
    expect(sink.emit(event)).toBe(false);
  });

  it('rejects eventName exceeding 64 UTF-8 bytes (Req 15.4)', () => {
    const event = validEvent({ eventName: 'x'.repeat(65) });
    expect(sink.emit(event)).toBe(false);
  });

  it('accepts eventName at exactly 64 UTF-8 bytes (Req 15.4)', () => {
    const event = validEvent({ eventName: 'x'.repeat(64) });
    expect(sink.emit(event)).toBe(true);
  });

  it('rejects hostStrategy exceeding 32 UTF-8 bytes (Req 15.5)', () => {
    const event = validEvent({ hostStrategy: 'x'.repeat(33) });
    expect(sink.emit(event)).toBe(false);
  });

  it('accepts hostStrategy at exactly 32 UTF-8 bytes (Req 15.5)', () => {
    const event = validEvent({ hostStrategy: 'x'.repeat(32) });
    expect(sink.emit(event)).toBe(true);
  });

  it('rejects appCoreVersion exceeding 64 UTF-8 bytes (Req 15.6)', () => {
    const event = validEvent({ appCoreVersion: 'v'.repeat(65) });
    expect(sink.emit(event)).toBe(false);
  });

  it('rejects negative durationMs (Req 15.3)', () => {
    const event = validEvent({ durationMs: -1 });
    expect(sink.emit(event)).toBe(false);
  });

  it('rejects NaN durationMs (Req 15.3)', () => {
    const event = validEvent({ durationMs: NaN });
    expect(sink.emit(event)).toBe(false);
  });

  it('rejects Infinity durationMs (Req 15.3)', () => {
    const event = validEvent({ durationMs: Infinity });
    expect(sink.emit(event)).toBe(false);
  });

  it('accepts zero durationMs (Req 15.3)', () => {
    const event = validEvent({ durationMs: 0 });
    expect(sink.emit(event)).toBe(true);
  });

  it('rejects negative byteCount on rejection events (Req 15.3)', () => {
    const event = validRejectionEvent({ byteCount: -5 });
    expect(sink.emit(event, true)).toBe(false);
  });

  it('rejects measurements with > 16 entries (Req 15.7)', () => {
    const measurements: Record<string, number> = {};
    for (let i = 0; i < 17; i++) {
      measurements[`key_${i}`] = i;
    }
    const event = validEvent({ measurements });
    expect(sink.emit(event)).toBe(false);
  });

  it('accepts measurements with exactly 16 entries (Req 15.7)', () => {
    const measurements: Record<string, number> = {};
    for (let i = 0; i < 16; i++) {
      measurements[`key_${i}`] = i;
    }
    const event = validEvent({ measurements });
    expect(sink.emit(event)).toBe(true);
  });

  it('rejects measurement key exceeding 64 UTF-8 bytes (Req 15.7)', () => {
    const event = validEvent({ measurements: { ['k'.repeat(65)]: 1 } });
    expect(sink.emit(event)).toBe(false);
  });

  it('rejects measurement with non-numeric value (Req 15.7)', () => {
    const event = validEvent({
      measurements: { probe_ms: 'not_a_number' as unknown as number },
    });
    expect(sink.emit(event)).toBe(false);
  });

  it('rejects measurement with negative value (Req 15.7)', () => {
    const event = validEvent({ measurements: { probe_ms: -10 } });
    expect(sink.emit(event)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// Event Size Bounds (Req 15.8)
// ────────────────────────────────────────────────────────────────────

describe('StageCTelemetrySink — event size bounds', () => {
  let sink: StageCTelemetrySink;

  beforeEach(() => {
    sink = new StageCTelemetrySink(new LocalOnlySinkAdapter());
  });

  it('rejects events exceeding 4,096 bytes total (Req 15.8)', () => {
    // Fill with large field values to push over limit
    const event = validEvent({ result: 'x'.repeat(4000) });
    expect(sink.emit(event)).toBe(false);
  });

  it('accepts events just under 4,096 bytes (Req 15.8)', () => {
    // A minimal event should be well under 4096
    const event = validEvent();
    expect(sink.emit(event)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// Canary-Content Exclusions (Req 15.11)
// ────────────────────────────────────────────────────────────────────

describe('StageCTelemetrySink — canary content exclusion', () => {
  let sink: StageCTelemetrySink;

  beforeEach(() => {
    sink = new StageCTelemetrySink(new LocalOnlySinkAdapter());
  });

  it('rejects events containing provider credential patterns (Req 15.11)', () => {
    const event = validEvent({ result: 'sk-abcdefghijklmnopqrstuvwxyz' });
    expect(sink.emit(event)).toBe(false);
  });

  it('rejects events containing pipe path patterns (Req 15.11)', () => {
    const event = validEvent({ result: '\\\\.\\pipe\\zule-stage-c-launch' });
    expect(sink.emit(event)).toBe(false);
  });

  it('rejects events containing base64 blobs (screenshots/audio) (Req 15.11)', () => {
    const b64 = 'A'.repeat(120); // Long base64-like pattern
    const event = validEvent({ result: b64 });
    expect(sink.emit(event)).toBe(false);
  });

  it('rejects events containing absolute Windows file paths (Req 15.11)', () => {
    const event = validEvent({ result: 'C:\\Users\\secret\\data.db' });
    expect(sink.emit(event)).toBe(false);
  });

  it('rejects events containing multi-line text (transcripts/prompts) (Req 15.11)', () => {
    const event = validEvent({ result: 'line1\nline2\nline3\nline4' });
    expect(sink.emit(event)).toBe(false);
  });

  it('rejects events with Bearer token patterns (Req 15.11)', () => {
    const event = validEvent({ result: 'Bearer eyJhbGciOiJIUzI1NiJ9' });
    expect(sink.emit(event)).toBe(false);
  });

  it('accepts safe string values without canary patterns (Req 15.11)', () => {
    const event = validEvent({
      result: 'success',
      failureReason: 'STARTUP_TIMEOUT',
    });
    expect(sink.emit(event)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// Disabled-Telemetry Local Routing (Req 15.13)
// ────────────────────────────────────────────────────────────────────

describe('StageCTelemetrySink — disabled telemetry local routing', () => {
  it('routes events to local store when telemetry is disabled (Req 15.13)', () => {
    const mockSink = createMockSink();
    const sink = new StageCTelemetrySink(mockSink);
    sink.setEnabled(false);

    const event = validEvent();
    expect(sink.emit(event)).toBe(true);

    // Event should be in local store, not sent to external sink
    const localEvents = sink.getLocalStore();
    expect(localEvents).toHaveLength(1);
    expect(localEvents[0].eventName).toBe('stage_c_startup');
    expect(mockSink.calls).toHaveLength(0);
  });

  it('does not route to external sink when disabled (Req 15.13)', () => {
    const mockSink = createMockSink();
    const sink = new StageCTelemetrySink(mockSink);
    sink.setEnabled(false);

    sink.emit(validEvent());
    sink.emit(validEvent({ eventName: 'probe_complete' }));
    sink.emit(validEvent({ eventName: 'fallback' }));

    expect(mockSink.calls).toHaveLength(0);
    expect(sink.getLocalStore()).toHaveLength(3);
  });

  it('re-enables external routing when telemetry is re-enabled (Req 15.13)', () => {
    const mockSink = createMockSink();
    const sink = new StageCTelemetrySink(mockSink);

    sink.setEnabled(false);
    sink.emit(validEvent({ eventName: 'local_only' }));
    expect(mockSink.calls).toHaveLength(0);

    sink.setEnabled(true);
    sink.emit(validEvent({ eventName: 'external_again' }));
    // Fire-and-forget delivery is async, so check that local store only has disabled event
    expect(sink.getLocalStore()).toHaveLength(1);
    expect(sink.getLocalStore()[0].eventName).toBe('local_only');
  });

  it('validation still applies when disabled (Req 15.9, 15.13)', () => {
    const sink = new StageCTelemetrySink(new LocalOnlySinkAdapter());
    sink.setEnabled(false);

    const badEvent = { ...validEvent(), unknownField: 'x' } as unknown as TelemetryEvent;
    expect(sink.emit(badEvent)).toBe(false);
    expect(sink.getLocalStore()).toHaveLength(0);
    expect(sink.getDiagnostics().rejected).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// Noninterference on Sink Failure (Req 15.14)
// ────────────────────────────────────────────────────────────────────

describe('StageCTelemetrySink — noninterference on sink failure', () => {
  it('does not throw when external sink fails (Req 15.14)', () => {
    const failingSink = createMockSink(true);
    const sink = new StageCTelemetrySink(failingSink);

    // emit should never throw even when sink fails
    expect(() => sink.emit(validEvent())).not.toThrow();
  });

  it('increments sinkFailures counter on delivery failure (Req 15.14)', async () => {
    const failingSink = createMockSink(true);
    const sink = new StageCTelemetrySink(failingSink);

    sink.emit(validEvent());

    // Give async delivery time to fail
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(sink.getDiagnostics().sinkFailures).toBeGreaterThanOrEqual(1);
  });

  it('continues accepting events after sink failure (Req 15.14)', async () => {
    const failingSink = createMockSink(true);
    const sink = new StageCTelemetrySink(failingSink);

    sink.emit(validEvent({ eventName: 'first' }));
    await new Promise(resolve => setTimeout(resolve, 50));

    // Second event should still be accepted
    expect(sink.emit(validEvent({ eventName: 'second' }))).toBe(true);
    expect(sink.getDiagnostics().accepted).toBe(2);
  });

  it('flush absorbs sink exceptions without propagating (Req 15.14)', async () => {
    const failingSink = createMockSink(true);
    const sink = new StageCTelemetrySink(failingSink);

    sink.emit(validEvent());

    // flush should not throw
    await expect(sink.flush()).resolves.toBeUndefined();
  });

  it('preserves validation behavior after sink failure (Req 15.14)', async () => {
    const failingSink = createMockSink(true);
    const sink = new StageCTelemetrySink(failingSink);

    // First emit triggers a sink failure
    sink.emit(validEvent());
    await new Promise(resolve => setTimeout(resolve, 50));

    // Validation still rejects invalid events (supervision/validation preserved)
    const badEvent = { ...validEvent(), unknownField: 'x' } as unknown as TelemetryEvent;
    expect(sink.emit(badEvent)).toBe(false);
    expect(sink.getDiagnostics().rejected).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// LocalOnlySinkAdapter
// ────────────────────────────────────────────────────────────────────

describe('LocalOnlySinkAdapter', () => {
  it('stores events in memory', async () => {
    const adapter = new LocalOnlySinkAdapter();
    const events: TelemetryEvent[] = [
      validEvent({ eventName: 'a' }),
      validEvent({ eventName: 'b' }),
    ];
    await adapter.send(events);

    expect(adapter.getEvents()).toHaveLength(2);
    expect(adapter.getEvents()[0].eventName).toBe('a');
    expect(adapter.getEvents()[1].eventName).toBe('b');
  });

  it('returns a copy of stored events (not mutable reference)', async () => {
    const adapter = new LocalOnlySinkAdapter();
    await adapter.send([validEvent()]);

    const result = adapter.getEvents();
    result.push(validEvent({ eventName: 'extra' }));

    expect(adapter.getEvents()).toHaveLength(1);
  });

  it('clears stored events', async () => {
    const adapter = new LocalOnlySinkAdapter();
    await adapter.send([validEvent()]);
    expect(adapter.getEvents()).toHaveLength(1);

    adapter.clear();
    expect(adapter.getEvents()).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// Sink Adapter Replacement
// ────────────────────────────────────────────────────────────────────

describe('StageCTelemetrySink — sink adapter replacement', () => {
  it('routes to new adapter after replacement', async () => {
    const firstSink = createMockSink();
    const secondSink = createMockSink();
    const sink = new StageCTelemetrySink(firstSink);

    sink.emit(validEvent({ eventName: 'to_first' }));
    await new Promise(resolve => setTimeout(resolve, 50));

    sink.setSinkAdapter(secondSink);
    sink.emit(validEvent({ eventName: 'to_second' }));
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(firstSink.calls.length).toBeGreaterThanOrEqual(1);
    expect(secondSink.calls.length).toBeGreaterThanOrEqual(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// Validation Before Recording/Transmission (Req 15.9, 15.10)
// ────────────────────────────────────────────────────────────────────

describe('StageCTelemetrySink — validation before recording', () => {
  let mockSink: TelemetrySinkAdapter & { calls: TelemetryEvent[][] };
  let sink: StageCTelemetrySink;

  beforeEach(() => {
    mockSink = createMockSink();
    sink = new StageCTelemetrySink(mockSink);
  });

  it('validates every field before local recording (Req 15.9)', () => {
    sink.setEnabled(false);

    // Invalid event should not reach local store
    const badEvent = validEvent({ durationMs: -999 });
    expect(sink.emit(badEvent)).toBe(false);
    expect(sink.getLocalStore()).toHaveLength(0);
  });

  it('validates every field before external transmission (Req 15.9)', () => {
    const badEvent = { ...validEvent(), mystery: 123 } as unknown as TelemetryEvent;
    expect(sink.emit(badEvent)).toBe(false);
    expect(mockSink.calls).toHaveLength(0);
  });

  it('discards complete event on any bound violation (Req 15.10)', () => {
    // Event with too many measurement entries
    const measurements: Record<string, number> = {};
    for (let i = 0; i < 17; i++) {
      measurements[`m${i}`] = i;
    }
    const event = validEvent({ measurements });
    expect(sink.emit(event)).toBe(false);

    // Nothing should have been sent
    expect(mockSink.calls).toHaveLength(0);
    expect(sink.getDiagnostics().rejected).toBe(1);
    expect(sink.getDiagnostics().accepted).toBe(0);
  });

  it('rejects non-object values (Req 15.9)', () => {
    expect(sink.emit(null as unknown as TelemetryEvent)).toBe(false);
    expect(sink.emit('string' as unknown as TelemetryEvent)).toBe(false);
    expect(sink.emit(42 as unknown as TelemetryEvent)).toBe(false);
    expect(sink.emit([] as unknown as TelemetryEvent)).toBe(false);
    expect(sink.getDiagnostics().rejected).toBe(4);
  });

  it('requires both eventName and timestamp (Req 15.9)', () => {
    expect(sink.emit({ timestamp: new Date().toISOString() } as unknown as TelemetryEvent)).toBe(false);
    expect(sink.emit({ eventName: 'test' } as unknown as TelemetryEvent)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// Diagnostics Counter Integrity
// ────────────────────────────────────────────────────────────────────

describe('StageCTelemetrySink — diagnostics', () => {
  it('tracks accepted, rejected, and sinkFailures accurately', async () => {
    const failingSink = createMockSink(true);
    const sink = new StageCTelemetrySink(failingSink);

    // 2 valid events (accepted)
    sink.emit(validEvent());
    sink.emit(validEvent());
    // 1 invalid event (rejected)
    sink.emit({ ...validEvent(), badField: 'x' } as unknown as TelemetryEvent);

    await new Promise(resolve => setTimeout(resolve, 50));

    const diag = sink.getDiagnostics();
    expect(diag.accepted).toBe(2);
    expect(diag.rejected).toBe(1);
    // At least 1 sink failure from the async delivery
    expect(diag.sinkFailures).toBeGreaterThanOrEqual(1);
  });

  it('returns a copy of diagnostics (immutable)', () => {
    const sink = new StageCTelemetrySink(new LocalOnlySinkAdapter());
    sink.emit(validEvent());

    const diag = sink.getDiagnostics();
    (diag as { accepted: number }).accepted = 999;

    expect(sink.getDiagnostics().accepted).toBe(1);
  });
});
