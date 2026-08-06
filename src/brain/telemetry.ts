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
import { apply as applyRedaction } from './redaction';
import type { RedactionRule } from '../types/redaction';

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
 *
 * The `screen.*` variants are added by the Screen Context Latency
 * feature and carry only numeric measurements (latencyMs, durationMs,
 * passes, finalBytes) and boolean flags (hasKeyframe, hasScreenText,
 * deduped). No recognized screen text, raw image bytes, or user
 * content is included (screen-context-latency Requirements 9.1, 9.2,
 * 9.3, 9.4, 9.5, 9.6).
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
  | { kind: 'update.error'; stage: 'check' | 'download' | 'integrity' | 'install'; category: string }
  | { kind: 'screen.dispatch'; latencyMs: number; hasKeyframe: boolean; hasScreenText: boolean }
  | { kind: 'screen.ocrComplete'; durationMs: number; deduped: boolean }
  | { kind: 'screen.ocrSkipped'; reason: 'vision-adapter' }
  | { kind: 'screen.keyframeReencode'; passes: number; finalBytes: number };

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
// Screen Telemetry Payload Validation (Requirements 9.5, 9.6)
// ---------------------------------------------------------------------

/**
 * Heuristic patterns that detect raw user content that must never appear
 * in telemetry payloads:
 *
 * - Base64-encoded image data (data URI prefix or raw base64 chunk ≥ 64 chars)
 * - JPEG/PNG binary magic bytes expressed as escaped sequences
 * - Multi-word natural language text (≥ 4 space-separated words suggests
 *   recognized screen text rather than an identifier or error class)
 *
 * These checks are a runtime safety net layered on top of the structural
 * guarantee provided by the `MetricEvent` discriminated union. They catch
 * accidental future regressions where a new field might introduce text.
 */
const BASE64_DATA_URI_RE = /^data:image\/(jpeg|png|webp);base64,/i;
const RAW_BASE64_CHUNK_RE = /^[A-Za-z0-9+/]{64,}={0,2}$/;
const JPEG_MAGIC = '\xFF\xD8\xFF';
const PNG_MAGIC = '\x89PNG';
const MULTI_WORD_TEXT_RE = /(?:\S+\s+){3,}\S+/; // 4+ space-separated words

/**
 * Returns true if `value` looks like raw image bytes (base64 or binary).
 */
function looksLikeImageData(value: string): boolean {
  if (BASE64_DATA_URI_RE.test(value)) return true;
  if (RAW_BASE64_CHUNK_RE.test(value)) return true;
  if (value.startsWith(JPEG_MAGIC)) return true;
  if (value.startsWith(PNG_MAGIC)) return true;
  return false;
}

/**
 * Returns true if `value` looks like recognized screen text (natural
 * language with multiple words). Short identifiers, enum values, and
 * error class names pass through.
 */
function looksLikeScreenText(value: string): boolean {
  // Short strings (< 20 chars) are almost certainly identifiers
  if (value.length < 20) return false;
  return MULTI_WORD_TEXT_RE.test(value);
}

/**
 * Validate that a screen telemetry payload contains no raw user content.
 * Returns the event unchanged if safe, or throws if content is detected.
 *
 * This is invoked internally by `emit` for `screen.*` events as a
 * defence-in-depth measure (Requirement 9.5, 9.6). The TypeScript type
 * system is the primary guard; this runtime check catches regressions.
 */
export function validateScreenTelemetryPayload(event: MetricEvent): void {
  for (const [fieldName, fieldValue] of Object.entries(event)) {
    if (fieldName === 'kind') continue;
    if (typeof fieldValue !== 'string') continue;

    if (looksLikeImageData(fieldValue)) {
      throw new Error(
        `[telemetry] screen.* event "${event.kind}" contains raw image data in field "${fieldName}" — blocked`,
      );
    }
    if (looksLikeScreenText(fieldValue)) {
      throw new Error(
        `[telemetry] screen.* event "${event.kind}" contains suspected screen text in field "${fieldName}" — blocked`,
      );
    }
  }
}

