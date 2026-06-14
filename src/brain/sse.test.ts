// Property-based + unit tests for parseSseFrames.
//
// **Property 12: SSE parser is invariant under chunk boundaries**
//
// *For all* streams `S` and *for all* split sequences,
//   feeding `S` into `parseSseFrames` as one buffer and feeding the same
//   bytes split into chunks (carrying the returned `rest` across calls)
//   produce the same sequence of events and the same trailing rest.
//
// **Validates: Requirement 4.8**

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { parseSseFrames, type SseEvent, type ParseResult } from './sse';

// -- Helpers ----------------------------------------------------------------

/**
 * Feeds a sequence of chunks into `parseSseFrames`, carrying the returned
 * `rest` across calls. Returns the accumulated events and the final
 * unconsumed tail. This models how the AI_Provider_Router will consume a
 * streaming response.
 */
function feedChunks(chunks: string[]): ParseResult {
  const events: SseEvent[] = [];
  let buffer = '';
  for (const chunk of chunks) {
    const r = parseSseFrames(buffer + chunk);
    events.push(...r.events);
    buffer = r.rest;
  }
  return { events, rest: buffer };
}

/**
 * Splits `s` at the given byte offsets. Indices are clamped to (0, len),
 * deduplicated, and sorted; out-of-range or duplicate split points are
 * silently ignored. Returns the (possibly empty-tailed) chunk list.
 */
function splitAt(s: string, indices: number[]): string[] {
  const valid = Array.from(
    new Set(indices.filter((i) => Number.isInteger(i) && i > 0 && i < s.length)),
  ).sort((a, b) => a - b);

  if (valid.length === 0) return [s];

  const chunks: string[] = [];
  let prev = 0;
  for (const i of valid) {
    chunks.push(s.slice(prev, i));
    prev = i;
  }
  chunks.push(s.slice(prev));
  return chunks;
}

// -- Unit tests -------------------------------------------------------------

describe('parseSseFrames (unit)', () => {
  it('parses a single data frame with the default event type', () => {
    const r = parseSseFrames('data: hello\n\n');
    expect(r.events).toEqual([{ event: 'message', data: 'hello' }]);
    expect(r.rest).toBe('');
  });

  it('joins multiple data lines in a single frame with newlines', () => {
    const r = parseSseFrames('data: line1\ndata: line2\n\n');
    expect(r.events).toEqual([{ event: 'message', data: 'line1\nline2' }]);
    expect(r.rest).toBe('');
  });

  it('parses event, data, and id fields together', () => {
    const r = parseSseFrames('event: foo\nid: 42\ndata: bar\n\n');
    expect(r.events).toEqual([{ event: 'foo', data: 'bar', id: '42' }]);
    expect(r.rest).toBe('');
  });

  it('accepts CRLF line endings as well as LF', () => {
    const r = parseSseFrames('event: foo\r\ndata: bar\r\n\r\n');
    expect(r.events).toEqual([{ event: 'foo', data: 'bar' }]);
    expect(r.rest).toBe('');
  });

  it('strips at most one leading space after the colon', () => {
    const r1 = parseSseFrames('data: hello\n\n');
    const r2 = parseSseFrames('data:hello\n\n');
    const r3 = parseSseFrames('data:  hello\n\n');
    expect(r1.events[0].data).toBe('hello');
    expect(r2.events[0].data).toBe('hello');
    expect(r3.events[0].data).toBe(' hello');
  });

  it('ignores comment lines that begin with a colon', () => {
    const r = parseSseFrames(': keep-alive\ndata: ok\n\n');
    expect(r.events).toEqual([{ event: 'message', data: 'ok' }]);
  });

  it('parses a sequence of complete frames in arrival order', () => {
    const r = parseSseFrames(
      'data: one\n\ndata: two\n\nevent: done\ndata: three\n\n',
    );
    expect(r.events).toEqual([
      { event: 'message', data: 'one' },
      { event: 'message', data: 'two' },
      { event: 'done', data: 'three' },
    ]);
    expect(r.rest).toBe('');
  });

  it('retains a partial trailing frame in `rest`', () => {
    const r = parseSseFrames('data: complete\n\ndata: partial');
    expect(r.events).toEqual([{ event: 'message', data: 'complete' }]);
    expect(r.rest).toBe('data: partial');
  });

  it('returns no events when the buffer holds only a partial frame', () => {
    const r = parseSseFrames('data: partial\n');
    expect(r.events).toEqual([]);
    expect(r.rest).toBe('data: partial\n');
  });

  it('returns no events for an empty buffer', () => {
    const r = parseSseFrames('');
    expect(r.events).toEqual([]);
    expect(r.rest).toBe('');
  });

  it('skips empty and comment-only frames', () => {
    expect(parseSseFrames('\n\n').events).toEqual([]);
    expect(parseSseFrames(': only-a-comment\n\n').events).toEqual([]);
    expect(parseSseFrames('\n\n\n\n').events).toEqual([]);
  });

  it('treats a field line without a colon as field with empty value', () => {
    // A bare `event` line sets event type to '' and counts as a field.
    const r = parseSseFrames('event\ndata: x\n\n');
    expect(r.events).toEqual([{ event: '', data: 'x' }]);
  });
});

