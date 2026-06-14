// ============================================
// Zule AI — Question Detector Property-Based Tests
// ============================================
//
// Properties 6, 21, 22, 23 from design.md §Correctness Properties.
// Uses vitest + fast-check.

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { QuestionDetectorStream, differsByAtLeastOneWord } from './questionDetector';
import type { DetectionResult } from './questionDetector';
import type { TranscriptionLine } from '../types/transcription';

// ---------------------------------------------------------------------------
// Helpers: generate valid TranscriptionLine values
// ---------------------------------------------------------------------------

function makeTranscriptionLine(overrides: Partial<TranscriptionLine> = {}): TranscriptionLine {
  return {
    id: 'line-1',
    text: 'some text here for testing',
    timestamp: 1000,
    isInterim: false,
    speakerId: 'speaker-1',
    speakerRole: 'other',
    detection: 'manual',
    detectionConfidence: 1,
    asrConfidence: 0.95,
    language: 'en-US',
    provider: 'web-speech',
    ...overrides,
  };
}

// Arbitrary that generates non-empty text strings of reasonable length
const arbText = fc.string({ minLength: 10, maxLength: 200 }).filter(s => s.trim().length >= 10);

// Arbitrary that generates text ending with a question mark
const arbQuestionText = fc.string({ minLength: 10, maxLength: 200 })
  .filter(s => s.trim().length >= 10)
  .map(s => s.trimEnd().replace(/\?$/, '') + '?');

// Arbitrary for speaker roles
const arbSpeakerRole = fc.constantFrom('user' as const, 'other' as const);

// ---------------------------------------------------------------------------
// Property 6: Question_Detector never fires on user-attributed lines
// ---------------------------------------------------------------------------

