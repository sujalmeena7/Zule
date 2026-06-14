// ============================================
// Zule AI — Validated import/export
// ============================================
//
// Pure validation for `ExportedData` payloads loaded from disk or paste.
//
// Why a dedicated module?
//   The unified persistence layer (`./database.ts`) historically called
//   its own `importData()` after only a shallow `Array.isArray` check on
//   each top-level field. A malformed file (or one from a future schema
//   version with incompatible records) could therefore land partial
//   garbage in IndexedDB before the call eventually rejected on a
//   deeper write. Requirement 16.3 mandates that import validation
//   happen *before any store mutation*; this module provides the gate.
//
// Contract:
//   `validateExport(json: unknown)` is a total, pure function:
//     - Total — it never throws, even on cyclic / exotic / undefined
//       inputs. Any unexpected internal failure is caught and converted
//       into a typed `Result` failure so callers can surface a toast.
//     - Pure — it performs no I/O. In particular it never opens the
//       unified IndexedDB, so a failed validation cannot mutate any
//       store. The orchestration layer must call `validateExport`
//       *before* `database.importData`; the latter is left untouched.
//
// Acceptance criteria covered:
//   - 16.3 — Validates payload shape (`version` number, `exportedAt`
//     finite number, arrays of typed records); rejects on validation
//     failure with `storage.import-invalid` carrying a human-readable
//     `reason`. The orchestration layer surfaces the result through the
//     existing toast pipeline (Recovery policy table in design.md).
//
// Design references:
//   - design.md §"Export / Import"
//   - design.md §Property 47 — Import validation is total
//   - design.md §Error Handling > "Recovery policy"

import { err, ok, type Result } from '../types/result';
import type { ZuleError } from '../types/errors';
import type {
  CustomMode,
  ExportedData,
  KBDocument,
  SettingRecord,
  StoredMeeting,
} from './database';

/** Narrowed alias — only `storage.import-invalid` errors flow out of here. */
export type ImportInvalidError = Extract<
  ZuleError,
  { kind: 'storage.import-invalid' }
>;

/** Allowed values for `KBDocument.type` (kept in sync with `database.ts`). */
const KB_DOCUMENT_TYPES: ReadonlySet<KBDocument['type']> = new Set([
  'resume',
  'project',
  'job-description',
  'notes',
  'sales-script',
  'custom',
]);

// --- Primitive guards ---------------------------------------------------

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isString(x: unknown): x is string {
  return typeof x === 'string';
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function isBoolean(x: unknown): x is boolean {
  return typeof x === 'boolean';
}

// --- Validation entry point --------------------------------------------

/**
 * Validate that `json` conforms to `ExportedData`. Returns a typed
 * `Result` so callers never need a `try`/`catch`.
 *
 * The function is total: any input — including cyclic, exotic, or
 * `undefined` values — produces a `Result` rather than a thrown
 * exception. On failure no IndexedDB store is touched (the function
 * does no I/O), so callers can surface a toast and leave persistence
 * untouched per Requirement 16.3.
 */
export function validateExport(
  json: unknown,
): Result<ExportedData, ImportInvalidError> {
  try {
    return runValidation(json);
  } catch (e) {
    // Defence in depth: even if a structurally exotic input (e.g. a
    // proxy that throws on property access) escapes the explicit
    // guards above, surface the failure as a typed `Result` rather
    // than letting the exception escape.
    const reason = e instanceof Error ? e.message : 'unknown error';
    return fail(`unexpected validation failure: ${reason}`);
  }
}

function fail(reason: string): Result<never, ImportInvalidError> {
  return err({ kind: 'storage.import-invalid', reason });
}

// --- Top-level validator -----------------------------------------------

function runValidation(
  json: unknown,
): Result<ExportedData, ImportInvalidError> {
  if (!isPlainObject(json)) {
    return fail('payload is not an object');
  }

  if (!isFiniteNumber(json.version)) {
    return fail('version: expected finite number');
  }
  if (!isFiniteNumber(json.exportedAt)) {
    return fail('exportedAt: expected finite number');
  }

  const meetings = validateArray(json.meetings, 'meetings', validateMeeting);
  if (!meetings.ok) return meetings;

  const settings = validateArray(json.settings, 'settings', validateSetting);
  if (!settings.ok) return settings;

  const documents = validateArray(json.documents, 'documents', validateDocument);
  if (!documents.ok) return documents;

  const modes = validateArray(json.modes, 'modes', validateMode);
  if (!modes.ok) return modes;

  // Build the typed value strictly from validated parts so any extra
  // fields on the input are discarded. This keeps the result shape
  // exactly `ExportedData` regardless of what else the file carried.
  const value: ExportedData = {
    version: json.version,
    exportedAt: json.exportedAt,
    meetings: meetings.value,
    settings: settings.value,
    documents: documents.value,
    modes: modes.value,
  };
  return ok(value);
}

// --- Array helper ------------------------------------------------------

function validateArray<T>(
  raw: unknown,
  field: string,
  validateElement: (
    x: unknown,
    path: string,
  ) => Result<T, ImportInvalidError>,
): Result<T[], ImportInvalidError> {
  if (!Array.isArray(raw)) {
    return fail(`${field}: expected array`);
  }
  const out: T[] = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const result = validateElement(raw[i], `${field}[${i}]`);
    if (!result.ok) return result;
    out[i] = result.value;
  }
  return ok(out);
}

