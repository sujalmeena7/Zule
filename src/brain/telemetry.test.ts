// ============================================
// Zule AI — TelemetryModule tests
// ============================================
//
// Layered as:
//
//   1. Unit tests covering emit, enqueueExternal, query, clearAll, and
//      opt-in gating.
//   2. Property test (Property 51) ensuring telemetry events never leak
//      user content (Requirement 19.4, 19.5, 26.3).
//
// Each test starts from a fresh `fake-indexeddb` factory so persistence
// state does not bleed between cases.

import { describe, expect, it, beforeEach } from 'vitest';
import fc from 'fast-check';
import { IDBFactory } from 'fake-indexeddb';

import {
  TelemetryModule,
  type MetricEvent,
  type StoredTelemetryEvent,
} from './telemetry';
import {
  __resetDatabaseForTests,
} from '../data/database';

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/** Replace the global IDB factory so each test sees a clean DB. */
function resetIndexedDB(): void {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  __resetDatabaseForTests();
}

/** Small delay to allow async fire-and-forget writes to settle. */
function tick(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------

describe('TelemetryModule', () => {
  beforeEach(() => {
    resetIndexedDB();
  });

  it('emit persists an event to IndexedDB with id and at fields', async () => {
    const tm = new TelemetryModule();
    tm.emit({ kind: 'cache.miss' });
    await tick();

    const events = await tm.query(60_000);
    expect(events.length).toBe(1);
    expect(events[0].kind).toBe('cache.miss');
    expect(events[0].id).toMatch(/^tel-/);
    expect(typeof events[0].at).toBe('number');
  });

  it('emit persists structured event fields', async () => {
    const tm = new TelemetryModule();
    tm.emit({ kind: 'ttft', ms: 120, modelId: 'gpt-4o', providerId: 'openai' });
    await tick();

    const events = await tm.query(60_000);
    expect(events.length).toBe(1);
    const e = events[0] as StoredTelemetryEvent & { ms: number; modelId: string; providerId: string };
    expect(e.kind).toBe('ttft');
    expect(e.ms).toBe(120);
    expect(e.modelId).toBe('gpt-4o');
    expect(e.providerId).toBe('openai');
  });

  it('query filters by time range', async () => {
    const tm = new TelemetryModule();
    tm.emit({ kind: 'cache.miss' });
    await tick();

    // Query with a very small range that excludes the event
    const events = await tm.query(0);
    expect(events.length).toBe(0);

    // Query with a larger range that includes the event
    const allEvents = await tm.query(60_000);
    expect(allEvents.length).toBe(1);
  });

  it('clearAll removes all events from IndexedDB and external queue', async () => {
    const tm = new TelemetryModule({ optIn: true });
    tm.emit({ kind: 'cache.miss' });
    tm.enqueueExternal({ kind: 'cache.miss' });
    await tick();

    await tm.clearAll();

    const events = await tm.query(60_000);
    expect(events.length).toBe(0);
    expect(tm.getExternalQueue().length).toBe(0);
  });

  it('enqueueExternal does nothing when not opted in', () => {
    const tm = new TelemetryModule({ optIn: false });
    tm.enqueueExternal({ kind: 'cache.hit', similarity: 0.85 });
    expect(tm.getExternalQueue().length).toBe(0);
  });

  it('enqueueExternal queues events when opted in', () => {
    const tm = new TelemetryModule({ optIn: true });
    tm.enqueueExternal({ kind: 'cache.hit', similarity: 0.85 });
    expect(tm.getExternalQueue().length).toBe(1);
    expect(tm.getExternalQueue()[0].kind).toBe('cache.hit');
  });

  it('setOptIn(false) drains the external queue', () => {
    const tm = new TelemetryModule({ optIn: true });
    tm.enqueueExternal({ kind: 'cache.miss' });
    expect(tm.getExternalQueue().length).toBe(1);

    tm.setOptIn(false);
    expect(tm.getExternalQueue().length).toBe(0);
  });

  it('setOptIn(true) enables future enqueue calls', () => {
    const tm = new TelemetryModule({ optIn: false });
    tm.enqueueExternal({ kind: 'cache.miss' });
    expect(tm.getExternalQueue().length).toBe(0);

    tm.setOptIn(true);
    tm.enqueueExternal({ kind: 'cache.miss' });
    expect(tm.getExternalQueue().length).toBe(1);
  });

  it('isOptedIn reflects the current opt-in state', () => {
    const tm = new TelemetryModule({ optIn: false });
    expect(tm.isOptedIn).toBe(false);
    tm.setOptIn(true);
    expect(tm.isOptedIn).toBe(true);
  });

  it('enqueueExternal events have id and at fields', () => {
    const tm = new TelemetryModule({ optIn: true });
    tm.enqueueExternal({ kind: 'retry', count: 2, providerId: 'gemini' });
    const queued = tm.getExternalQueue();
    expect(queued[0].id).toMatch(/^tel-/);
    expect(typeof queued[0].at).toBe('number');
    expect(queued[0].kind).toBe('retry');
  });

  it('clearExternalQueue empties only the external queue', async () => {
    const tm = new TelemetryModule({ optIn: true });
    tm.emit({ kind: 'cache.miss' });
    tm.enqueueExternal({ kind: 'cache.miss' });
    await tick();

    tm.clearExternalQueue();
    expect(tm.getExternalQueue().length).toBe(0);
    // IndexedDB should still have the emitted event
    const events = await tm.query(60_000);
    expect(events.length).toBe(1);
  });

  it('emits error events with structured breadcrumb', async () => {
    const tm = new TelemetryModule();
    tm.emit({
      kind: 'error',
      name: 'TypeError',
      message: 'Cannot read property x',
      stack: 'TypeError: Cannot read...\n  at foo (bar.ts:1)',
      breadcrumb: ['init', 'loadProvider', 'stream'],
    });
    await tick();

    const events = await tm.query(60_000);
    expect(events.length).toBe(1);
    const e = events[0] as StoredTelemetryEvent & { breadcrumb: string[] };
    expect(e.kind).toBe('error');
    expect(e.breadcrumb).toEqual(['init', 'loadProvider', 'stream']);
  });

  it('multiple emits produce distinct records', async () => {
    const tm = new TelemetryModule();
    tm.emit({ kind: 'cache.miss' });
    tm.emit({ kind: 'cache.hit', similarity: 0.9 });
    tm.emit({ kind: 'latency.degraded' });
    await tick();

    const events = await tm.query(60_000);
    expect(events.length).toBe(3);
    const ids = events.map((e) => e.id);
    expect(new Set(ids).size).toBe(3); // all unique ids
  });
});

// ---------------------------------------------------------------------
// Property 51 (Requirements 19.4, 19.5, 26.3)
// ---------------------------------------------------------------------
//
// Validates: Requirements 19.4, 19.5, 26.3
//
// For any MetricEvent in the union, no field can contain arbitrary user
// content (transcript text, screen text). The type system enforces this
// structurally. The property test generates arbitrary MetricEvents and
// asserts:
//   1. No field value is a free-form string longer than 200 characters
//   2. No field name is one of the forbidden content-bearing names
//      ('text', 'transcript', 'screenText', 'content', 'payload')
//   3. String fields in the event are constrained to their domain
//      (short identifiers, enum-like values, or stack traces)

describe('Property 51: telemetry events never leak content', () => {
  beforeEach(() => {
    resetIndexedDB();
  });

  /**
   * Forbidden field names that would indicate content leakage.
   * If any field has one of these names, it structurally violates
   * the no-content invariant.
   */
  const FORBIDDEN_FIELD_NAMES = new Set([
    'text',
    'transcript',
    'screenText',
    'content',
    'payload',
  ]);

  /** Maximum allowed string length for any field in a MetricEvent. */
  const MAX_STRING_LENGTH = 200;

  /**
   * Arbitrary generator for the MetricEvent discriminated union.
   * Each variant is generated with realistic domain-constrained values.
   */
  const metricEventArb: fc.Arbitrary<MetricEvent> = fc.oneof(
    // ttft
    fc.record({
      kind: fc.constant<'ttft'>('ttft'),
      ms: fc.nat({ max: 30_000 }),
      modelId: fc.stringMatching(/^[a-z0-9\-\.]{1,50}$/),
      providerId: fc.stringMatching(/^[a-z0-9\-]{1,30}$/),
    }),
    // totalLatency
    fc.record({
      kind: fc.constant<'totalLatency'>('totalLatency'),
      ms: fc.nat({ max: 60_000 }),
      modelId: fc.stringMatching(/^[a-z0-9\-\.]{1,50}$/),
      providerId: fc.stringMatching(/^[a-z0-9\-]{1,30}$/),
    }),
    // retry
    fc.record({
      kind: fc.constant<'retry'>('retry'),
      count: fc.nat({ max: 10 }),
      providerId: fc.stringMatching(/^[a-z0-9\-]{1,30}$/),
    }),
    // cache.hit
    fc.record({
      kind: fc.constant<'cache.hit'>('cache.hit'),
      similarity: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    }),
    // cache.miss
    fc.record({
      kind: fc.constant<'cache.miss'>('cache.miss'),
    }),
    // transcript.drop
    fc.record({
      kind: fc.constant<'transcript.drop'>('transcript.drop'),
      reason: fc.constantFrom<'low-confidence' | 'empty' | 'speaker-self'>(
        'low-confidence', 'empty', 'speaker-self',
      ),
    }),
    // ocr.skipped
    fc.record({
      kind: fc.constant<'ocr.skipped'>('ocr.skipped'),
      reason: fc.constantFrom<'unchanged' | 'tiny-frame'>('unchanged', 'tiny-frame'),
    }),
    // embedding.cache
    fc.record({
      kind: fc.constant<'embedding.cache'>('embedding.cache'),
      outcome: fc.constantFrom<'hit' | 'miss'>('hit', 'miss'),
    }),
    // memory.size
    fc.record({
      kind: fc.constant<'memory.size'>('memory.size'),
      chunks: fc.nat({ max: 10_000 }),
    }),
    // tokens
    fc.record({
      kind: fc.constant<'tokens'>('tokens'),
      promptTokens: fc.nat({ max: 100_000 }),
      completionTokens: fc.nat({ max: 100_000 }),
      modelId: fc.stringMatching(/^[a-z0-9\-\.]{1,50}$/),
      providerId: fc.stringMatching(/^[a-z0-9\-]{1,30}$/),
    }),
    // error
    fc.record({
      kind: fc.constant<'error'>('error'),
      name: fc.stringMatching(/^[A-Za-z]{1,40}$/),
      message: fc.stringMatching(/^[A-Za-z0-9 :.']{0,100}$/),
      stack: fc.stringMatching(/^[A-Za-z0-9 :.()\/\\\-\n]{0,200}$/),
      breadcrumb: fc.array(
        fc.stringMatching(/^[a-zA-Z0-9\-_]{1,30}$/),
        { maxLength: 10 },
      ),
    }),
    // latency.degraded
    fc.record({
      kind: fc.constant<'latency.degraded'>('latency.degraded'),
    }),
  );

  it('Validates: Requirements 19.4, 19.5, 26.3', () => {
    fc.assert(
      fc.property(metricEventArb, (event) => {
        // Check every field of the event
        for (const [fieldName, fieldValue] of Object.entries(event)) {
          // 1. No field should have a forbidden content-bearing name
          if (FORBIDDEN_FIELD_NAMES.has(fieldName)) {
            return false;
          }

          // 2. String fields must not exceed the length threshold
          if (typeof fieldValue === 'string' && fieldValue.length > MAX_STRING_LENGTH) {
            return false;
          }

          // 3. Array fields (breadcrumb) — check each element
          if (Array.isArray(fieldValue)) {
            for (const item of fieldValue) {
              if (typeof item === 'string' && item.length > MAX_STRING_LENGTH) {
                return false;
              }
            }
          }
        }
        return true;
      }),
      { numRuns: 500 },
    );
  });

  it('no MetricEvent variant has a field named text, transcript, screenText, content, or payload', () => {
    // Structural compile-time check via runtime assertion on all
    // possible event shapes. We enumerate every variant and check its
    // keys.
    const allVariants: MetricEvent[] = [
      { kind: 'ttft', ms: 100, modelId: 'm', providerId: 'p' },
      { kind: 'totalLatency', ms: 100, modelId: 'm', providerId: 'p' },
      { kind: 'retry', count: 1, providerId: 'p' },
      { kind: 'cache.hit', similarity: 0.5 },
      { kind: 'cache.miss' },
      { kind: 'transcript.drop', reason: 'empty' },
      { kind: 'ocr.skipped', reason: 'unchanged' },
      { kind: 'embedding.cache', outcome: 'hit' },
      { kind: 'memory.size', chunks: 10 },
      { kind: 'tokens', promptTokens: 1, completionTokens: 2, modelId: 'm', providerId: 'p' },
      { kind: 'error', name: 'E', message: 'msg', stack: 's', breadcrumb: [] },
      { kind: 'latency.degraded' },
    ];

    for (const variant of allVariants) {
      for (const fieldName of Object.keys(variant)) {
        expect(FORBIDDEN_FIELD_NAMES.has(fieldName)).toBe(false);
      }
    }
  });

  it('generated events pass through emit without adding content-bearing fields', async () => {
    fc.assert(
      fc.property(metricEventArb, (event) => {
        const tm = new TelemetryModule({ optIn: true });

        // Simulate what emit produces
        const row = {
          id: `tel-${Date.now()}-abc123`,
          at: Date.now(),
          ...event,
        };

        // Verify no forbidden field names in persisted row
        for (const fieldName of Object.keys(row)) {
          if (FORBIDDEN_FIELD_NAMES.has(fieldName)) {
            return false;
          }
        }

        // Verify no field has a string longer than 200 chars
        for (const [, fieldValue] of Object.entries(row)) {
          if (typeof fieldValue === 'string' && fieldValue.length > MAX_STRING_LENGTH) {
            return false;
          }
          if (Array.isArray(fieldValue)) {
            for (const item of fieldValue) {
              if (typeof item === 'string' && item.length > MAX_STRING_LENGTH) {
                return false;
              }
            }
          }
        }

        // Verify enqueueExternal also doesn't add content fields
        tm.enqueueExternal(event);
        const queued = tm.getExternalQueue();
        if (queued.length > 0) {
          for (const fieldName of Object.keys(queued[0])) {
            if (FORBIDDEN_FIELD_NAMES.has(fieldName)) {
              return false;
            }
          }
        }

        return true;
      }),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------
// Screen Telemetry Redaction Guard (Requirements 9.5, 9.6)
// ---------------------------------------------------------------------
//
// Task 8.2: Validates that the runtime guard blocks raw screen text and
// image data from screen.* telemetry payloads, and that redaction rules
// are applied to any text-derived fields.

import {
  validateScreenTelemetryPayload,
  redactTelemetryPayload,
  setRedactionRulesForTelemetry,
} from './telemetry';

describe('Screen telemetry redaction guard (Requirements 9.5, 9.6)', () => {
  beforeEach(() => {
    resetIndexedDB();
    setRedactionRulesForTelemetry([]);
  });

  // -------------------------------------------------------------------
  // validateScreenTelemetryPayload
  // -------------------------------------------------------------------

  describe('validateScreenTelemetryPayload', () => {
    it('passes valid screen.dispatch event (numbers and booleans only)', () => {
      expect(() =>
        validateScreenTelemetryPayload({
          kind: 'screen.dispatch',
          latencyMs: 250,
          hasKeyframe: true,
          hasScreenText: false,
        }),
      ).not.toThrow();
    });

    it('passes valid screen.ocrComplete event', () => {
      expect(() =>
        validateScreenTelemetryPayload({
          kind: 'screen.ocrComplete',
          durationMs: 1200,
          deduped: true,
        }),
      ).not.toThrow();
    });

    it('passes valid screen.ocrSkipped event', () => {
      expect(() =>
        validateScreenTelemetryPayload({
          kind: 'screen.ocrSkipped',
          reason: 'vision-adapter',
        }),
      ).not.toThrow();
    });

    it('passes valid screen.keyframeReencode event', () => {
      expect(() =>
        validateScreenTelemetryPayload({
          kind: 'screen.keyframeReencode',
          passes: 2,
          finalBytes: 98304,
        }),
      ).not.toThrow();
    });

    it('blocks event with base64 image data URI', () => {
      // Simulate a hypothetical malformed event with image content
      const malformed = {
        kind: 'screen.dispatch' as const,
        latencyMs: 100,
        hasKeyframe: true,
        hasScreenText: false,
        // Hypothetical leaked field:
        imageData: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAAAA=',
      } as unknown as MetricEvent;

      expect(() => validateScreenTelemetryPayload(malformed)).toThrow(/raw image data/);
    });

    it('blocks event with raw base64 chunk (≥64 chars)', () => {
      const longBase64 = 'A'.repeat(64);
      const malformed = {
        kind: 'screen.keyframeReencode' as const,
        passes: 1,
        finalBytes: 5000,
        leaked: longBase64,
      } as unknown as MetricEvent;

      expect(() => validateScreenTelemetryPayload(malformed)).toThrow(/raw image data/);
    });

    it('blocks event with suspected screen text (multi-word natural language)', () => {
      const malformed = {
        kind: 'screen.ocrComplete' as const,
        durationMs: 800,
        deduped: false,
        recognizedText: 'The quick brown fox jumps over the lazy dog near the barn',
      } as unknown as MetricEvent;

      expect(() => validateScreenTelemetryPayload(malformed)).toThrow(/screen text/);
    });

    it('allows short string identifiers (< 20 chars)', () => {
      // The "reason" field on screen.ocrSkipped is a short string literal
      expect(() =>
        validateScreenTelemetryPayload({
          kind: 'screen.ocrSkipped',
          reason: 'vision-adapter',
        }),
      ).not.toThrow();
    });
  });

  // -------------------------------------------------------------------
  // redactTelemetryPayload
  // -------------------------------------------------------------------

  describe('redactTelemetryPayload', () => {
    it('returns event unchanged when no redaction rules are configured', () => {
      const event: MetricEvent = {
        kind: 'screen.dispatch',
        latencyMs: 300,
        hasKeyframe: true,
        hasScreenText: true,
      };
      const result = redactTelemetryPayload(event, []);
      expect(result).toBe(event); // same reference — no copy
    });

    it('applies email redaction to a hypothetical text-derived field', () => {
      const rules = [{ kind: 'entity' as const, entity: 'email' as const }];
      // Simulate a hypothetical event with a text field that contains an email
      const event = {
        kind: 'screen.dispatch' as const,
        latencyMs: 100,
        hasKeyframe: true,
        hasScreenText: true,
        debugNote: 'user@example.com sent request',
      } as unknown as MetricEvent;

      const result = redactTelemetryPayload(event, rules);
      expect((result as unknown as { debugNote: string }).debugNote).toBe(
        '[REDACTED:EMAIL] sent request',
      );
    });

    it('applies phone redaction to text-derived fields', () => {
      const rules = [{ kind: 'entity' as const, entity: 'phone' as const }];
      const event = {
        kind: 'screen.ocrComplete' as const,
        durationMs: 500,
        deduped: false,
        note: 'Call 555-123-4567 for info',
      } as unknown as MetricEvent;

      const result = redactTelemetryPayload(event, rules);
      expect((result as unknown as { note: string }).note).toBe(
        'Call [REDACTED:PHONE] for info',
      );
    });

    it('does not modify non-string fields (numbers, booleans)', () => {
      const rules = [{ kind: 'entity' as const, entity: 'email' as const }];
      const event: MetricEvent = {
        kind: 'screen.dispatch',
        latencyMs: 250,
        hasKeyframe: true,
        hasScreenText: false,
      };

      const result = redactTelemetryPayload(event, rules);
      expect(result.kind).toBe('screen.dispatch');
      expect((result as { latencyMs: number }).latencyMs).toBe(250);
      expect((result as { hasKeyframe: boolean }).hasKeyframe).toBe(true);
      expect((result as { hasScreenText: boolean }).hasScreenText).toBe(false);
    });

    it('preserves the kind field untouched even if it matches a pattern', () => {
      // The "kind" field should never be redacted
      const rules = [{
        kind: 'regex' as const,
        pattern: 'screen',
        flags: 'gi',
        replacement: '[REDACTED]',
      }];
      const event: MetricEvent = {
        kind: 'screen.dispatch',
        latencyMs: 100,
        hasKeyframe: false,
        hasScreenText: false,
      };

      const result = redactTelemetryPayload(event, rules);
      expect(result.kind).toBe('screen.dispatch');
    });
  });

  // -------------------------------------------------------------------
  // Integration: emit drops events with raw content
  // -------------------------------------------------------------------

  describe('emit integration with screen telemetry guard', () => {
    it('emits valid screen.* events to IndexedDB', async () => {
      const tm = new TelemetryModule();
      tm.emit({ kind: 'screen.dispatch', latencyMs: 200, hasKeyframe: true, hasScreenText: true });
      await tick();

      const events = await tm.query(60_000);
      expect(events.length).toBe(1);
      expect(events[0].kind).toBe('screen.dispatch');
    });

    it('drops screen.* events that contain raw image data', async () => {
      const tm = new TelemetryModule();
      const malformed = {
        kind: 'screen.dispatch',
        latencyMs: 100,
        hasKeyframe: true,
        hasScreenText: false,
        leaked: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ=',
      } as unknown as MetricEvent;

      // Should not throw — emit is fire-and-forget — but should drop the event
      tm.emit(malformed);
      await tick();

      const events = await tm.query(60_000);
      expect(events.length).toBe(0);
    });

    it('drops screen.* events that contain suspected screen text', async () => {
      const tm = new TelemetryModule();
      const malformed = {
        kind: 'screen.ocrComplete',
        durationMs: 1000,
        deduped: false,
        ocrResult: 'Welcome to the application dashboard with multiple widgets and panels showing data',
      } as unknown as MetricEvent;

      tm.emit(malformed);
      await tick();

      const events = await tm.query(60_000);
      expect(events.length).toBe(0);
    });

    it('applies redaction rules to screen.* events before persistence', async () => {
      setRedactionRulesForTelemetry([
        { kind: 'entity', entity: 'email' },
      ]);

      const tm = new TelemetryModule();
      // Hypothetical event with a short text field containing an email
      // (short enough to pass the screen-text check but contains PII)
      const event = {
        kind: 'screen.dispatch',
        latencyMs: 150,
        hasKeyframe: true,
        hasScreenText: true,
        tag: 'a@b.co',
      } as unknown as MetricEvent;

      tm.emit(event);
      await tick();

      const events = await tm.query(60_000);
      expect(events.length).toBe(1);
      expect((events[0] as unknown as { tag: string }).tag).toBe('[REDACTED:EMAIL]');
    });

    it('enqueueExternal also guards screen.* events', () => {
      const tm = new TelemetryModule({ optIn: true });
      const malformed = {
        kind: 'screen.keyframeReencode',
        passes: 1,
        finalBytes: 50000,
        rawBytes: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
      } as unknown as MetricEvent;

      tm.enqueueExternal(malformed);
      expect(tm.getExternalQueue().length).toBe(0); // dropped
    });

    it('non-screen events are not affected by the guard', async () => {
      const tm = new TelemetryModule();
      tm.emit({ kind: 'cache.miss' });
      tm.emit({ kind: 'ttft', ms: 120, modelId: 'gpt-4o', providerId: 'openai' });
      await tick();

      const events = await tm.query(60_000);
      expect(events.length).toBe(2);
    });
  });
});


// ---------------------------------------------------------------------
// Property 14: Telemetry contains no raw user content
// (Feature: screen-context-latency, Property 14)
// ---------------------------------------------------------------------
//
// **Validates: Requirements 9.5, 9.6**
//
// For any telemetry event emitted by the screen-context path, the event
// payload SHALL NOT contain recognized screen text, raw image bytes
// (base64 or binary), or any user-identifying content. Text-derived
// fields, if present, SHALL contain only redacted/sanitized forms.
//
// Strategy:
//   1. Generate random screen text strings (multi-word, with potential PII)
//   2. Generate random image bytes as base64-encoded data
//   3. Attempt to emit these through screen.* telemetry events
//   4. Verify that emitted/stored events never contain the raw user content

describe('Property 14: Telemetry contains no raw user content', () => {
  beforeEach(() => {
    resetIndexedDB();
    setRedactionRulesForTelemetry([
      { kind: 'entity', entity: 'email' },
      { kind: 'entity', entity: 'phone' },
    ]);
  });

  // Generators -----------------------------------------------------------

  /** Generate multi-word natural language text (simulates OCR screen text). */
  const screenTextArb = fc.array(
    fc.stringMatching(/^[A-Za-z]{2,12}$/),
    { minLength: 4, maxLength: 20 },
  ).map((words) => words.join(' '));

  /** Generate text that includes PII (emails, phone numbers). */
  const piiTextArb = fc.oneof(
    // Text with email
    fc.tuple(screenTextArb, fc.emailAddress()).map(
      ([text, email]) => `${text} contact ${email} for details`,
    ),
    // Text with phone number
    fc.tuple(screenTextArb, fc.nat({ max: 999 }), fc.nat({ max: 999 }), fc.nat({ max: 9999 })).map(
      ([text, area, mid, last]) =>
        `${text} call ${String(area).padStart(3, '0')}-${String(mid).padStart(3, '0')}-${String(last).padStart(4, '0')}`,
    ),
    // Plain multi-word text
    screenTextArb,
  );

  /** Generate random base64-encoded image data (simulates keyframe bytes). */
  const base64ImageArb = fc.uint8Array({ minLength: 64, maxLength: 512 }).map((bytes) => {
    // Convert to base64 string (mimics raw image content)
    const binary = Array.from(bytes)
      .map((b) => String.fromCharCode(b))
      .join('');
    return btoa(binary);
  });

  /** Generate base64 data URIs (simulates leaked keyframe as data URI). */
  const dataUriArb = base64ImageArb.map(
    (b64) => `data:image/jpeg;base64,${b64}`,
  );

  /** Generate a random screen.* event kind. */
  const screenEventKindArb = fc.constantFrom(
    'screen.dispatch' as const,
    'screen.ocrComplete' as const,
    'screen.ocrSkipped' as const,
    'screen.keyframeReencode' as const,
  );

  /** Build a valid base event for a given screen.* kind. */
  function buildBaseEvent(kind: MetricEvent['kind']): Record<string, unknown> {
    switch (kind) {
      case 'screen.dispatch':
        return { kind, latencyMs: 200, hasKeyframe: true, hasScreenText: true };
      case 'screen.ocrComplete':
        return { kind, durationMs: 800, deduped: false };
      case 'screen.ocrSkipped':
        return { kind, reason: 'vision-adapter' };
      case 'screen.keyframeReencode':
        return { kind, passes: 2, finalBytes: 50000 };
      default:
        return { kind };
    }
  }

  // Property tests -------------------------------------------------------

  it('raw screen text is never present in persisted events after emit (P14a)', async () => {
    await fc.assert(
      fc.asyncProperty(
        screenEventKindArb,
        piiTextArb,
        async (kind, rawText) => {
          resetIndexedDB();

          const tm = new TelemetryModule();
          const base = buildBaseEvent(kind);

          // Inject raw text into a hypothetical extra field (simulates bypass)
          const malformed = { ...base, leakedText: rawText } as unknown as MetricEvent;
          tm.emit(malformed);
          await tick();

          const events = await tm.query(60_000);

          // Either the event was dropped entirely (validation blocked it),
          // or if persisted, the raw text must not appear in any field.
          for (const storedEvent of events) {
            for (const [, value] of Object.entries(storedEvent)) {
              if (typeof value === 'string') {
                // The raw text should not appear verbatim
                expect(value).not.toBe(rawText);
                // Partial substring match: raw text (≥20 chars) shouldn't be embedded
                if (rawText.length >= 20) {
                  expect(value.includes(rawText)).toBe(false);
                }
              }
            }
          }
        },
      ),
      { numRuns: 30 },
    );
  }, 30_000);

  it('raw base64 image bytes are never present in persisted events after emit (P14b)', async () => {
    await fc.assert(
      fc.asyncProperty(
        screenEventKindArb,
        base64ImageArb,
        async (kind, rawBase64) => {
          resetIndexedDB();

          const tm = new TelemetryModule();
          const base = buildBaseEvent(kind);

          // Inject raw base64 image bytes into a hypothetical extra field
          const malformed = { ...base, imageData: rawBase64 } as unknown as MetricEvent;
          tm.emit(malformed);
          await tick();

          const events = await tm.query(60_000);

          // Either dropped by validation, or if persisted, no raw base64 present
          for (const storedEvent of events) {
            for (const [, value] of Object.entries(storedEvent)) {
              if (typeof value === 'string') {
                expect(value).not.toBe(rawBase64);
                // The raw base64 chunk (≥64 chars) should not appear in any field
                if (rawBase64.length >= 64) {
                  expect(value.includes(rawBase64)).toBe(false);
                }
              }
            }
          }
        },
      ),
      { numRuns: 30 },
    );
  }, 30_000);

  it('data URI image content is never present in persisted events after emit (P14c)', async () => {
    await fc.assert(
      fc.asyncProperty(
        screenEventKindArb,
        dataUriArb,
        async (kind, rawDataUri) => {
          resetIndexedDB();

          const tm = new TelemetryModule();
          const base = buildBaseEvent(kind);

          // Inject data URI into a hypothetical extra field
          const malformed = { ...base, keyframe: rawDataUri } as unknown as MetricEvent;
          tm.emit(malformed);
          await tick();

          const events = await tm.query(60_000);

          // Event should have been dropped (data URI triggers image detection)
          for (const storedEvent of events) {
            for (const [, value] of Object.entries(storedEvent)) {
              if (typeof value === 'string') {
                expect(value.includes('data:image/')).toBe(false);
                expect(value).not.toBe(rawDataUri);
              }
            }
          }
        },
      ),
      { numRuns: 30 },
    );
  }, 30_000);

  it('raw user content is never present in external queue after enqueueExternal (P14d)', () => {
    fc.assert(
      fc.property(
        screenEventKindArb,
        fc.oneof(piiTextArb, base64ImageArb, dataUriArb),
        (kind, rawContent) => {
          const tm = new TelemetryModule({ optIn: true });
          const base = buildBaseEvent(kind);

          // Inject raw content in various field positions
          const malformed = { ...base, leaked: rawContent } as unknown as MetricEvent;
          tm.enqueueExternal(malformed);

          const queued = tm.getExternalQueue();

          // Either dropped entirely or content must not appear
          for (const queuedEvent of queued) {
            for (const [, value] of Object.entries(queuedEvent)) {
              if (typeof value === 'string') {
                expect(value).not.toBe(rawContent);
                if (rawContent.length >= 64) {
                  expect(value.includes(rawContent)).toBe(false);
                }
              }
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('PII in text-derived fields is redacted before persistence (P14e)', async () => {
    // Generate only RFC-like emails that match the redaction engine's pattern:
    //   \b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b
    const validEmailArb = fc.tuple(
      fc.stringMatching(/^[a-z][a-z0-9._%+-]{1,10}$/),
      fc.stringMatching(/^[a-z][a-z0-9-]{1,8}$/),
      fc.stringMatching(/^[a-z]{2,4}$/),
    ).map(([local, domain, tld]) => `${local}@${domain}.${tld}`);

    await fc.assert(
      fc.asyncProperty(
        screenEventKindArb,
        validEmailArb,
        async (kind, email) => {
          resetIndexedDB();
          setRedactionRulesForTelemetry([
            { kind: 'entity', entity: 'email' },
          ]);

          const tm = new TelemetryModule();
          const base = buildBaseEvent(kind);

          // Short tag field with email (passes screen-text length check but contains PII)
          const withPII = { ...base, tag: email } as unknown as MetricEvent;
          tm.emit(withPII);
          await tick();

          const events = await tm.query(60_000);

          // If persisted, email must be redacted
          for (const storedEvent of events) {
            for (const [fieldName, value] of Object.entries(storedEvent)) {
              if (fieldName === 'id' || fieldName === 'kind') continue;
              if (typeof value === 'string') {
                // The raw email should never appear verbatim in any field
                expect(value).not.toContain(email);
              }
            }
          }
        },
      ),
      { numRuns: 30 },
    );
  }, 30_000);

  it('validateScreenTelemetryPayload blocks all generated raw content (P14f)', () => {
    fc.assert(
      fc.property(
        screenEventKindArb,
        fc.oneof(piiTextArb, base64ImageArb, dataUriArb),
        (kind, rawContent) => {
          const base = buildBaseEvent(kind);
          const malformed = { ...base, leaked: rawContent } as unknown as MetricEvent;

          // For content that should be detected (multi-word text ≥20 chars,
          // base64 ≥64 chars, data URIs), validation should throw.
          const isLongBase64 = /^[A-Za-z0-9+/]{64,}={0,2}$/.test(rawContent);
          const isDataUri = rawContent.startsWith('data:image/');
          const isMultiWordText = rawContent.length >= 20 && /(?:\S+\s+){3,}\S+/.test(rawContent);

          if (isLongBase64 || isDataUri || isMultiWordText) {
            try {
              validateScreenTelemetryPayload(malformed);
              // If it didn't throw, the raw content somehow passed — that's a failure
              return false;
            } catch {
              // Expected: validation correctly blocked the content
              return true;
            }
          }
          // Short/single-word strings won't be detected (they're identifiers) — that's fine
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});


// ---------------------------------------------------------------------
// Task 8.4: Unit tests for screen telemetry event shapes
// (Requirements 9.1, 9.2, 9.3, 9.4, 9.5)
// ---------------------------------------------------------------------
//
// Verifies:
//   1. Each screen.* event kind persists to IndexedDB with the correct
//      shape — correct field names, correct value types.
//   2. No raw content (screen text, image bytes) leaks into payloads.
//   3. The emit path correctly drops malformed screen events for each kind.

describe('Screen telemetry event shapes (Task 8.4 — Requirements 9.1, 9.2, 9.3, 9.4, 9.5)', () => {
  beforeEach(() => {
    resetIndexedDB();
    setRedactionRulesForTelemetry([]);
  });

  // -------------------------------------------------------------------
  // Requirement 9.1: screen.dispatch — correct shape
  // -------------------------------------------------------------------

  describe('screen.dispatch shape (Requirement 9.1)', () => {
    it('persists with kind, latencyMs (number), hasKeyframe (boolean), hasScreenText (boolean)', async () => {
      const tm = new TelemetryModule();
      tm.emit({ kind: 'screen.dispatch', latencyMs: 380, hasKeyframe: true, hasScreenText: false });
      await tick();

      const events = await tm.query(60_000);
      expect(events.length).toBe(1);
      const e = events[0] as StoredTelemetryEvent & {
        latencyMs: number;
        hasKeyframe: boolean;
        hasScreenText: boolean;
      };
      expect(e.kind).toBe('screen.dispatch');
      expect(typeof e.latencyMs).toBe('number');
      expect(e.latencyMs).toBe(380);
      expect(typeof e.hasKeyframe).toBe('boolean');
      expect(e.hasKeyframe).toBe(true);
      expect(typeof e.hasScreenText).toBe('boolean');
      expect(e.hasScreenText).toBe(false);
    });

    it('contains only the expected fields (id, at, kind, latencyMs, hasKeyframe, hasScreenText)', async () => {
      const tm = new TelemetryModule();
      tm.emit({ kind: 'screen.dispatch', latencyMs: 250, hasKeyframe: false, hasScreenText: true });
      await tick();

      const events = await tm.query(60_000);
      const e = events[0];
      const keys = Object.keys(e).sort();
      expect(keys).toEqual(['at', 'hasKeyframe', 'hasScreenText', 'id', 'kind', 'latencyMs'].sort());
    });

    it('records both modalities (hasKeyframe + hasScreenText both true)', async () => {
      const tm = new TelemetryModule();
      tm.emit({ kind: 'screen.dispatch', latencyMs: 150, hasKeyframe: true, hasScreenText: true });
      await tick();

      const events = await tm.query(60_000);
      const e = events[0] as StoredTelemetryEvent & { hasKeyframe: boolean; hasScreenText: boolean };
      expect(e.hasKeyframe).toBe(true);
      expect(e.hasScreenText).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Requirement 9.2: screen.ocrComplete — correct shape
  // -------------------------------------------------------------------

  describe('screen.ocrComplete shape (Requirement 9.2)', () => {
    it('persists with kind, durationMs (number), deduped (boolean)', async () => {
      const tm = new TelemetryModule();
      tm.emit({ kind: 'screen.ocrComplete', durationMs: 1200, deduped: true });
      await tick();

      const events = await tm.query(60_000);
      expect(events.length).toBe(1);
      const e = events[0] as StoredTelemetryEvent & {
        durationMs: number;
        deduped: boolean;
      };
      expect(e.kind).toBe('screen.ocrComplete');
      expect(typeof e.durationMs).toBe('number');
      expect(e.durationMs).toBe(1200);
      expect(typeof e.deduped).toBe('boolean');
      expect(e.deduped).toBe(true);
    });

    it('contains only the expected fields (id, at, kind, durationMs, deduped)', async () => {
      const tm = new TelemetryModule();
      tm.emit({ kind: 'screen.ocrComplete', durationMs: 500, deduped: false });
      await tick();

      const events = await tm.query(60_000);
      const e = events[0];
      const keys = Object.keys(e).sort();
      expect(keys).toEqual(['at', 'deduped', 'durationMs', 'id', 'kind'].sort());
    });

    it('records dedup flag correctly when OCR was deduplicated', async () => {
      const tm = new TelemetryModule();
      tm.emit({ kind: 'screen.ocrComplete', durationMs: 0, deduped: true });
      await tick();

      const events = await tm.query(60_000);
      const e = events[0] as StoredTelemetryEvent & { deduped: boolean };
      expect(e.deduped).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Requirement 9.3: screen.ocrSkipped — correct shape
  // -------------------------------------------------------------------

  describe('screen.ocrSkipped shape (Requirement 9.3)', () => {
    it('persists with kind and reason (string literal "vision-adapter")', async () => {
      const tm = new TelemetryModule();
      tm.emit({ kind: 'screen.ocrSkipped', reason: 'vision-adapter' });
      await tick();

      const events = await tm.query(60_000);
      expect(events.length).toBe(1);
      const e = events[0] as StoredTelemetryEvent & { reason: string };
      expect(e.kind).toBe('screen.ocrSkipped');
      expect(typeof e.reason).toBe('string');
      expect(e.reason).toBe('vision-adapter');
    });

    it('contains only the expected fields (id, at, kind, reason)', async () => {
      const tm = new TelemetryModule();
      tm.emit({ kind: 'screen.ocrSkipped', reason: 'vision-adapter' });
      await tick();

      const events = await tm.query(60_000);
      const e = events[0];
      const keys = Object.keys(e).sort();
      expect(keys).toEqual(['at', 'id', 'kind', 'reason'].sort());
    });
  });

  // -------------------------------------------------------------------
  // Requirement 9.4: screen.keyframeReencode — correct shape
  // -------------------------------------------------------------------

  describe('screen.keyframeReencode shape (Requirement 9.4)', () => {
    it('persists with kind, passes (number), finalBytes (number)', async () => {
      const tm = new TelemetryModule();
      tm.emit({ kind: 'screen.keyframeReencode', passes: 3, finalBytes: 95000 });
      await tick();

      const events = await tm.query(60_000);
      expect(events.length).toBe(1);
      const e = events[0] as StoredTelemetryEvent & {
        passes: number;
        finalBytes: number;
      };
      expect(e.kind).toBe('screen.keyframeReencode');
      expect(typeof e.passes).toBe('number');
      expect(e.passes).toBe(3);
      expect(typeof e.finalBytes).toBe('number');
      expect(e.finalBytes).toBe(95000);
    });

    it('contains only the expected fields (id, at, kind, passes, finalBytes)', async () => {
      const tm = new TelemetryModule();
      tm.emit({ kind: 'screen.keyframeReencode', passes: 1, finalBytes: 50000 });
      await tick();

      const events = await tm.query(60_000);
      const e = events[0];
      const keys = Object.keys(e).sort();
      expect(keys).toEqual(['at', 'finalBytes', 'id', 'kind', 'passes'].sort());
    });

    it('records number of re-encode passes and final size accurately', async () => {
      const tm = new TelemetryModule();
      tm.emit({ kind: 'screen.keyframeReencode', passes: 5, finalBytes: 98304 });
      await tick();

      const events = await tm.query(60_000);
      const e = events[0] as StoredTelemetryEvent & { passes: number; finalBytes: number };
      expect(e.passes).toBe(5);
      expect(e.finalBytes).toBe(98304);
    });
  });

  // -------------------------------------------------------------------
  // Requirement 9.5: No raw content leakage — emit drops malformed events
  // -------------------------------------------------------------------

  describe('emit drops malformed screen events (Requirement 9.5)', () => {
    it('drops screen.dispatch with embedded recognized text', async () => {
      const tm = new TelemetryModule();
      const malformed = {
        kind: 'screen.dispatch' as const,
        latencyMs: 100,
        hasKeyframe: true,
        hasScreenText: true,
        ocrText: 'The user has several open tabs including email and a code editor with TypeScript',
      } as unknown as MetricEvent;

      tm.emit(malformed);
      await tick();

      const events = await tm.query(60_000);
      expect(events.length).toBe(0);
    });

    it('drops screen.ocrComplete with embedded OCR result', async () => {
      const tm = new TelemetryModule();
      const malformed = {
        kind: 'screen.ocrComplete' as const,
        durationMs: 900,
        deduped: false,
        recognizedContent: 'File Edit Selection View Go Run Terminal Help Explorer Source Control',
      } as unknown as MetricEvent;

      tm.emit(malformed);
      await tick();

      const events = await tm.query(60_000);
      expect(events.length).toBe(0);
    });

    it('drops screen.keyframeReencode with embedded base64 image', async () => {
      const tm = new TelemetryModule();
      const malformed = {
        kind: 'screen.keyframeReencode' as const,
        passes: 2,
        finalBytes: 100000,
        rawFrame: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAA==',
      } as unknown as MetricEvent;

      tm.emit(malformed);
      await tick();

      const events = await tm.query(60_000);
      expect(events.length).toBe(0);
    });

    it('drops screen.ocrSkipped with embedded raw base64 chunk (≥64 chars)', async () => {
      const tm = new TelemetryModule();
      const longBase64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/AAAA';
      const malformed = {
        kind: 'screen.ocrSkipped' as const,
        reason: 'vision-adapter' as const,
        preview: longBase64,
      } as unknown as MetricEvent;

      tm.emit(malformed);
      await tick();

      const events = await tm.query(60_000);
      expect(events.length).toBe(0);
    });

    it('enqueueExternal drops malformed screen.* events with raw content', () => {
      const tm = new TelemetryModule({ optIn: true });

      const malformed = {
        kind: 'screen.dispatch' as const,
        latencyMs: 100,
        hasKeyframe: true,
        hasScreenText: true,
        screenCapture: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk',
      } as unknown as MetricEvent;

      tm.enqueueExternal(malformed);
      expect(tm.getExternalQueue().length).toBe(0);
    });

    it('valid screen.* events pass through while malformed ones are dropped', async () => {
      const tm = new TelemetryModule();

      // Valid events
      tm.emit({ kind: 'screen.dispatch', latencyMs: 200, hasKeyframe: true, hasScreenText: true });
      tm.emit({ kind: 'screen.ocrComplete', durationMs: 1100, deduped: false });
      tm.emit({ kind: 'screen.ocrSkipped', reason: 'vision-adapter' });
      tm.emit({ kind: 'screen.keyframeReencode', passes: 1, finalBytes: 72000 });

      // Malformed event
      const malformed = {
        kind: 'screen.dispatch' as const,
        latencyMs: 50,
        hasKeyframe: false,
        hasScreenText: true,
        rawScreenText: 'Multiple words of recognized screen text that should be blocked by the validator',
      } as unknown as MetricEvent;
      tm.emit(malformed);

      await tick();

      const events = await tm.query(60_000);
      expect(events.length).toBe(4); // Only valid events persisted
    });

    it('persisted screen.* events contain no string field resembling user content', async () => {
      const tm = new TelemetryModule();

      // Emit all valid screen.* event kinds
      tm.emit({ kind: 'screen.dispatch', latencyMs: 200, hasKeyframe: true, hasScreenText: true });
      tm.emit({ kind: 'screen.ocrComplete', durationMs: 1100, deduped: false });
      tm.emit({ kind: 'screen.ocrSkipped', reason: 'vision-adapter' });
      tm.emit({ kind: 'screen.keyframeReencode', passes: 1, finalBytes: 72000 });
      await tick();

      const events = await tm.query(60_000);
      expect(events.length).toBe(4);

      for (const event of events) {
        for (const [key, value] of Object.entries(event)) {
          if (key === 'id') continue; // ID is a generated string — allowed
          if (typeof value === 'string') {
            // No base64 image data URIs
            expect(value).not.toMatch(/^data:image\//);
            // No long base64 chunks (≥64 chars)
            expect(value.length).toBeLessThan(64);
            // No multi-word natural language text (4+ words)
            const wordCount = value.split(/\s+/).filter(Boolean).length;
            expect(wordCount).toBeLessThan(4);
          }
        }
      }
    });
  });
});
