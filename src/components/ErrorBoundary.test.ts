// ============================================
// Zule AI — ErrorBoundary telemetry property test (Property 52)
// ============================================
//
// Validates: Requirements 19.3
//
// Property 52: For any error recorded by ErrorBoundary, the emitted
// telemetry event has: kind === 'error', name/message/stack are strings
// (not user content), and no field named 'text', 'transcript',
// 'screenText', 'content', or 'payload' exists.
//
// This exercises the pure `buildErrorTelemetryEvent(error, breadcrumb)`
// helper with arbitrary error shapes.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { buildErrorTelemetryEvent } from '../brain/telemetry';

/**
 * Forbidden field names that would indicate user content leakage.
 */
const FORBIDDEN_FIELDS = new Set([
  'text',
  'transcript',
  'screenText',
  'content',
  'payload',
]);

describe('Property 52: ErrorBoundary records content-free errors', () => {
  /**
   * **Validates: Requirements 19.3**
   *
   * For any Error-like input (with arbitrary name, message, stack)
   * and any breadcrumb trail, the output telemetry event:
   *   1. Has kind === 'error'
   *   2. name, message, and stack are all strings
   *   3. breadcrumb is an array of strings
   *   4. No field is named 'text', 'transcript', 'screenText', 'content', or 'payload'
   */
  it('produces a content-free error event for any Error with breadcrumb', () => {
    const errorArb = fc.record({
      name: fc.string({ minLength: 1, maxLength: 60 }),
      message: fc.string({ minLength: 0, maxLength: 200 }),
      stack: fc.string({ minLength: 0, maxLength: 500 }),
    }).map(({ name, message, stack }) => {
      const err = new Error(message);
      err.name = name;
      err.stack = stack;
      return err;
    });

    const breadcrumbArb = fc.array(
      fc.string({ minLength: 1, maxLength: 40 }),
      { minLength: 0, maxLength: 10 },
    );

    fc.assert(
      fc.property(errorArb, breadcrumbArb, (error, breadcrumb) => {
        const event = buildErrorTelemetryEvent(error, breadcrumb);

        // 1. kind must be 'error'
        expect(event.kind).toBe('error');

        // 2. name, message, stack are strings
        expect(typeof event.name).toBe('string');
        expect(typeof event.message).toBe('string');
        expect(typeof event.stack).toBe('string');

        // 3. breadcrumb is an array of strings
        expect(Array.isArray(event.breadcrumb)).toBe(true);
        for (const b of event.breadcrumb) {
          expect(typeof b).toBe('string');
        }

        // 4. No forbidden content-bearing field names exist
        for (const fieldName of Object.keys(event)) {
          expect(FORBIDDEN_FIELDS.has(fieldName)).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('handles non-Error values (thrown strings, objects, undefined)', () => {
    const nonErrorArb = fc.oneof(
      fc.string({ minLength: 0, maxLength: 100 }),
      fc.nat(),
      fc.constant(null),
      fc.constant(undefined),
      fc.record({ code: fc.nat(), info: fc.string() }),
    );

    const breadcrumbArb = fc.array(
      fc.string({ minLength: 1, maxLength: 30 }),
      { minLength: 0, maxLength: 5 },
    );

    fc.assert(
      fc.property(nonErrorArb, breadcrumbArb, (thrown, breadcrumb) => {
        const event = buildErrorTelemetryEvent(thrown, breadcrumb);

        // kind must always be 'error'
        expect(event.kind).toBe('error');

        // name defaults to 'UnknownError' for non-Error values
        expect(event.name).toBe('UnknownError');

        // message is the stringified thrown value
        expect(typeof event.message).toBe('string');

        // stack is empty string for non-Error values
        expect(event.stack).toBe('');

        // breadcrumb is the provided array
        expect(event.breadcrumb).toEqual(breadcrumb);

        // No forbidden fields
        for (const fieldName of Object.keys(event)) {
          expect(FORBIDDEN_FIELDS.has(fieldName)).toBe(false);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('event has exactly the expected fields and no extras', () => {
    const errorArb = fc.record({
      name: fc.string({ minLength: 1, maxLength: 40 }),
      message: fc.string({ minLength: 0, maxLength: 100 }),
      stack: fc.string({ minLength: 0, maxLength: 200 }),
    }).map(({ name, message, stack }) => {
      const err = new Error(message);
      err.name = name;
      err.stack = stack;
      return err;
    });

    fc.assert(
      fc.property(errorArb, (error) => {
        const event = buildErrorTelemetryEvent(error, ['ErrorBoundary']);

        // The event must have exactly these keys and no more
        const keys = new Set(Object.keys(event));
        const expectedKeys = new Set(['kind', 'name', 'message', 'stack', 'breadcrumb']);
        expect(keys).toEqual(expectedKeys);
      }),
      { numRuns: 200 },
    );
  });
});
