// ============================================
// Zule AI — Summary Engine v2 Tests
// ============================================
//
// Property-based and unit tests for the refactored Summary Engine.
// Property 29: Action items satisfy the schema (Requirement 10.4).

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { parseSummaryResponse } from './summaryEngine';
import type { TranscriptLine } from './contextManager';

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/** Arbitrary that generates valid-looking transcript lines. */
const arbTranscriptLine: fc.Arbitrary<TranscriptLine> = fc.record({
  id: fc.uuid(),
  text: fc.string({ minLength: 1, maxLength: 200 }),
  timestamp: fc.nat(),
  isInterim: fc.boolean(),
  speaker: fc.constantFrom('user' as const, 'other' as const),
});

/** Arbitrary that generates a JSON model response with action items. */
const arbSummaryJson = fc.record({
  summary: fc.string({ minLength: 1, maxLength: 500 }),
  actionItems: fc.array(
    fc.record({
      text: fc.string({ minLength: 1, maxLength: 200 }),
      sourceQuote: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
    }),
    { minLength: 1, maxLength: 10 },
  ),
  followUpEmail: fc.string({ minLength: 1, maxLength: 500 }),
  keyFacts: fc.option(
    fc.array(fc.string({ minLength: 1, maxLength: 100 }), { minLength: 0, maxLength: 5 }),
    { nil: undefined },
  ),
});

/**
 * Wraps a summary JSON object in various model response "noise" patterns
 * that extractJsonObject must tolerate.
 */
const arbWrappedResponse = arbSummaryJson.chain((obj) => {
  const json = JSON.stringify(obj);
  return fc.constantFrom(
    json,
    `\`\`\`json\n${json}\n\`\`\``,
    `Here is the summary:\n${json}\n\nLet me know if you need anything else.`,
    `\`\`\`\n${json}\n\`\`\``,
    `  \n${json}\n  `,
  );
});

// ------------------------------------------------------------------
// Property 29: Action items satisfy the schema
// **Validates: Requirements 10.4**
// ------------------------------------------------------------------

describe('summaryEngine – Property 29: action items satisfy the schema', () => {
  it('every action item has non-empty id, text, completed (boolean), and timestamp (positive number)', () => {
    fc.assert(
      fc.property(
        arbWrappedResponse,
        fc.array(arbTranscriptLine, { minLength: 0, maxLength: 5 }),
        fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
        (rawText, transcript, now) => {
          const result = parseSummaryResponse(rawText, transcript, now);

          // If parsing succeeds, validate the schema
          if (result !== null) {
            for (const item of result.actionItems) {
              // id must be a non-empty string
              expect(typeof item.id).toBe('string');
              expect(item.id.length).toBeGreaterThan(0);

              // text must be a non-empty string
              expect(typeof item.text).toBe('string');
              expect(item.text.length).toBeGreaterThan(0);

              // completed must be a boolean
              expect(typeof item.completed).toBe('boolean');

              // timestamp must be a positive number
              expect(typeof item.timestamp).toBe('number');
              expect(item.timestamp).toBeGreaterThan(0);

              // sourceQuote, if present, must be a string
              if (item.sourceQuote !== undefined) {
                expect(typeof item.sourceQuote).toBe('string');
              }

              // sourceLineId, if present, must be a string
              if (item.sourceLineId !== undefined) {
                expect(typeof item.sourceLineId).toBe('string');
              }
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ------------------------------------------------------------------
// Unit tests
// ------------------------------------------------------------------

describe('summaryEngine – parseSummaryResponse', () => {
  const sampleTranscript: TranscriptLine[] = [
    { id: 'line-1', text: 'We should schedule the review meeting next week.', timestamp: 1000, isInterim: false, speaker: 'other' },
    { id: 'line-2', text: 'I agree, let me set that up.', timestamp: 2000, isInterim: false, speaker: 'user' },
  ];

  it('parses a clean JSON response', () => {
    const raw = JSON.stringify({
      summary: 'The team discussed the review meeting.',
      actionItems: [{ text: 'Schedule review meeting', sourceQuote: 'schedule the review meeting next week' }],
      followUpEmail: 'Hi team, please schedule the review.',
      keyFacts: ['Review meeting planned for next week'],
    });

    const result = parseSummaryResponse(raw, sampleTranscript, 1700000000000);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe('The team discussed the review meeting.');
    expect(result!.actionItems).toHaveLength(1);
    expect(result!.actionItems[0].id).toBe('ai-1700000000000-0');
    expect(result!.actionItems[0].text).toBe('Schedule review meeting');
    expect(result!.actionItems[0].completed).toBe(false);
    expect(result!.actionItems[0].sourceQuote).toBe('schedule the review meeting next week');
    expect(result!.actionItems[0].sourceLineId).toBe('line-1');
    expect(result!.actionItems[0].timestamp).toBe(1700000000000);
  });

  it('parses a JSON response wrapped in markdown code fences', () => {
    const json = JSON.stringify({
      summary: 'Summary text',
      actionItems: [{ text: 'Do something' }],
      followUpEmail: 'Email text',
    });
    const raw = '```json\n' + json + '\n```';

    const result = parseSummaryResponse(raw, sampleTranscript);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe('Summary text');
    expect(result!.actionItems[0].text).toBe('Do something');
  });

  it('returns null for completely unparseable text', () => {
    const result = parseSummaryResponse('I could not generate a summary.', sampleTranscript);
    expect(result).toBeNull();
  });

  it('handles response with trailing commentary after JSON', () => {
    const json = JSON.stringify({
      summary: 'A summary.',
      actionItems: [],
      followUpEmail: 'An email.',
    });
    const raw = 'Here is your result:\n' + json + '\nHope this helps!';

    const result = parseSummaryResponse(raw, sampleTranscript);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe('A summary.');
  });

  it('action items without sourceQuote get undefined sourceLineId', () => {
    const raw = JSON.stringify({
      summary: 'Summary',
      actionItems: [{ text: 'Generic action' }],
      followUpEmail: 'Email',
    });

    const result = parseSummaryResponse(raw, sampleTranscript);
    expect(result).not.toBeNull();
    expect(result!.actionItems[0].sourceQuote).toBeUndefined();
    expect(result!.actionItems[0].sourceLineId).toBeUndefined();
  });
});