// --- Element validators ------------------------------------------------

function validateMeeting(
  x: unknown,
  path: string,
): Result<StoredMeeting, ImportInvalidError> {
  if (!isPlainObject(x)) return fail(`${path}: expected object`);

  if (!isString(x.id)) return fail(`${path}.id: expected string`);
  if (!isString(x.title)) return fail(`${path}.title: expected string`);
  if (!isString(x.mode)) return fail(`${path}.mode: expected string`);
  if (!isFiniteNumber(x.startedAt))
    return fail(`${path}.startedAt: expected finite number`);
  if (!isFiniteNumber(x.endedAt))
    return fail(`${path}.endedAt: expected finite number`);
  if (!isFiniteNumber(x.duration))
    return fail(`${path}.duration: expected finite number`);
  if (!isString(x.summary)) return fail(`${path}.summary: expected string`);
  if (!isFiniteNumber(x.aiSuggestionCount))
    return fail(`${path}.aiSuggestionCount: expected finite number`);
  if (!isFiniteNumber(x.fillerCount))
    return fail(`${path}.fillerCount: expected finite number`);
  if (!isFiniteNumber(x.avgConfidence))
    return fail(`${path}.avgConfidence: expected finite number`);
  if (!isFiniteNumber(x.wordsPerMinute))
    return fail(`${path}.wordsPerMinute: expected finite number`);

  const transcript = validateArray(
    x.transcript,
    `${path}.transcript`,
    validateTranscriptLine,
  );
  if (!transcript.ok) return transcript;

  const actionItems = validateArray(
    x.actionItems,
    `${path}.actionItems`,
    validateActionItem,
  );
  if (!actionItems.ok) return actionItems;

  // followUpEmail is optional. When present it must be a string.
  let followUpEmail: string | undefined;
  if (x.followUpEmail !== undefined) {
    if (!isString(x.followUpEmail)) {
      return fail(`${path}.followUpEmail: expected string when present`);
    }
    followUpEmail = x.followUpEmail;
  }

  const meeting: StoredMeeting = {
    id: x.id,
    title: x.title,
    mode: x.mode,
    startedAt: x.startedAt,
    endedAt: x.endedAt,
    duration: x.duration,
    transcript: transcript.value,
    summary: x.summary,
    actionItems: actionItems.value,
    aiSuggestionCount: x.aiSuggestionCount,
    fillerCount: x.fillerCount,
    avgConfidence: x.avgConfidence,
    wordsPerMinute: x.wordsPerMinute,
    ...(followUpEmail !== undefined ? { followUpEmail } : {}),
  };
  return ok(meeting);
}

function validateTranscriptLine(
  x: unknown,
  path: string,
): Result<StoredMeeting['transcript'][number], ImportInvalidError> {
  if (!isPlainObject(x)) return fail(`${path}: expected object`);
  if (!isString(x.id)) return fail(`${path}.id: expected string`);
  if (!isString(x.text)) return fail(`${path}.text: expected string`);
  if (!isFiniteNumber(x.timestamp))
    return fail(`${path}.timestamp: expected finite number`);
  if (!isString(x.speaker)) return fail(`${path}.speaker: expected string`);
  return ok({
    id: x.id,
    text: x.text,
    timestamp: x.timestamp,
    speaker: x.speaker,
  });
}

function validateActionItem(
  x: unknown,
  path: string,
): Result<StoredMeeting['actionItems'][number], ImportInvalidError> {
  if (!isPlainObject(x)) return fail(`${path}: expected object`);
  if (!isString(x.id)) return fail(`${path}.id: expected string`);
  if (!isString(x.text)) return fail(`${path}.text: expected string`);
  if (!isBoolean(x.completed))
    return fail(`${path}.completed: expected boolean`);
  return ok({ id: x.id, text: x.text, completed: x.completed });
}