describe('Property 6: Question_Detector never fires on user-attributed lines', () => {
  /**
   * **Validates: Requirements 3.3**
   *
   * For all recent-context arrays whose final element has
   * speakerRole === 'user', onNewContext never calls cb.
   */
  it('never fires callback when latest line has speakerRole === "user"', () => {
    fc.assert(
      fc.property(
        arbText,
        fc.integer({ min: 0, max: 100000 }),
        (text, timestamp) => {
          const detector = new QuestionDetectorStream({
            locale: 'en',
            now: () => timestamp + 10000, // always past debounce
          });

          const line = makeTranscriptionLine({
            text: text + '?', // Force a question pattern to ensure detection would fire
            speakerRole: 'user',
            timestamp,
          });

          let fired = false;
          detector.onNewContext([line], () => { fired = true; });

          expect(fired).toBe(false);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('fires callback when latest line has speakerRole === "other" and text is a question', () => {
    // Sanity check: the detector does fire for other speakers with question text
    const detector = new QuestionDetectorStream({
      locale: 'en',
      now: () => 99999999,
    });

    const line = makeTranscriptionLine({
      text: 'What is your experience with distributed systems?',
      speakerRole: 'other',
      timestamp: 1000,
    });

    let fired = false;
    detector.onNewContext([line], () => { fired = true; });
    expect(fired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Property 21: Question_Detector debounce and throttle invariants
// ---------------------------------------------------------------------------

describe('Property 21: Question_Detector debounce and throttle invariants', () => {
  /**
   * **Validates: Requirements 8.1, 8.2**
   *
   * After a final trigger fires, next final trigger cannot fire within
   * debounceMs (1500ms). After an interim trigger fires, next interim
   * cannot fire within interimThrottleMs (4000ms).
   */
  it('final triggers respect debounce interval', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 5000 }), // debounceMs
        fc.array(
          fc.record({
            text: fc.stringMatching(/^[a-z ]{10,30}\?$/),
            deltaMs: fc.integer({ min: 0, max: 10000 }),
          }),
          { minLength: 2, maxLength: 20 }
        ),
        (debounceMs, events) => {
          let currentTime = 0;
          const detector = new QuestionDetectorStream({
            debounceMs,
            locale: 'en',
            now: () => currentTime,
          });

          const fireTimes: number[] = [];

          for (const event of events) {
            currentTime += event.deltaMs;
            const line = makeTranscriptionLine({
              text: event.text,
              speakerRole: 'other',
              timestamp: currentTime,
            });
            detector.onNewContext([line], () => {
              fireTimes.push(currentTime);
            });
          }

          // Verify: consecutive fire times differ by at least debounceMs
          for (let i = 1; i < fireTimes.length; i++) {
            expect(fireTimes[i] - fireTimes[i - 1]).toBeGreaterThanOrEqual(debounceMs);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('interim triggers respect throttle interval', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 8000 }), // interimThrottleMs
        fc.array(
          fc.record({
            text: fc.stringMatching(/^[a-z ]{15,30}\?$/),
            deltaMs: fc.integer({ min: 0, max: 10000 }),
          }),
          { minLength: 2, maxLength: 20 }
        ),
        (interimThrottleMs, events) => {
          let currentTime = 0;
          const detector = new QuestionDetectorStream({
            interimThrottleMs,
            locale: 'en',
            now: () => currentTime,
          });

          const fireTimes: number[] = [];

          for (const event of events) {
            currentTime += event.deltaMs;
            detector.onInterimText(event.text, () => {
              fireTimes.push(currentTime);
            });
          }

          // Verify: consecutive fire times differ by at least interimThrottleMs
          for (let i = 1; i < fireTimes.length; i++) {
            expect(fireTimes[i] - fireTimes[i - 1]).toBeGreaterThanOrEqual(interimThrottleMs);
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 22: Final triggers are independent of interim suppression
// ---------------------------------------------------------------------------

describe('Property 22: Final triggers are independent of interim suppression', () => {
  /**
   * **Validates: Requirements 8.3**
   *
   * A final trigger fires even when its text === the most-recently fired
   * interim trigger, provided debounce has elapsed. This tests that final
   * and interim track suppression independently.
   */
  it('final trigger fires independently of interim suppression state', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z ]{10,30}\?$/),
        fc.integer({ min: 2000, max: 50000 }), // large time gap to ensure debounce/throttle pass
        (questionText, timeGap) => {
          let currentTime = 0;
          const detector = new QuestionDetectorStream({
            debounceMs: 1500,
            interimThrottleMs: 4000,
            locale: 'en',
            now: () => currentTime,
          });

          // First: fire the interim trigger
          let interimFired = false;
          detector.onInterimText(questionText, () => { interimFired = true; });

          // Advance time past both debounce and throttle
          currentTime += timeGap;

          // Now fire the final trigger with the SAME text
          let finalFired = false;
          const line = makeTranscriptionLine({
            text: questionText,
            speakerRole: 'other',
            timestamp: currentTime,
          });
          detector.onNewContext([line], () => { finalFired = true; });

          // The final trigger should fire because final and interim
          // track suppression independently (Requirement 8.3)
          // interimFired may or may not have fired depending on text matching patterns
          // But if the text matches a pattern, final should fire independently
          if (interimFired) {
            // Final must still be able to fire (independent suppression)
            // It fires because lastFinalTriggeredText is different from this text
            expect(finalFired).toBe(true);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('final trigger fires when text differs from interim by at least one word', () => {
    const detector = new QuestionDetectorStream({
      debounceMs: 1500,
      interimThrottleMs: 4000,
      locale: 'en',
      now: () => 99999999, // Always past any debounce
    });

    // Fire interim
    let interimFired = false;
    detector.onInterimText('what is your approach to testing?', () => { interimFired = true; });
    expect(interimFired).toBe(true);

    // Fire final with different text (differs by at least one word)
    let finalFired = false;
    const line = makeTranscriptionLine({
      text: 'what is your approach to deployment?',
      speakerRole: 'other',
    });
    detector.onNewContext([line], () => { finalFired = true; });
    expect(finalFired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Property 23: Trailing-`?` floor for non-self speakers
// ---------------------------------------------------------------------------

describe('Property 23: Trailing-? floor for non-self speakers', () => {
  /**
   * **Validates: Requirements 8.6**
   *
   * When speakerRole === 'other' and text ends with '?',
   * the detector emits confidence >= 0.6.
   */
  it('emits confidence >= 0.6 when other speaker line ends with ?', () => {
    fc.assert(
      fc.property(
        // Generate text that ends with ? and is long enough (>=10 chars)
        fc.string({ minLength: 9, maxLength: 150 })
          .filter(s => s.trim().length >= 9)
          .map(s => {
            // Ensure the text doesn't match ignored patterns
            const cleaned = s.replace(/^(he said|she said|they said)/i, 'someone')
              .replace(/(quote|unquote)/gi, 'words')
              .replace(/(not a real question|just thinking out loud)/gi, 'something');
            return cleaned.trimEnd() + '?';
          })
          .filter(s => s.trim().length >= 10),
        (text) => {
          const detector = new QuestionDetectorStream({
            locale: 'en',
            now: () => 99999999, // Always past debounce
          });

          const line = makeTranscriptionLine({
            text,
            speakerRole: 'other',
            timestamp: 1000,
          });

          let result: DetectionResult | null = null;
          detector.onNewContext([line], (r) => { result = r; });

          // The detector MUST emit with confidence >= 0.6
          expect(result).not.toBeNull();
          expect(result!.confidence).toBeGreaterThanOrEqual(0.6);
          expect(result!.source).toBe('final');
        }
      ),
      { numRuns: 200 }
    );
  });

  it('trailing-? floor applies even for unsupported locales', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 9, maxLength: 100 })
          .filter(s => s.trim().length >= 9)
          .map(s => {
            const cleaned = s.replace(/^(he said|she said|they said)/i, 'someone')
              .replace(/(quote|unquote)/gi, 'words')
              .replace(/(not a real question|just thinking out loud)/gi, 'something');
            return cleaned.trimEnd() + '?';
          })
          .filter(s => s.trim().length >= 10),
        fc.constantFrom('ko', 'ar', 'hi', 'pt', 'ru', 'th'), // unsupported locales
        (text, locale) => {
          const detector = new QuestionDetectorStream({
            locale,
            now: () => 99999999,
          });

          const line = makeTranscriptionLine({
            text,
            speakerRole: 'other',
            timestamp: 1000,
          });

          let result: DetectionResult | null = null;
          detector.onNewContext([line], (r) => { result = r; });

          expect(result).not.toBeNull();
          expect(result!.confidence).toBeGreaterThanOrEqual(0.6);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('does NOT fire trailing-? floor when speakerRole === "user"', () => {
    const detector = new QuestionDetectorStream({
      locale: 'en',
      now: () => 99999999,
    });

    const line = makeTranscriptionLine({
      text: 'Is this going to work?',
      speakerRole: 'user',
      timestamp: 1000,
    });

    let fired = false;
    detector.onNewContext([line], () => { fired = true; });
    expect(fired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for helper function
// ---------------------------------------------------------------------------

describe('differsByAtLeastOneWord', () => {
  it('returns true for different word count', () => {
    expect(differsByAtLeastOneWord('hello world', 'hello')).toBe(true);
  });

  it('returns true when same length but different words', () => {
    expect(differsByAtLeastOneWord('hello world', 'hello there')).toBe(true);
  });

  it('returns false for identical text', () => {
    expect(differsByAtLeastOneWord('hello world', 'hello world')).toBe(false);
  });
});