// -- Property tests --------------------------------------------------------

// Smart generators that produce well-formed SSE-shaped streams. We use a
// constrained alphabet for line content so that we never accidentally emit
// embedded `\r` or `\n` inside a field value (which would be a different
// frame boundary by definition).
const safeChar = fc
  .integer({ min: 0x21, max: 0x7e })
  .map((code) => String.fromCharCode(code));
const safeText = fc.stringOf(safeChar, { minLength: 0, maxLength: 12 });

const fieldName = fc.constantFrom('event', 'data', 'id');
const fieldLine = fc
  .tuple(fieldName, safeText)
  .map(([f, v]) => `${f}: ${v}`);
const commentLine = safeText.map((s) => `:${s}`);

const line = fc.oneof(fieldLine, commentLine);
const eol = fc.constantFrom('\n', '\r\n');

// A frame is one or more lines (with EOLs between them) followed by a blank
// line. We require at least one `data:` line so most generated frames emit
// an event, exercising the parser's happy path.
const frame = fc
  .tuple(
    safeText.map((v) => `data: ${v}`),
    fc.array(line, { minLength: 0, maxLength: 4 }),
    eol,
    eol,
  )
  .map(([dataL, extra, e1, e2]) => {
    const allLines = [dataL, ...extra];
    return allLines.join(e1) + e1 + e2;
  });

const sseStream = fc
  .array(frame, { minLength: 0, maxLength: 6 })
  .map((frames) => frames.join(''));

// Free-form binary stream — the parser must remain a total, deterministic
// function over arbitrary input strings, including ones that look nothing
// like SSE.
const arbitraryStream = fc.string({ minLength: 0, maxLength: 200 });

// Random split offsets into a stream. Each test case generates 0..8 splits
// drawn from a wide range; `splitAt` clamps them to (0, len).
const splitOffsets = fc.array(fc.nat(2_000), { minLength: 0, maxLength: 8 });

describe('parseSseFrames (Property 12: chunk-boundary invariance)', () => {
  it('well-formed SSE streams: chunked parsing equals full parsing', () => {
    fc.assert(
      fc.property(sseStream, splitOffsets, (stream, splits) => {
        const full = parseSseFrames(stream);
        const chunked = feedChunks(splitAt(stream, splits));
        expect(chunked).toEqual(full);
      }),
      { numRuns: 200 },
    );
  });

  it('arbitrary streams: chunked parsing equals full parsing', () => {
    fc.assert(
      fc.property(arbitraryStream, splitOffsets, (stream, splits) => {
        const full = parseSseFrames(stream);
        const chunked = feedChunks(splitAt(stream, splits));
        expect(chunked).toEqual(full);
      }),
      { numRuns: 200 },
    );
  });

  it('byte-by-byte feeding (one character per chunk) equals full parsing', () => {
    fc.assert(
      fc.property(sseStream, (stream) => {
        const full = parseSseFrames(stream);
        const chunks = Array.from(stream);
        const chunked = feedChunks(chunks);
        expect(chunked).toEqual(full);
      }),
      { numRuns: 100 },
    );
  });
});
