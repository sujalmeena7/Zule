/**
 * Stage C — App Core Diagnostics Integration
 *
 * Exposes typed strategy/phase/failure/retry state locally, validates all events
 * through the Stage C telemetry model, and keeps telemetry failures noninterfering
 * with protocol, supervision, and recovery.
 *
 * Requirements: 5.25, 15.1–15.14
 */

import type { StageCController, StageCStatus } from './controller';
import { StageCTelemetrySink, type TelemetrySinkAdapter } from './telemetrySink';
import { type TelemetryEvent, validateTelemetryEvent } from './protocol/telemetry';
import {
  type StageCPhase,
  type StageCFailureReason,
  HostStrategy,
} from './protocol/schema';

// ────────────────────────────────────────────────────────────────────
// Diagnostic Status (local-only, Req 5.25)
// ────────────────────────────────────────────────────────────────────

/**
 * Extended diagnostic status exposed only through local diagnostics (Req 5.25).
 * Includes retry information that is never emitted via telemetry.
 */
export interface StageCDiagnosticStatus extends StageCStatus {
  /** Whether a diagnostic retry has been used this launch (Req 5.25). */
  diagnosticRetryUsed: boolean;
  /** Whether Stage C has failed during this App Core launch. */
  failedThisLaunch: boolean;
}

// ────────────────────────────────────────────────────────────────────
// Telemetry Emission Result
// ────────────────────────────────────────────────────────────────────

export interface TelemetryEmitResult {
  /** Whether the event was accepted by validation and the sink. */
  accepted: boolean;
  /** Validation errors (if rejected). */
  validationErrors?: string[];
}

// ────────────────────────────────────────────────────────────────────
// StageCDiagnostics
// ────────────────────────────────────────────────────────────────────

/**
 * Wires Stage C telemetry and exposes typed diagnostic status locally.
 *
 * - Wraps the controller's `status()` and adds retry state (Req 5.25)
 * - Connects the controller's `emitTelemetry` callback to the sink
 * - Validates every event through `validateTelemetryEvent` before delivery
 * - Guarantees noninterference: telemetry validation/sink failures never
 *   affect protocol, supervision, or recovery behavior (Req 15.14)
 * - Diagnostic retry status is exposed only locally (Req 5.25)
 */
export class StageCDiagnostics {
  private readonly _controller: StageCController;
  private readonly _sink: StageCTelemetrySink;
  private _diagnosticRetryUsed = false;
  private _failedThisLaunch = false;

