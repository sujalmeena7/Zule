// ============================================
// Zule AI — parseSseFrames
// ============================================
//
// Pure helper used by the AI_Provider_Router (and per-provider adapters) to
// parse Server-Sent Events from a streaming HTTP response. Implements
// Requirement 4.8:
//
//   THE AI_Provider_Router SHALL parse server-sent events using
//   event-boundary detection (blank line `\r?\n\r?\n`) rather than naive
//   line splitting, and SHALL retain partial frames in a buffer across
//   `read()` calls.
//
// The previous implementation in `src/brain/aiProvider.ts` split on `\n`
// only, which meant that a token boundary that happened to fall inside a
// CRLF or inside a `data: ...` payload was either lost or duplicated. Real
// providers (Gemini, OpenAI, Anthropic) use SSE event boundaries (a blank
// line) and a single event can span many `data:` lines.
//
// The function is a pure function over its input string. Callers feed it
// the buffered chunk so far; it returns every fully-terminated event it
// found and the unconsumed tail so the caller can prepend it to the next
// chunk:
//
//   let buffer = '';
//   for await (const chunk of stream) {
//     const { events, rest } = parseSseFrames(buffer + chunk);
//     events.forEach(emit);
//     buffer = rest;
//   }
//
// Property 12 (validates Requirement 4.8) checks chunk-boundary
// invariance: parsing the same stream split into arbitrary chunks (with
// the leftover `rest` carried across calls) yields the same sequence of
// events as a single call on the full stream.

/** A single parsed SSE event. */
export interface SseEvent {
  /** Event type. Defaults to `'message'` when no `event:` field is present. */
  event: string;
  /** Concatenation of all `data:` field values in the frame, joined by `\n`. */
  data: string;
  /** Last `id:` field value seen in the frame, if any. */
  id?: string;
}

/** Result of parsing a buffered chunk. */
export interface ParseResult {
  /** Every fully-terminated frame found in the buffer, in arrival order. */
  events: SseEvent[];
  /** The trailing partial frame, if any. The caller MUST prepend it to the next chunk. */
  rest: string;
}

// Frame boundary per WHATWG SSE: a blank line, where the line terminator
// can be LF or CRLF. We accept any combination of optional CR + LF on each
// of the two line endings, i.e. `\r?\n\r?\n`.
const FRAME_BOUNDARY = /\r?\n\r?\n/g;

// Line boundary inside a frame: LF or CRLF.
const LINE_BOUNDARY = /\r?\n/;

/**
 * Parses every fully-terminated SSE frame in `buf`, returning the events
 * and the unconsumed tail (the partial frame that has not yet seen its
 * closing blank line).
 *
 * Frame parsing rules (WHATWG-aligned, with conservative permissiveness
 * for the known providers we ship adapters for):
 * - A frame ends at the first `\r?\n\r?\n`.
 * - Within a frame, lines are split on `\r?\n`.
 * - A line beginning with `:` is a comment and is ignored.
 * - A line is split at its first `:`. The portion before the colon is the
 *   field name; the portion after is the value. A single leading SPACE in
 *   the value is stripped (per the SSE spec). A line without a `:` is
 *   treated as a field name with an empty value.
 * - Recognised fields: `event`, `data`, `id`. Other fields (including
 *   `retry`) are ignored.
 * - Multiple `data:` lines in one frame are concatenated, joined by `\n`.
 * - A frame that contains no recognised field line (for example: empty,
 *   only whitespace, or only comments) does not produce an event.
 * - The default event type when no `event:` field is present is `'message'`.
 *
 * The function never throws on invalid input; any string is a legal buffer.
 */
export function parseSseFrames(buf: string): ParseResult {
  const events: SseEvent[] = [];

  // We have to use a fresh regex object (or reset lastIndex) because the
  // regex uses the `g` flag and remembers state between calls.
  const re = new RegExp(FRAME_BOUNDARY.source, 'g');

  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(buf)) !== null) {
    const frame = buf.slice(cursor, match.index);
    cursor = match.index + match[0].length;

    const evt = parseFrame(frame);
    if (evt !== null) events.push(evt);
  }

  return { events, rest: buf.slice(cursor) };
}

/**
 * Parses a single (already-delimited) SSE frame. Returns `null` if the
 * frame contains no recognised field line.
 */
function parseFrame(frame: string): SseEvent | null {
  if (frame.length === 0) return null;

  let eventType = 'message';
  const dataLines: string[] = [];
  let id: string | undefined;
  let hasField = false;

  for (const line of frame.split(LINE_BOUNDARY)) {
    if (line.length === 0) continue;
    if (line.startsWith(':')) continue; // comment line

    const colonIdx = line.indexOf(':');
    let field: string;
    let value: string;
    if (colonIdx === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colonIdx);
      value = line.slice(colonIdx + 1);
      // Per SSE: strip a single leading SPACE (U+0020) from the value.
      if (value.charCodeAt(0) === 0x20) value = value.slice(1);
    }

    switch (field) {
      case 'event':
        eventType = value;
        hasField = true;
        break;
      case 'data':
        dataLines.push(value);
        hasField = true;
        break;
      case 'id':
        id = value;
        hasField = true;
        break;
      default:
        // Unknown field (`retry`, custom names) — ignored per spec.
        break;
    }
  }

  if (!hasField) return null;

  const event: SseEvent = {
    event: eventType,
    data: dataLines.join('\n'),
  };
  if (id !== undefined) event.id = id;
  return event;
}
