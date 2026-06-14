// ============================================
// Zule AI — exportImport tests
// ============================================
//
// Two layers:
//
//   1. Unit tests pinning the contract for `validateExport`:
//      - Accepts a minimal valid payload.
//      - Rejects each top-level shape error with a typed
//        `storage.import-invalid` failure carrying a descriptive
//        `reason`.
//      - Rejects malformed records nested inside any of the typed
//        arrays (meetings / settings / documents / modes).
//
//   2. Property test (Property 47, Requirement 16.3):
//      Import validation is total and round-trips JSON-faithful
//      `ExportedData` values.
//
// `validateExport` is a pure function with no I/O, so tests do not
// need a real (or fake) IndexedDB.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { validateExport } from './exportImport';
import type {
  CustomMode,
  ExportedData,
  KBDocument,
  StoredMeeting,
} from './database';

// ---------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------

function makeMeeting(overrides: Partial<StoredMeeting> = {}): StoredMeeting {
  return {
    id: 'm-1',
    title: 'Standup',
    mode: 'meeting',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_300_000,
    duration: 300_000,
    transcript: [
      { id: 't-1', text: 'hello', timestamp: 0, speaker: 'me' },
    ],
    summary: 'Quick standup.',
    actionItems: [{ id: 'a-1', text: 'follow up', completed: false }],
    aiSuggestionCount: 0,
    fillerCount: 0,
    avgConfidence: 0.9,
    wordsPerMinute: 120,
    ...overrides,
  };
}

