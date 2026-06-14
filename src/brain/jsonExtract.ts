// ============================================
// Zule AI — Balanced-Brace JSON Extractor
// ============================================
//
// Pure helper used by Summary_Engine to recover a JSON object from a model
// response that may include leading/trailing whitespace, surrounding markdown
// code fences, embedded code fences, and trailing commentary.
//
// Strategy:
//   1. Find the first `{` in the input.
//   2. Scan forward, tracking brace depth, while ignoring braces that appear
//      inside double-quoted JSON strings (escapes honored).
//   3. When depth returns to zero, attempt `JSON.parse` on the slice. If the
//      first balanced candidate fails to parse, continue scanning for a later
//      `{` and try again so that incidental `{` characters in surrounding prose
//      do not defeat extraction.
//   4. Return the first parse that succeeds and yields an object (not null and
//      not an array). Otherwise return null.
//
// Requirements: 10.2, 10.3.

/**
 * Extract the outermost balanced JSON object from `text`.
 *
 * Tolerates:
 *   - leading/trailing whitespace
 *   - surrounding ```json or ``` markdown code fences
 *   - text or commentary before/after the object
 *   - braces inside JSON string values (with `\\` and `\"` escapes)
 *
 * Returns the parsed object on success, or `null` if no balanced object can
 * be parsed out of the input.
 */
export function extractJsonObject(text: string): object | null {
  if (typeof text !== 'string' || text.length === 0) return null;

  // Scan from each `{` until we find one whose balanced slice parses to a
  // non-null, non-array object. This means leading prose containing `{` won't
  // poison the extraction if the actual JSON appears later.
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf('{', searchFrom);
    if (start === -1) return null;

    const end = findBalancedEnd(text, start);
    if (end === -1) {
      // No balanced close exists for this `{` or any later one; bail out.
      return null;
    }

    const slice = text.slice(start, end + 1);
    const parsed = tryParseObject(slice);
    if (parsed !== null) return parsed;

    // The slice was syntactically balanced but JSON.parse rejected it (e.g.,
    // the leading `{` was inside a code comment we don't recognize). Skip
    // past this candidate and keep looking.
    searchFrom = start + 1;
  }

  return null;
}

/**
 * Given an opening-brace position, return the index of the matching `}` taking
 * nested objects and string literals into account. Returns -1 if no balanced
 * close exists in `text`.
 */
function findBalancedEnd(text: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escape) {
        // Previous char was a backslash; consume this char literally.
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1; // unbalanced
    }
  }

  return -1;
}

/**
 * Attempt to JSON.parse a slice and return it only when it is a plain object
 * (not null, not an array, not a primitive).
 */
function tryParseObject(slice: string): object | null {
  try {
    const value = JSON.parse(slice);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as object;
    }
    return null;
  } catch {
    return null;
  }
}