function validateSetting(
  x: unknown,
  path: string,
): Result<SettingRecord, ImportInvalidError> {
  if (!isPlainObject(x)) return fail(`${path}: expected object`);
  if (!isString(x.key)) return fail(`${path}.key: expected string`);
  // `value` is `unknown` by design — settings are heterogeneous. We
  // require the field to *be present* (so the round-trip preserves
  // shape) but we do not constrain its type.
  if (!Object.prototype.hasOwnProperty.call(x, 'value')) {
    return fail(`${path}.value: required field missing`);
  }
  return ok({ key: x.key, value: x.value });
}

function validateDocument(
  x: unknown,
  path: string,
): Result<KBDocument, ImportInvalidError> {
  if (!isPlainObject(x)) return fail(`${path}: expected object`);
  if (!isString(x.id)) return fail(`${path}.id: expected string`);
  if (!isString(x.title)) return fail(`${path}.title: expected string`);
  if (!isString(x.content)) return fail(`${path}.content: expected string`);
  if (!isString(x.type) || !KB_DOCUMENT_TYPES.has(x.type as KBDocument['type'])) {
    return fail(
      `${path}.type: expected one of ${Array.from(KB_DOCUMENT_TYPES).join(', ')}`,
    );
  }
  if (!isFiniteNumber(x.createdAt))
    return fail(`${path}.createdAt: expected finite number`);

  const chunks = validateArray(x.chunks, `${path}.chunks`, validateChunk);
  if (!chunks.ok) return chunks;

  return ok({
    id: x.id,
    title: x.title,
    content: x.content,
    type: x.type as KBDocument['type'],
    chunks: chunks.value,
    createdAt: x.createdAt,
  });
}

function validateChunk(
  x: unknown,
  path: string,
): Result<KBDocument['chunks'][number], ImportInvalidError> {
  if (!isPlainObject(x)) return fail(`${path}: expected object`);
  if (!isString(x.text)) return fail(`${path}.text: expected string`);

  // A chunk must carry exactly one of `vector` (raw `number[]`) or
  // `vectorQ` (int8-quantized form, populated once the Knowledge_Base
  // crosses the QUANTIZATION_THRESHOLD per Requirement 6.4). Reject
  // payloads that supply neither or both so we never accidentally
  // store an ambiguous row.
  const hasRaw = Array.isArray(x.vector);
  const hasQuantized = isPlainObject(x.vectorQ);
  if (hasRaw === hasQuantized) {
    return fail(
      `${path}: expected exactly one of 'vector' (raw) or 'vectorQ' (int8)`,
    );
  }

  if (hasRaw) {
    const vector = x.vector as unknown[];
    for (let i = 0; i < vector.length; i++) {
      if (!isFiniteNumber(vector[i])) {
        return fail(`${path}.vector[${i}]: expected finite number`);
      }
    }
    return ok({ text: x.text, vector: vector as number[] });
  }

  // Quantized form. We accept either an Int8Array (preserved across
  // structured-clone) or a plain `number[]` that round-tripped through
  // JSON, mirroring the shape `quantize(...)` emits.
  const q = x.vectorQ as Record<string, unknown>;
  if (!isFiniteNumber(q.min)) return fail(`${path}.vectorQ.min: expected finite number`);
  if (!isFiniteNumber(q.max)) return fail(`${path}.vectorQ.max: expected finite number`);
  if (q.max < q.min) return fail(`${path}.vectorQ: max must be >= min`);

  let data: Int8Array | null = null;
  if (q.data instanceof Int8Array) {
    data = q.data;
  } else if (Array.isArray(q.data)) {
    const arr = q.data as unknown[];
    const out = new Int8Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (!isFiniteNumber(v) || v < -128 || v > 127 || !Number.isInteger(v)) {
        return fail(`${path}.vectorQ.data[${i}]: expected integer in [-128, 127]`);
      }
      out[i] = v;
    }
    data = out;
  } else {
    return fail(`${path}.vectorQ.data: expected Int8Array or integer array`);
  }

  return ok({
    text: x.text,
    vectorQ: { data, min: q.min, max: q.max },
  });
}

function validateMode(
  x: unknown,
  path: string,
): Result<CustomMode, ImportInvalidError> {
  if (!isPlainObject(x)) return fail(`${path}: expected object`);
  if (!isString(x.id)) return fail(`${path}.id: expected string`);
  if (!isString(x.label)) return fail(`${path}.label: expected string`);
  if (!isString(x.icon)) return fail(`${path}.icon: expected string`);
  if (!isString(x.description))
    return fail(`${path}.description: expected string`);
  if (!isString(x.systemPrompt))
    return fail(`${path}.systemPrompt: expected string`);
  if (!isFiniteNumber(x.createdAt))
    return fail(`${path}.createdAt: expected finite number`);
  return ok({
    id: x.id,
    label: x.label,
    icon: x.icon,
    description: x.description,
    systemPrompt: x.systemPrompt,
    createdAt: x.createdAt,
  });
}