function makeDocument(overrides: Partial<KBDocument> = {}): KBDocument {
  return {
    id: 'd-1',
    title: 'Resume',
    content: '...',
    type: 'resume',
    chunks: [{ text: 'chunk', vector: [0.1, 0.2, 0.3] }],
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeMode(overrides: Partial<CustomMode> = {}): CustomMode {
  return {
    id: 'mode-1',
    label: 'Custom',
    icon: '⚙',
    description: 'A custom mode',
    systemPrompt: 'You are a helpful assistant.',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makePayload(overrides: Partial<ExportedData> = {}): ExportedData {
  return {
    version: 4,
    exportedAt: 1_700_000_000_000,
    meetings: [makeMeeting()],
    settings: [{ key: 'theme', value: 'dark' }],
    documents: [makeDocument()],
    modes: [makeMode()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// 1. Unit tests
// ---------------------------------------------------------------------

describe('validateExport — happy path', () => {
  it('accepts a minimal well-formed payload', () => {
    const payload = makePayload();
    const result = validateExport(payload);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(payload);
  });

  it('preserves the optional followUpEmail when present', () => {
    const payload = makePayload({
      meetings: [makeMeeting({ followUpEmail: 'subject\nbody' })],
    });
    const result = validateExport(payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.meetings[0].followUpEmail).toBe('subject\nbody');
    }
  });

  it('drops unknown extra top-level fields without rejecting', () => {
    const payload = { ...makePayload(), extra: 'ignored' };
    const result = validateExport(payload as unknown);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as Record<string, unknown>).extra).toBeUndefined();
    }
  });

  it('accepts every allowed KBDocument.type', () => {
    const types: KBDocument['type'][] = [
      'resume',
      'project',
      'job-description',
      'notes',
      'sales-script',
      'custom',
    ];
    for (const type of types) {
      const result = validateExport(
        makePayload({ documents: [makeDocument({ type })] }),
      );
      expect(result.ok).toBe(true);
    }
  });

  it('accepts settings with heterogeneous value types', () => {
    const payload = makePayload({
      settings: [
        { key: 'a', value: 'str' },
        { key: 'b', value: 42 },
        { key: 'c', value: null },
        { key: 'd', value: { nested: true } },
        { key: 'e', value: [1, 2, 3] },
      ],
    });
    const result = validateExport(payload);
    expect(result.ok).toBe(true);
  });
});

describe('validateExport — top-level rejection', () => {
  it('rejects a non-object payload', () => {
    for (const bad of [null, undefined, 42, 'string', true, []]) {
      const result = validateExport(bad as unknown);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('storage.import-invalid');
    }
  });

  it('rejects a missing version', () => {
    const payload = makePayload();
    delete (payload as Partial<ExportedData>).version;
    const result = validateExport(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toMatch(/version/);
  });

  it('rejects a non-numeric exportedAt', () => {
    const payload = makePayload();
    (payload as { exportedAt: unknown }).exportedAt = '2024-01-01';
    const result = validateExport(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toMatch(/exportedAt/);
  });

  it('rejects NaN / Infinity in numeric fields', () => {
    const nan = makePayload();
    (nan as { exportedAt: unknown }).exportedAt = Number.NaN;
    expect(validateExport(nan).ok).toBe(false);

    const inf = makePayload();
    (inf as { exportedAt: unknown }).exportedAt = Number.POSITIVE_INFINITY;
    expect(validateExport(inf).ok).toBe(false);
  });

  it('rejects when each typed array is missing', () => {
    for (const field of ['meetings', 'settings', 'documents', 'modes'] as const) {
      const payload = makePayload();
      delete (payload as unknown as Record<string, unknown>)[field];
      const result = validateExport(payload);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.reason).toContain(field);
    }
  });

  it('rejects when a typed array contains the wrong record shape', () => {
    const result = validateExport(
      makePayload({
        meetings: [
          { id: 'm-1' /* missing required fields */ } as unknown as StoredMeeting,
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toMatch(/meetings\[0\]/);
  });

  it('rejects an unknown KBDocument.type value', () => {
    const result = validateExport(
      makePayload({
        documents: [
          makeDocument({ type: 'pirate-map' as unknown as KBDocument['type'] }),
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toMatch(/type/);
  });

  it('rejects a chunk vector containing a non-finite number', () => {
    const result = validateExport(
      makePayload({
        documents: [
          makeDocument({
            chunks: [{ text: 'x', vector: [1, Number.NaN, 3] }],
          }),
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toMatch(/vector/);
  });

  it('rejects an actionItem with a non-boolean completed', () => {
    const result = validateExport(
      makePayload({
        meetings: [
          makeMeeting({
            actionItems: [
              {
                id: 'a',
                text: 't',
                completed: 'yes' as unknown as boolean,
              },
            ],
          }),
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toMatch(/completed/);
  });

  it('rejects a setting record missing the value field', () => {
    const payload = makePayload({
      settings: [{ key: 'k' } as unknown as ExportedData['settings'][number]],
    });
    const result = validateExport(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toMatch(/settings\[0\]\.value/);
  });
});

// ---------------------------------------------------------------------
// 2. Property test — Property 47 (Requirement 16.3)
// ---------------------------------------------------------------------

// Generators kept tight so each property test case finishes quickly while
// still exercising every typed record. Strings are bounded to keep
// counter-examples readable; arrays are short for the same reason.

const arbBoundedString = fc.string({ maxLength: 16 });
const arbFiniteInt = fc.integer({ min: -1_000_000, max: 1_000_000 });
const arbNonNegativeInt = fc.integer({ min: 0, max: 1_000_000 });
const arbProbability = fc.double({
  min: 0,
  max: 1,
  noNaN: true,
  noDefaultInfinity: true,
});

const arbTranscriptLine = fc.record({
  id: arbBoundedString,
  text: arbBoundedString,
  timestamp: arbNonNegativeInt,
  speaker: arbBoundedString,
});

const arbActionItem = fc.record({
  id: arbBoundedString,
  text: arbBoundedString,
  completed: fc.boolean(),
});

const arbMeeting: fc.Arbitrary<StoredMeeting> = fc.record({
  id: arbBoundedString,
  title: arbBoundedString,
  mode: arbBoundedString,
  startedAt: arbNonNegativeInt,
  endedAt: arbNonNegativeInt,
  duration: arbNonNegativeInt,
  transcript: fc.array(arbTranscriptLine, { maxLength: 4 }),
  summary: arbBoundedString,
  actionItems: fc.array(arbActionItem, { maxLength: 3 }),
  aiSuggestionCount: arbNonNegativeInt,
  fillerCount: arbNonNegativeInt,
  avgConfidence: arbProbability,
  wordsPerMinute: arbNonNegativeInt,
  // followUpEmail intentionally omitted — JSON drops `undefined`, so
  // including it as an optional field would force the round-trip
  // comparison to special-case its absence.
});

const arbSetting: fc.Arbitrary<{ key: string; value: unknown }> = fc.record({
  key: arbBoundedString,
  // Constrain the heterogeneous `value` to JSON-survivable shapes so the
  // round-trip equality check holds. `fc.jsonValue` produces null,
  // booleans, numbers, strings, and recursively arrays/objects of those.
  value: fc.jsonValue() as fc.Arbitrary<unknown>,
});

const arbDocumentType = fc.constantFrom<KBDocument['type']>(
  'resume',
  'project',
  'job-description',
  'notes',
  'sales-script',
  'custom',
);

const arbChunk = fc.record({
  text: arbBoundedString,
  vector: fc.array(arbFiniteInt, { maxLength: 8 }) as fc.Arbitrary<number[]>,
});

const arbDocument: fc.Arbitrary<KBDocument> = fc.record({
  id: arbBoundedString,
  title: arbBoundedString,
  content: arbBoundedString,
  type: arbDocumentType,
  chunks: fc.array(arbChunk, { maxLength: 3 }),
  createdAt: arbNonNegativeInt,
});

const arbMode: fc.Arbitrary<CustomMode> = fc.record({
  id: arbBoundedString,
  label: arbBoundedString,
  icon: arbBoundedString,
  description: arbBoundedString,
  systemPrompt: arbBoundedString,
  createdAt: arbNonNegativeInt,
});

const arbExportedData: fc.Arbitrary<ExportedData> = fc.record({
  version: arbNonNegativeInt,
  exportedAt: arbNonNegativeInt,
  meetings: fc.array(arbMeeting, { maxLength: 4 }),
  settings: fc.array(arbSetting, { maxLength: 4 }),
  documents: fc.array(arbDocument, { maxLength: 3 }),
  modes: fc.array(arbMode, { maxLength: 3 }),
});

describe('validateExport — Property 47: Import validation is total and non-mutating', () => {
  // Validates: Requirements 16.3
  it('is total: returns a Result and never throws on arbitrary unknown input', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        // The function must never throw — that is the totality guarantee.
        const result = validateExport(input);
        // Result must be a discriminated union with `ok: boolean`.
        expect(typeof result.ok).toBe('boolean');
        if (!result.ok) {
          expect(result.error.kind).toBe('storage.import-invalid');
          expect(typeof result.error.reason).toBe('string');
        }
      }),
      { numRuns: 200 },
    );
  });

  // Validates: Requirements 16.3
  it('round-trips: JSON.parse(JSON.stringify(x)) re-validates to a structurally equivalent value', () => {
    fc.assert(
      fc.property(arbExportedData, (data) => {
        const roundTripped: unknown = JSON.parse(JSON.stringify(data));
        const result = validateExport(roundTripped);
        expect(result.ok).toBe(true);
        if (result.ok) {
          // Structural equality — same as JSON would compare.
          expect(result.value).toEqual(data);
        }
      }),
      { numRuns: 100 },
    );
  });
});