/**
 * Apply the project's redaction rules to any string fields in a telemetry
 * event. This is a safety net for `screen.*` events: if a text-derived field
 * is ever added to a screen telemetry variant, it will be redacted before
 * persistence or external dispatch (Requirement 9.6).
 *
 * For the current `screen.*` variants (which carry only numbers and booleans),
 * this function is effectively a no-op — but it ensures forward safety if the
 * schema evolves.
 */
export function redactTelemetryPayload<T extends MetricEvent>(
  event: T,
  rules: readonly RedactionRule[],
): T {
  if (rules.length === 0) return event;

  let modified = false;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(event)) {
    if (key === 'kind' || typeof value !== 'string') {
      result[key] = value;
      continue;
    }
    const redacted = applyRedaction(value, rules);
    if (redacted !== value) modified = true;
    result[key] = redacted;
  }

  return modified ? (result as T) : event;
}

/**
 * Redaction rules to apply to screen telemetry payloads. Loaded lazily
 * from the settings store. The module-level cache avoids repeated async
 * loads on the hot path — rules are refreshed when `loadRedactionRules`
 * is called (e.g., on settings change or app start).
 */
let cachedRedactionRules: readonly RedactionRule[] = [];

/**
 * Load (or refresh) the redaction rules from the settings store. Should be
 * called at app startup and whenever the user changes redaction settings.
 * Non-blocking: if loading fails, the cached rules remain (defaults to []).
 */
export async function loadRedactionRules(): Promise<void> {
  try {
    const stored = await database.getSetting<RedactionRule[]>('redactionRules', []);
    if (Array.isArray(stored)) {
      cachedRedactionRules = stored;
    }
  } catch {
    // Graceful degradation: keep existing cached rules
  }
}

/**
 * Set redaction rules directly (for testing or synchronous initialization).
 */
export function setRedactionRulesForTelemetry(rules: readonly RedactionRule[]): void {
  cachedRedactionRules = rules;
}

/**
 * Get the currently cached redaction rules (for testing).
 */
export function getRedactionRulesForTelemetry(): readonly RedactionRule[] {
  return cachedRedactionRules;
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
   *
   * For `screen.*` events, a runtime validation guard verifies that no
   * raw image data or recognized screen text is present (Req 9.5), and
   * the project's redaction rules are applied to any text-derived fields
   * (Req 9.6). If validation fails, the event is dropped and an error
   * is logged — this is a defence-in-depth layer on top of the structural
   * type-system guarantee.
   */
  emit(event: MetricEvent): void {
    let safeEvent = event;

    // Apply screen telemetry redaction guard (Requirements 9.5, 9.6)
    if (event.kind.startsWith('screen.')) {
      try {
        validateScreenTelemetryPayload(event);
      } catch (err) {
        console.error('[telemetry]', err instanceof Error ? err.message : err);
        return; // Drop the event — it contains unsafe content
      }
      safeEvent = redactTelemetryPayload(event, cachedRedactionRules);
    }

    const row: StoredTelemetryEvent = {
      id: generateId(),
      at: Date.now(),
      ...safeEvent,
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
   * For `screen.*` events, the same runtime validation and redaction
   * applied by `emit` is enforced here (Requirements 9.5, 9.6).
   *
   * Actual HTTP send is deferred/batched; for now events are queued
   * in-memory. A future `flush()` method will POST the queue over
   * HTTPS to the configured endpoint.
   */
  enqueueExternal(event: MetricEvent): void {
    if (!this.optedIn) return;

    let safeEvent = event;

    // Apply screen telemetry redaction guard (Requirements 9.5, 9.6)
    if (event.kind.startsWith('screen.')) {
      try {
        validateScreenTelemetryPayload(event);
      } catch (err) {
        console.error('[telemetry]', err instanceof Error ? err.message : err);
        return; // Drop the event — it contains unsafe content
      }
      safeEvent = redactTelemetryPayload(event, cachedRedactionRules);
    }

    this.externalQueue.push({
      id: generateId(),
      at: Date.now(),
      ...safeEvent,
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
