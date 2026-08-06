/**
 * Stage C — Content-Free Telemetry Validator and Sink Adapter
 *
 * Enforces the exact field allowlist, field/count/value/UTF-8/event-size bounds,
 * canary-content exclusions, rejection-event subset, disabled-telemetry local
 * routing, and noninterference on sink failure.
 *
 * Requirements: 15.1–15.14
 */

import { TelemetryEvent, validateTelemetryEvent } from './protocol';

// ────────────────────────────────────────────────────────────────────
// Sink Adapter Interface
// ────────────────────────────────────────────────────────────────────

/**
 * External sink adapter interface.
 * Default implementation stores locally; production routes to configured endpoint.
 */
export interface TelemetrySinkAdapter {
  send(events: TelemetryEvent[]): Promise<void>;
}

// ────────────────────────────────────────────────────────────────────
// Local-Only Sink (default)
// ────────────────────────────────────────────────────────────────────

/**
 * Default local-only sink that stores events in memory.
 * No external calls are made.
 */
export class LocalOnlySinkAdapter implements TelemetrySinkAdapter {
  private readonly _events: TelemetryEvent[] = [];

  async send(events: TelemetryEvent[]): Promise<void> {
    this._events.push(...events);
  }

  getEvents(): TelemetryEvent[] {
    return [...this._events];
  }

  clear(): void {
    this._events.length = 0;
  }
}

// ────────────────────────────────────────────────────────────────────
// Telemetry Sink Diagnostics
// ────────────────────────────────────────────────────────────────────

export interface TelemetrySinkDiagnostics {
  /** Number of events accepted and routed. */
  accepted: number;
  /** Number of events rejected by validation. */
  rejected: number;
  /** Number of sink failures (noninterference: these don't propagate). */
  sinkFailures: number;
}

// ────────────────────────────────────────────────────────────────────
// StageCTelemetrySink
// ────────────────────────────────────────────────────────────────────

/**
 * Content-free telemetry validator and sink router for Stage C.
 *
 * - Validates every event against the exact schema before accepting (Req 15.9)
 * - Rejects invalid events silently with a diagnostic counter (Req 15.10)
 * - Canary exclusion patterns are enforced via validateTelemetryEvent (Req 15.11)
 * - When disabled, routes to local-only store (Req 15.13)
 * - Sink failures are absorbed — never propagated to callers (Req 15.13, 15.14)
 */
export class StageCTelemetrySink {
  private _enabled: boolean;
  private _externalSink: TelemetrySinkAdapter;
  private readonly _localStore: TelemetryEvent[] = [];
  private readonly _buffer: TelemetryEvent[] = [];
  private readonly _diagnostics: TelemetrySinkDiagnostics = {
    accepted: 0,
    rejected: 0,
    sinkFailures: 0,
  };

  constructor(externalSink?: TelemetrySinkAdapter) {
    this._enabled = true;
    this._externalSink = externalSink ?? new LocalOnlySinkAdapter();
  }

  /**
   * Validates and emits a telemetry event.
   *
   * @param event The telemetry event to emit
   * @param isRejection Whether this is a protocol-rejection event (permits extra fields)
   * @returns `true` if the event was accepted, `false` if rejected by validation
   */
  emit(event: TelemetryEvent, isRejection?: boolean): boolean {
    // Validate the event against the exact schema (Req 15.9)
    const result = validateTelemetryEvent(event, isRejection ?? false);

    if (!result.valid) {
      // Reject silently — increment diagnostic counter, no throw (Req 15.10, 15.14)
      this._diagnostics.rejected++;
      return false;
    }

    this._diagnostics.accepted++;

    // Route based on enabled state (Req 15.13)
    if (!this._enabled) {
      // Disabled: store locally in the governed diagnostic channel
      this._localStore.push({ ...event });
      return true;
    }

    // Buffer for external delivery
    this._buffer.push({ ...event });

    // Attempt immediate delivery — noninterference on failure (Req 15.14)
    this._deliverBuffered();

    return true;
  }

  /**
   * Enable or disable external telemetry routing.
   * When disabled, accepted events route to the local diagnostic store only (Req 15.13).
   */
  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }

  /**
   * Returns whether external telemetry is enabled.
   */
  isEnabled(): boolean {
    return this._enabled;
  }

  /**
   * Flushes any buffered events to the configured sink.
   * Noninterference: failures are absorbed silently (Req 15.14).
   */
  async flush(): Promise<void> {
    if (this._buffer.length === 0) return;

    const batch = this._buffer.splice(0);
    try {
      await this._externalSink.send(batch);
    } catch {
      // Noninterference: sink failure must NOT affect protocol, supervision,
      // or recovery behavior (Req 15.14). Count for diagnostics only.
      this._diagnostics.sinkFailures++;
    }
  }

  /**
   * Returns events stored in the local diagnostic channel.
   * Includes events routed locally when telemetry is disabled.
   */
  getLocalStore(): TelemetryEvent[] {
    return [...this._localStore];
  }

  /**
   * Returns current diagnostic counters.
   */
  getDiagnostics(): Readonly<TelemetrySinkDiagnostics> {
    return { ...this._diagnostics };
  }

  /**
   * Replaces the external sink adapter.
   */
  setSinkAdapter(adapter: TelemetrySinkAdapter): void {
    this._externalSink = adapter;
  }

  // ──────────────────────────────────────────────────────────────────
  // Internal
  // ──────────────────────────────────────────────────────────────────

  /**
   * Attempts to deliver buffered events without throwing.
   * Noninterference guarantee: any failure is absorbed.
   */
  private _deliverBuffered(): void {
    if (this._buffer.length === 0) return;

    const batch = this._buffer.splice(0);
    // Fire-and-forget with error absorption
    Promise.resolve()
      .then(() => this._externalSink.send(batch))
      .catch(() => {
        // Noninterference: absorbed silently (Req 15.14)
        this._diagnostics.sinkFailures++;
      });
  }
}