  constructor(controller: StageCController, sink?: StageCTelemetrySink | TelemetrySinkAdapter) {
    this._controller = controller;

    if (sink instanceof StageCTelemetrySink) {
      this._sink = sink;
    } else {
      this._sink = new StageCTelemetrySink(sink);
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Public API — Status Exposure (Req 5.25)
  // ──────────────────────────────────────────────────────────────────

  /**
   * Returns the extended diagnostic status including retry state.
   * This is local-only and never emitted through telemetry (Req 5.25).
   */
  status(): StageCDiagnosticStatus {
    const controllerStatus = this._controller.status();

    return {
      ...controllerStatus,
      diagnosticRetryUsed: this._diagnosticRetryUsed,
      failedThisLaunch: this._failedThisLaunch,
    };
  }

  /**
   * Returns the underlying controller status (without retry diagnostics).
   */
  controllerStatus(): StageCStatus {
    return this._controller.status();
  }

  // ──────────────────────────────────────────────────────────────────
  // Public API — Telemetry Wiring
  // ──────────────────────────────────────────────────────────────────

  /**
   * Creates the `emitTelemetry` callback suitable for injection into the controller deps.
   *
   * The returned function:
   * - Converts the event name + data into a `TelemetryEvent`
   * - Validates the event through `validateTelemetryEvent` (Req 15.9)
   * - Routes accepted events to the sink
   * - Absorbs any error without affecting callers (Req 15.14)
   *
   * Retry status fields are explicitly excluded from emitted events (Req 5.25).
   */
  createEmitTelemetry(): (event: string, data?: Record<string, unknown>) => void {
    return (eventName: string, data?: Record<string, unknown>) => {
      try {
        // Build the telemetry event from the controller callback format
        const telemetryEvent = this._buildTelemetryEvent(eventName, data);

        // Validate before emission (Req 15.9)
        const validation = validateTelemetryEvent(telemetryEvent);
        if (!validation.valid) {
          // Silently rejected — noninterference (Req 15.14)
          return;
        }

        // Route to sink — any failure is absorbed (Req 15.14)
        this._sink.emit(telemetryEvent);
      } catch {
        // Noninterference: telemetry failures MUST NOT affect protocol,
        // supervision, or recovery (Req 15.14)
      }
    };
  }

  /**
   * Emits a pre-built TelemetryEvent with validation and noninterference.
   *
   * @returns Result indicating acceptance/rejection
   */
  emitEvent(event: TelemetryEvent, isRejection?: boolean): TelemetryEmitResult {
    try {
      // Validate the event (Req 15.9)
      const validation = validateTelemetryEvent(event, isRejection);
      if (!validation.valid) {
        return {
          accepted: false,
          validationErrors: validation.errors.map(e => e.message),
        };
      }

      // Route to sink
      const accepted = this._sink.emit(event, isRejection);
      return { accepted };
    } catch {
      // Noninterference (Req 15.14)
      return { accepted: false, validationErrors: ['Internal telemetry error'] };
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Public API — Retry Tracking (Req 5.25)
  // ──────────────────────────────────────────────────────────────────

  /**
   * Record that a diagnostic retry was used.
   * This is exposed only through local diagnostics, never telemetry (Req 5.25).
   */
  markRetryUsed(): void {
    this._diagnosticRetryUsed = true;
  }

  /**
   * Record that Stage C has failed during this App Core launch.
   */
  markFailedThisLaunch(): void {
    this._failedThisLaunch = true;
  }

  /**
   * Whether a diagnostic retry has been used this launch.
   */
  get diagnosticRetryUsed(): boolean {
    return this._diagnosticRetryUsed;
  }

  /**
   * Whether Stage C has failed during this App Core launch.
   */
  get failedThisLaunch(): boolean {
    return this._failedThisLaunch;
  }

  // ──────────────────────────────────────────────────────────────────
  // Public API — Sink Access
  // ──────────────────────────────────────────────────────────────────

  /**
   * Returns the underlying telemetry sink for diagnostics/inspection.
   */
  get sink(): StageCTelemetrySink {
    return this._sink;
  }

  // ──────────────────────────────────────────────────────────────────
  // Internal
  // ──────────────────────────────────────────────────────────────────

  /**
   * Builds a TelemetryEvent from controller callback parameters.
   * Strips any retry-related data (Req 5.25 — retry status is local-only).
   */
  private _buildTelemetryEvent(
    eventName: string,
    data?: Record<string, unknown>,
  ): TelemetryEvent {
    const event: TelemetryEvent = {
      eventName,
      timestamp: new Date().toISOString(),
    };

    if (!data) return event;

    // Map known telemetry fields from data, explicitly excluding retry status
    const EXCLUDED_FIELDS = new Set([
      'diagnosticRetryUsed',
      'diagnosticRetryCount',
      'retryStatus',
      'retryUsed',
    ]);

    // Map strategy/phase information
    if (typeof data.hostStrategy === 'string') {
      event.hostStrategy = data.hostStrategy;
    }
    if (typeof data.lifecyclePhase === 'string') {
      event.lifecyclePhase = data.lifecyclePhase;
    }
    if (typeof data.durationMs === 'number') {
      event.durationMs = data.durationMs;
    }
    if (typeof data.result === 'string') {
      event.result = data.result;
    }
    if (typeof data.failureReason === 'string') {
      event.failureReason = data.failureReason;
    }
    if (typeof data.osBuild === 'string') {
      event.osBuild = data.osBuild;
    }
    if (typeof data.architecture === 'string') {
      event.architecture = data.architecture;
    }
    if (typeof data.appCoreVersion === 'string') {
      event.appCoreVersion = data.appCoreVersion;
    }
    if (typeof data.sidecarVersion === 'string') {
      event.sidecarVersion = data.sidecarVersion;
    }
    if (typeof data.protocolVersion === 'string') {
      event.protocolVersion = data.protocolVersion;
    }
    if (typeof data.webView2RuntimeVersion === 'string') {
      event.webView2RuntimeVersion = data.webView2RuntimeVersion;
    }
    if (data.measurements && typeof data.measurements === 'object' && !Array.isArray(data.measurements)) {
      event.measurements = data.measurements as Record<string, number>;
    }

    return event;
  }
}
