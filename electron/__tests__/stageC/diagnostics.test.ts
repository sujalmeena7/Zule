/**
 * Stage C — App Core Diagnostics Integration Tests
 *
 * Tests for StageCDiagnostics:
 * - Status correctly reflects controller phase/failure/strategy (Req 5.25)
 * - Telemetry events are validated before emission (Req 15.9)
 * - Sink failures don't interfere with controller operation (Req 15.14)
 * - Retry status is available locally but not in telemetry events (Req 5.25)
 *
 * Requirements: 5.25, 15.1–15.14
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { StageCDiagnostics, type StageCDiagnosticStatus } from '../../stageC/diagnostics';
import { StageCTelemetrySink, LocalOnlySinkAdapter, type TelemetrySinkAdapter } from '../../stageC/telemetrySink';
import { type TelemetryEvent } from '../../stageC/protocol/telemetry';
import {
  StageCPhase,
  HostStrategy,
  StageCFailureReason,
} from '../../stageC/protocol/schema';
import type { StageCController, StageCStatus } from '../../stageC/controller';

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function createMockController(statusOverrides: Partial<StageCStatus> = {}): StageCController {
  const defaultStatus: StageCStatus = {
    strategy: HostStrategy.LAYER_0,
    phase: StageCPhase.DISABLED,
    failure: null,
    launch_id: null,
    overlay_revision: 0,
    ...statusOverrides,
  };

  return {
    status: vi.fn(() => ({ ...defaultStatus })),
    get hasFailedThisLaunch() { return false; },
    requestOverlay: vi.fn(),
    stopOverlay: vi.fn(),
    requestDiagnosticRetry: vi.fn(),
    onProcessExit: vi.fn(),
    onDisconnect: vi.fn(),
    onCaptureFailure: vi.fn(),
  } as unknown as StageCController;
}

function createFailingSink(): TelemetrySinkAdapter & { calls: TelemetryEvent[][] } {
  const calls: TelemetryEvent[][] = [];
  return {
    calls,
    async send(events: TelemetryEvent[]): Promise<void> {
      calls.push([...events]);
      throw new Error('Sink delivery failure');
    },
  };
}

function createTrackingSink(): TelemetrySinkAdapter & { calls: TelemetryEvent[][] } {
  const calls: TelemetryEvent[][] = [];
  return {
    calls,
    async send(events: TelemetryEvent[]): Promise<void> {
      calls.push([...events]);
    },
  };
}

function validEvent(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    eventName: 'stage_c_startup',
    timestamp: new Date().toISOString(),
    hostStrategy: 'STAGE_C',
    lifecyclePhase: 'ACTIVE',
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────
// Status Exposure (Req 5.25)
// ────────────────────────────────────────────────────────────────────

describe('StageCDiagnostics — status exposure', () => {
  it('reflects controller phase in diagnostic status', () => {
    const controller = createMockController({
      phase: StageCPhase.AUTHENTICATING,
      strategy: HostStrategy.LAYER_0,
    });
    const diag = new StageCDiagnostics(controller);

    const status = diag.status();
    expect(status.phase).toBe(StageCPhase.AUTHENTICATING);
    expect(status.strategy).toBe(HostStrategy.LAYER_0);
  });

  it('reflects controller failure reason in diagnostic status', () => {
    const controller = createMockController({
      phase: StageCPhase.FALLING_BACK,
      failure: StageCFailureReason.STARTUP_TIMEOUT,
    });
    const diag = new StageCDiagnostics(controller);

    const status = diag.status();
    expect(status.failure).toBe(StageCFailureReason.STARTUP_TIMEOUT);
  });

  it('reflects controller strategy (STAGE_C) when active', () => {
    const controller = createMockController({
      phase: StageCPhase.ACTIVE,
      strategy: HostStrategy.STAGE_C,
      launch_id: 'test-launch-123',
      overlay_revision: 5,
    });
    const diag = new StageCDiagnostics(controller);

    const status = diag.status();
    expect(status.strategy).toBe(HostStrategy.STAGE_C);
    expect(status.launch_id).toBe('test-launch-123');
    expect(status.overlay_revision).toBe(5);
  });

  it('includes diagnosticRetryUsed=false initially (Req 5.25)', () => {
    const controller = createMockController();
    const diag = new StageCDiagnostics(controller);

    expect(diag.status().diagnosticRetryUsed).toBe(false);
  });

  it('includes failedThisLaunch=false initially', () => {
    const controller = createMockController();
    const diag = new StageCDiagnostics(controller);

    expect(diag.status().failedThisLaunch).toBe(false);
  });

  it('reflects diagnosticRetryUsed=true after marking (Req 5.25)', () => {
    const controller = createMockController();
    const diag = new StageCDiagnostics(controller);

    diag.markRetryUsed();
    expect(diag.status().diagnosticRetryUsed).toBe(true);
    expect(diag.diagnosticRetryUsed).toBe(true);
  });

  it('reflects failedThisLaunch=true after marking', () => {
    const controller = createMockController();
    const diag = new StageCDiagnostics(controller);

    diag.markFailedThisLaunch();
    expect(diag.status().failedThisLaunch).toBe(true);
    expect(diag.failedThisLaunch).toBe(true);
  });

  it('controllerStatus() returns base status without retry info', () => {
    const controller = createMockController({
      phase: StageCPhase.ACTIVE,
      strategy: HostStrategy.STAGE_C,
    });
    const diag = new StageCDiagnostics(controller);
    diag.markRetryUsed();

    const cs = diag.controllerStatus();
    expect(cs.phase).toBe(StageCPhase.ACTIVE);
    expect((cs as any).diagnosticRetryUsed).toBeUndefined();
    expect((cs as any).failedThisLaunch).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────
// Telemetry Validation (Req 15.9)
// ────────────────────────────────────────────────────────────────────

describe('StageCDiagnostics — telemetry event validation', () => {
  let controller: StageCController;
  let trackingSink: TelemetrySinkAdapter & { calls: TelemetryEvent[][] };
  let diag: StageCDiagnostics;

  beforeEach(() => {
    controller = createMockController({ phase: StageCPhase.ACTIVE, strategy: HostStrategy.STAGE_C });
    trackingSink = createTrackingSink();
    diag = new StageCDiagnostics(controller, new StageCTelemetrySink(trackingSink));
  });

  it('validates events before emission via emitEvent (Req 15.9)', () => {
    const result = diag.emitEvent(validEvent());
    expect(result.accepted).toBe(true);
  });

  it('rejects invalid events in emitEvent (Req 15.9)', () => {
    const badEvent = { ...validEvent(), unknownField: 'x' } as unknown as TelemetryEvent;
    const result = diag.emitEvent(badEvent);
    expect(result.accepted).toBe(false);
    expect(result.validationErrors).toBeDefined();
    expect(result.validationErrors!.length).toBeGreaterThan(0);
  });

  it('rejects events with canary content via emitEvent (Req 15.11)', () => {
    const event = validEvent({ result: 'sk-abcdefghijklmnopqrstuvwxyz' });
    const result = diag.emitEvent(event);
    expect(result.accepted).toBe(false);
  });

  it('validates events through createEmitTelemetry callback (Req 15.9)', async () => {
    const emit = diag.createEmitTelemetry();

    // Valid event should pass through
    emit('stage_c_active', { hostStrategy: 'STAGE_C', durationMs: 150 });
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(trackingSink.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects invalid data through createEmitTelemetry silently (Req 15.9, 15.14)', async () => {
    const localSink = new LocalOnlySinkAdapter();
    const sink = new StageCTelemetrySink(localSink);
    const localDiag = new StageCDiagnostics(controller, sink);
    const emit = localDiag.createEmitTelemetry();

    // Event with an eventName that exceeds limits should be rejected
    emit('x'.repeat(65), {});
    await new Promise(resolve => setTimeout(resolve, 50));

    // Should NOT reach the sink (validated before emission)
    expect(sink.getDiagnostics().accepted).toBe(0);
  });

  it('validates rejection events with isRejection flag (Req 15.2)', () => {
    const rejectionEvent = validEvent({
      eventName: 'protocol_rejection',
      category: 'schema',
      direction: 'inbound',
      decodedType: 'unknown_type',
      byteCount: 128,
    } as Partial<TelemetryEvent>);

    const result = diag.emitEvent(rejectionEvent, true);
    expect(result.accepted).toBe(true);
  });

  it('rejects rejection-only fields on non-rejection events (Req 15.2)', () => {
    const event = { ...validEvent(), category: 'schema' } as TelemetryEvent;
    const result = diag.emitEvent(event, false);
    expect(result.accepted).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// Noninterference (Req 15.14)
// ────────────────────────────────────────────────────────────────────

describe('StageCDiagnostics — noninterference on failure', () => {
  it('createEmitTelemetry never throws even when sink fails (Req 15.14)', () => {
    const failingSink = createFailingSink();
    const sink = new StageCTelemetrySink(failingSink);
    const controller = createMockController();
    const diag = new StageCDiagnostics(controller, sink);

    const emit = diag.createEmitTelemetry();

    // Should never throw
    expect(() => emit('test_event', { hostStrategy: 'STAGE_C' })).not.toThrow();
  });

  it('emitEvent never throws even when sink fails (Req 15.14)', () => {
    const failingSink = createFailingSink();
    const sink = new StageCTelemetrySink(failingSink);
    const controller = createMockController();
    const diag = new StageCDiagnostics(controller, sink);

    expect(() => diag.emitEvent(validEvent())).not.toThrow();
  });

  it('controller status remains accessible after sink failure (Req 15.14)', async () => {
    const failingSink = createFailingSink();
    const sink = new StageCTelemetrySink(failingSink);
    const controller = createMockController({
      phase: StageCPhase.ACTIVE,
      strategy: HostStrategy.STAGE_C,
    });
    const diag = new StageCDiagnostics(controller, sink);

    // Emit to trigger sink failure
    const emit = diag.createEmitTelemetry();
    emit('test_event', { hostStrategy: 'STAGE_C' });
    await new Promise(resolve => setTimeout(resolve, 50));

    // Status should still be accessible and correct
    const status = diag.status();
    expect(status.phase).toBe(StageCPhase.ACTIVE);
    expect(status.strategy).toBe(HostStrategy.STAGE_C);
  });

  it('validation failures do not affect controller (Req 15.14)', () => {
    const controller = createMockController({ phase: StageCPhase.SYNCHRONIZING });
    const diag = new StageCDiagnostics(controller);

    // Multiple invalid events
    diag.emitEvent({ eventName: '', timestamp: '' } as TelemetryEvent);
    diag.emitEvent(null as unknown as TelemetryEvent);
    diag.emitEvent({ ...validEvent(), unknownField: 'x' } as unknown as TelemetryEvent);

    // Controller should still work fine
    expect(controller.status).toHaveBeenCalled;
    expect(diag.status().phase).toBe(StageCPhase.SYNCHRONIZING);
  });

  it('sink.getDiagnostics().sinkFailures increments on sink failure without affecting diagnostics (Req 15.14)', async () => {
    const failingSink = createFailingSink();
    const sink = new StageCTelemetrySink(failingSink);
    const controller = createMockController();
    const diag = new StageCDiagnostics(controller, sink);

    diag.emitEvent(validEvent());
    await new Promise(resolve => setTimeout(resolve, 50));

    // Sink failure counted but doesn't propagate
    expect(diag.sink.getDiagnostics().sinkFailures).toBeGreaterThanOrEqual(1);
    // Diagnostics status unaffected
    expect(diag.status().phase).toBe(StageCPhase.DISABLED);
  });
});

// ────────────────────────────────────────────────────────────────────
// Retry Status Local-Only (Req 5.25)
// ────────────────────────────────────────────────────────────────────

describe('StageCDiagnostics — retry status is local-only', () => {
  it('retry status is NOT included in telemetry events (Req 5.25)', async () => {
    const trackingSink = createTrackingSink();
    const sink = new StageCTelemetrySink(trackingSink);
    const controller = createMockController();
    const diag = new StageCDiagnostics(controller, sink);

    diag.markRetryUsed();
    diag.markFailedThisLaunch();

    const emit = diag.createEmitTelemetry();
    // Include retry-related data that should be stripped
    emit('fallback_event', {
      hostStrategy: 'LAYER_0',
      diagnosticRetryUsed: true,
      retryStatus: 'used',
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    // Verify the emitted event does NOT contain retry data
    expect(trackingSink.calls.length).toBeGreaterThanOrEqual(1);
    const emittedEvents = trackingSink.calls.flat();
    for (const event of emittedEvents) {
      expect((event as any).diagnosticRetryUsed).toBeUndefined();
      expect((event as any).retryStatus).toBeUndefined();
      expect((event as any).diagnosticRetryCount).toBeUndefined();
      expect((event as any).retryUsed).toBeUndefined();
    }
  });

  it('retry status is available through local diagnostics (Req 5.25)', () => {
    const controller = createMockController();
    const diag = new StageCDiagnostics(controller);

    // Initially not used
    expect(diag.status().diagnosticRetryUsed).toBe(false);

    // After marking
    diag.markRetryUsed();
    expect(diag.status().diagnosticRetryUsed).toBe(true);
    expect(diag.diagnosticRetryUsed).toBe(true);
  });

  it('failedThisLaunch status is available locally but not in telemetry (Req 5.25)', async () => {
    const trackingSink = createTrackingSink();
    const sink = new StageCTelemetrySink(trackingSink);
    const controller = createMockController();
    const diag = new StageCDiagnostics(controller, sink);

    diag.markFailedThisLaunch();

    // Available locally
    expect(diag.status().failedThisLaunch).toBe(true);

    // Not in telemetry
    const emit = diag.createEmitTelemetry();
    emit('test', { failedThisLaunch: true } as any);
    await new Promise(resolve => setTimeout(resolve, 50));

    if (trackingSink.calls.length > 0) {
      const emitted = trackingSink.calls.flat();
      for (const event of emitted) {
        expect((event as any).failedThisLaunch).toBeUndefined();
      }
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// createEmitTelemetry Integration
// ────────────────────────────────────────────────────────────────────

describe('StageCDiagnostics — createEmitTelemetry callback', () => {
  it('builds valid telemetry event from event name and data', async () => {
    const trackingSink = createTrackingSink();
    const sink = new StageCTelemetrySink(trackingSink);
    const controller = createMockController();
    const diag = new StageCDiagnostics(controller, sink);

    const emit = diag.createEmitTelemetry();
    emit('stage_c_active', {
      hostStrategy: 'STAGE_C',
      durationMs: 2500,
      result: 'success',
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(trackingSink.calls.length).toBeGreaterThanOrEqual(1);
    const event = trackingSink.calls[0][0];
    expect(event.eventName).toBe('stage_c_active');
    expect(event.hostStrategy).toBe('STAGE_C');
    expect(event.durationMs).toBe(2500);
    expect(event.result).toBe('success');
    expect(event.timestamp).toBeDefined();
  });

  it('handles call with no data argument', async () => {
    const trackingSink = createTrackingSink();
    const sink = new StageCTelemetrySink(trackingSink);
    const controller = createMockController();
    const diag = new StageCDiagnostics(controller, sink);

    const emit = diag.createEmitTelemetry();
    emit('probe_failed');

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(trackingSink.calls.length).toBeGreaterThanOrEqual(1);
    const event = trackingSink.calls[0][0];
    expect(event.eventName).toBe('probe_failed');
    expect(event.timestamp).toBeDefined();
  });

  it('maps measurements from data to event (Req 15.7)', async () => {
    const trackingSink = createTrackingSink();
    const sink = new StageCTelemetrySink(trackingSink);
    const controller = createMockController();
    const diag = new StageCDiagnostics(controller, sink);

    const emit = diag.createEmitTelemetry();
    emit('performance', { measurements: { probe_ms: 42, auth_ms: 100 } });

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(trackingSink.calls.length).toBeGreaterThanOrEqual(1);
    const event = trackingSink.calls[0][0];
    expect(event.measurements).toEqual({ probe_ms: 42, auth_ms: 100 });
  });

  it('does not include unknown fields in emitted event', async () => {
    const trackingSink = createTrackingSink();
    const sink = new StageCTelemetrySink(trackingSink);
    const controller = createMockController();
    const diag = new StageCDiagnostics(controller, sink);

    const emit = diag.createEmitTelemetry();
    emit('test', { unknownField: 'should_not_appear', hostStrategy: 'LAYER_0' });

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(trackingSink.calls.length).toBeGreaterThanOrEqual(1);
    const event = trackingSink.calls[0][0];
    expect((event as any).unknownField).toBeUndefined();
    expect(event.hostStrategy).toBe('LAYER_0');
  });
});

// ────────────────────────────────────────────────────────────────────
// Constructor Variants
// ────────────────────────────────────────────────────────────────────

describe('StageCDiagnostics — constructor', () => {
  it('accepts a StageCTelemetrySink instance directly', () => {
    const controller = createMockController();
    const sink = new StageCTelemetrySink();
    const diag = new StageCDiagnostics(controller, sink);

    expect(diag.sink).toBe(sink);
  });

  it('accepts a TelemetrySinkAdapter and wraps it', () => {
    const controller = createMockController();
    const adapter = new LocalOnlySinkAdapter();
    const diag = new StageCDiagnostics(controller, adapter);

    expect(diag.sink).toBeInstanceOf(StageCTelemetrySink);
  });

  it('creates a default sink when none provided', () => {
    const controller = createMockController();
    const diag = new StageCDiagnostics(controller);

    expect(diag.sink).toBeInstanceOf(StageCTelemetrySink);
  });
});
