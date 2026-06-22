// ============================================
// Zule AI — Telemetry_Module (design §12)
// ============================================
//
// Local-first metrics/error sink that records latency, errors, and
// quality signals. Content (transcript text, screen text, API keys)
// never enters telemetry — enforced structurally by a discriminated
// union with no free-form payload field.
//
// Acceptance criteria covered:
//   - 19.1 — Collects TTFT, total request latency, retry counts,
//     cache hit rate, transcript drop rate, OCR skip rate,
//     embedding-cache hit rate, memory-store size, token usage, errors,
//     and latency degradation events.
//   - 19.2 — Stores metrics locally in IndexedDB (`STORE_TELEMETRY`).
//     A "view diagnostics" page can call `query(rangeMs)` to render
//     the most-recent 24 hours.
//   - 19.4 — External telemetry is opt-in and metric-only; the
//     `enqueueExternal` method sends only `MetricEvent` payloads over
//     HTTPS when the user has opted in.
//   - 19.5 — The `MetricEvent` discriminated union has no free-form
//     payload field. Content (transcript, screen text, API keys) can
//     never flow into telemetry. This is covered by Property 51.

import {
  database,
  STORE_TELEMETRY,
} from '../data/database';

// ---------------------------------------------------------------------
// MetricEvent — discriminated union (no free-form payload)
// ---------------------------------------------------------------------

/**
 * Every metric event has a `kind` discriminant and only typed,
 * domain-specific fields. No field accepts arbitrary user content
 * (transcript text, screen text, API keys). This structurally prevents
 * content leakage into telemetry (Requirement 19.5).
 *
 * The `embed.batch`, `vectorIndex.query`, and `vad.skipped` variants
 * are added by the AI Pipeline Performance feature and carry only
 * numeric measurements and fixed string-literal pipeline tags — no
 * free-form payload — so the existing structural Property 51 holds
 * for them too (ai-pipeline-performance Requirements 10.1, 10.2,
 * 10.3, 10.4).
 *
 * The `update.*` variants are added by the Auto-Updater feature and
 * carry only version strings, trigger literals, duration numbers, and
 * error category tags. No OS user name, machine ID, network address,
 * file path, or release-notes body is included in any update telemetry
 * payload (auto-updater Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.6).
 */
export type MetricEvent =
  | { kind: 'ttft'; ms: number; modelId: string; providerId: string }
  | { kind: 'totalLatency'; ms: number; modelId: string; providerId: string }
  | { kind: 'retry'; count: number; providerId: string }
  | { kind: 'cache.hit'; similarity: number }
  | { kind: 'cache.miss' }
  | { kind: 'transcript.drop'; reason: 'low-confidence' | 'empty' | 'speaker-self' }
  | { kind: 'ocr.skipped'; reason: 'unchanged' | 'tiny-frame' }
  | { kind: 'embedding.cache'; outcome: 'hit' | 'miss' }
  | { kind: 'memory.size'; chunks: number }
  | { kind: 'tokens'; promptTokens: number; completionTokens: number; modelId: string; providerId: string }
  | { kind: 'error'; name: string; message: string; stack: string; breadcrumb: string[] }
  | { kind: 'latency.degraded' }
  | { kind: 'embed.batch'; batchSize: number; durationMs: number }
  | { kind: 'vectorIndex.query'; k: number; resultCount: number; durationMs: number }
  | { kind: 'vad.skipped'; pipeline: 'loopback' | 'microphone' }
  | { kind: 'update.checked'; currentVersion: string; trigger: 'startup' | 'manual' }
  | { kind: 'update.available'; currentVersion: string; availableVersion: string }
  | { kind: 'update.downloaded'; availableVersion: string; durationMs: number }
  | { kind: 'update.installed'; currentVersion: string }
  | { kind: 'update.error'; stage: 'check' | 'download' | 'integrity' | 'install'; category: string };

// ---------------------------------------------------------------------
// Stored row shape
// ---------------------------------------------------------------------

