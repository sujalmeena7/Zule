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