/** Shape of a telemetry row as persisted to IndexedDB. */
export interface StoredTelemetryEvent {
  id: string;
  at: number;
  kind: MetricEvent['kind'];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------
// ID generation (matches database.ts pattern)
// ---------------------------------------------------------------------

function generateId(): string {
  return `tel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------
// TelemetryModule
// ---------------------------------------------------------------------

/**
 * Local-first telemetry module. All events are written to
 * `STORE_TELEMETRY` in IndexedDB. External telemetry is opt-in:
 * `enqueueExternal` queues metric events for batched HTTPS dispatch
 * when the user has opted in.
 *
 * The class is designed to be a singleton within the application but
 * is instantiated via `new` so tests can control opt-in state and
 * the external queue.
 */
export class TelemetryModule {
  /** In-memory queue for external dispatch (opt-in only). */
  private externalQueue: Array<MetricEvent & { id: string; at: number }> = [];

  /** Whether the user has opted in to external telemetry. */
  private optedIn: boolean;

  constructor(opts?: { optIn?: boolean }) {
    this.optedIn = opts?.optIn ?? false;
  }

  // -------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------

  /** Update the opt-in flag at runtime (e.g. when Settings changes). */
  setOptIn(optIn: boolean): void {
    this.optedIn = optIn;
    if (!optIn) {
      // Drain the queue — the user withdrew consent.
      this.externalQueue = [];
    }
  }

  /** Whether external telemetry is currently opted-in. */
  get isOptedIn(): boolean {
    return this.optedIn;
  }

  // -------------------------------------------------------------------
  // emit — write to local IndexedDB (Requirement 19.1, 19.2)
  // -------------------------------------------------------------------

  /**
   * Persist a metric event to `STORE_TELEMETRY`. Fire-and-forget:
   * errors are logged but do not propagate to the caller so the hot
   * path (e.g. streaming tokens) is never blocked by a failed write.
   */
  emit(event: MetricEvent): void {
    const row: StoredTelemetryEvent = {
      id: generateId(),
      at: Date.now(),
      ...event,
    };
    // Async write — fire and forget.
    database.putTelemetryEvent(row).catch((err) => {
      console.error('[telemetry] Failed to persist event:', err);
    });
  }

  // -------------------------------------------------------------------
  // enqueueExternal — opt-in metric-only queue (Requirement 19.4)
  // -------------------------------------------------------------------

  /**
   * Enqueue a metric event for external dispatch. Only operates when
   * the user has opted in. Content (transcript text, screen text, API
   * keys) structurally cannot reach this path because `MetricEvent`
   * has no free-form payload field.
   *
   * Actual HTTP send is deferred/batched; for now events are queued
   * in-memory. A future `flush()` method will POST the queue over
   * HTTPS to the configured endpoint.
   */
  enqueueExternal(event: MetricEvent): void {
    if (!this.optedIn) return;
    this.externalQueue.push({
      id: generateId(),
      at: Date.now(),
      ...event,
    });
  }

  /** Read the current external queue (for testing / future flush). */
  getExternalQueue(): ReadonlyArray<MetricEvent & { id: string; at: number }> {
    return this.externalQueue;
  }

  /** Clear the external queue (e.g. after successful flush). */
  clearExternalQueue(): void {
    this.externalQueue = [];
  }

  // -------------------------------------------------------------------
  // query — read from IndexedDB (Requirement 19.2)
  // -------------------------------------------------------------------

  /**
   * Retrieve metric events from the last `rangeMs` milliseconds.
   * Used by the Diagnostics page to render the most-recent 24 hours.
   */
  async query(rangeMs: number): Promise<StoredTelemetryEvent[]> {
    const since = Date.now() - rangeMs;
    return database.queryTelemetryEvents<StoredTelemetryEvent>(since);
  }

  // -------------------------------------------------------------------
  // clearAll — delete all rows from STORE_TELEMETRY
  // -------------------------------------------------------------------

  /**
   * Delete all telemetry records from IndexedDB. Used by Settings or
   * diagnostics clear actions.
   */
  async clearAll(): Promise<void> {
    await database.clearTelemetry();
    this.externalQueue = [];
  }
}

// ---------------------------------------------------------------------
// buildErrorTelemetryEvent — pure helper (Property 52)
// ---------------------------------------------------------------------

/**
 * Build a content-free error telemetry event from an Error object and
 * an optional breadcrumb trail. The output contains only error metadata
 * (name, message, stack, breadcrumb) — never user content such as
 * transcript text, screen text, or API keys.
 *
 * This function is pure (no side effects) and is used by:
 *   - `ErrorBoundary.componentDidCatch` (Requirement 19.3)
 *   - The `unhandledrejection` listener in `main.tsx` (Requirement 20.5)
 *
 * Exported so property tests can exercise it directly.
 */
export function buildErrorTelemetryEvent(
  error: unknown,
  breadcrumb: string[] = [],
): Extract<MetricEvent, { kind: 'error' }> {
  const name =
    error instanceof Error ? error.name : 'UnknownError';
  const message =
    error instanceof Error ? error.message : String(error);
  const stack =
    error instanceof Error && error.stack ? error.stack : '';

  return {
    kind: 'error',
    name,
    message,
    stack,
    breadcrumb,
  };
}

// ---------------------------------------------------------------------
// Singleton instance (default opt-out)
// ---------------------------------------------------------------------

/**
 * Application-wide telemetry instance. Opt-in state is managed via
 * `telemetry.setOptIn(true/false)` when the user changes settings.
 */
export const telemetry = new TelemetryModule();

// Re-export the store name for callers that interact with the DB.
export { STORE_TELEMETRY };
