// Property-based + unit tests for WebSpeechProvider pure helpers.
//
// **Property 3: Stop flushes interim text exactly once and only when non-empty**
//
// *For all* transcripts T: TranscriptionLine[] and any interim string s,
// flushOnStop(T, s) returns a transcript whose length is
// T.length + (s.trim() === '' ? 0 : 1). When a flush occurs, the appended
// line carries asrConfidence === 0, isInterim === false, and detection === 'manual'.
//
// **Validates: Requirements 1.6**
//
// **Property 4: Confidence filter is a strict pass-through**
//
// *For all* transcript lines L and any threshold θ ∈ [0, 1],
// applyConfidenceFilter(L, θ) keeps L if and only if L.asrConfidence ≥ θ.
// The count of dropped lines for any input array equals the count of inputs
// whose asrConfidence < θ.
//
// **Validates: Requirements 1.7**

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { flushOnStop, applyConfidenceFilter } from './webSpeech';
import type { TranscriptionLine } from '../../types/transcription';

// ---- Generators ----

const speakerRoleArb = fc.constantFrom('user' as const, 'other' as const);
const detectionArb = fc.constantFrom('manual' as const, 'gap-heuristic' as const, 'voiceprint' as const);
const providerArb = fc.constantFrom('web-speech' as const, 'local-whisper' as const);

const transcriptionLineArb: fc.Arbitrary<TranscriptionLine> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 20 }),
  text: fc.string({ minLength: 1, maxLength: 200 }),
  timestamp: fc.nat({ max: 2_000_000_000_000 }),
  isInterim: fc.boolean(),
  speakerId: fc.stringMatching(/^speaker-[1-9]$/),
  speakerRole: speakerRoleArb,
  detection: detectionArb,
  detectionConfidence: fc.double({ min: 0, max: 1, noNaN: true }),
  asrConfidence: fc.double({ min: 0, max: 1, noNaN: true }),
  language: fc.constantFrom('en-US', 'es-ES', 'fr-FR', 'de-DE', 'ja-JP'),
  provider: providerArb,
});

const transcriptArb = fc.array(transcriptionLineArb, { minLength: 0, maxLength: 20 });

// ---- Unit tests for flushOnStop ----

describe('flushOnStop (unit)', () => {
  const baseOpts = { speakerId: 'speaker-1', speakerRole: 'user' as const, language: 'en-US' };

  it('appends a line when interim is non-empty', () => {
    const result = flushOnStop([], 'hello world', baseOpts);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('hello world');
    expect(result[0].asrConfidence).toBe(0);
    expect(result[0].isInterim).toBe(false);
    expect(result[0].detection).toBe('manual');
    expect(result[0].provider).toBe('web-speech');
  });

  it('does not append when interim is empty', () => {
    const result = flushOnStop([], '', baseOpts);
    expect(result).toHaveLength(0);
  });

  it('does not append when interim is whitespace-only', () => {
    const result = flushOnStop([], '   \t\n  ', baseOpts);
    expect(result).toHaveLength(0);
  });

  it('preserves existing transcript lines', () => {
    const existing: TranscriptionLine[] = [{
      id: 'existing-1',
      text: 'existing line',
      timestamp: 1000,
      isInterim: false,
      speakerId: 'speaker-1',
      speakerRole: 'user',
      detection: 'manual',
      detectionConfidence: 1,
      asrConfidence: 0.9,
      language: 'en-US',
      provider: 'web-speech',
    }];
    const result = flushOnStop(existing, 'new interim', baseOpts);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(existing[0]);
    expect(result[1].text).toBe('new interim');
  });

  it('trims whitespace from the interim text', () => {
    const result = flushOnStop([], '  padded text  ', baseOpts);
    expect(result[0].text).toBe('padded text');
  });
});

// ---- Property 3: Stop flushes interim text exactly once and only when non-empty ----

describe('flushOnStop (Property 3: stop flushes interim text exactly once and only when non-empty)', () => {
  it('output length equals T.length + (s.trim() === "" ? 0 : 1)', () => {
    fc.assert(
      fc.property(
        transcriptArb,
        fc.string({ minLength: 0, maxLength: 100 }),
        speakerRoleArb,
        (transcript, interim, role) => {
          const opts = { speakerId: 'speaker-1', speakerRole: role, language: 'en-US' };
          const result = flushOnStop(transcript, interim, opts);
          const expectedLength = transcript.length + (interim.trim() === '' ? 0 : 1);
          return result.length === expectedLength;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('flushed line has asrConfidence === 0, isInterim === false, detection === "manual"', () => {
    fc.assert(
      fc.property(
        transcriptArb,
        fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim() !== ''),
        speakerRoleArb,
        (transcript, interim, role) => {
          const opts = { speakerId: 'speaker-1', speakerRole: role, language: 'en-US' };
          const result = flushOnStop(transcript, interim, opts);
          const flushed = result[result.length - 1];
          return (
            flushed.asrConfidence === 0 &&
            flushed.isInterim === false &&
            flushed.detection === 'manual'
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it('flushed line text equals the trimmed interim', () => {
    fc.assert(
      fc.property(
        transcriptArb,
        fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim() !== ''),
        speakerRoleArb,
        (transcript, interim, role) => {
          const opts = { speakerId: 'speaker-1', speakerRole: role, language: 'en-US' };
          const result = flushOnStop(transcript, interim, opts);
          const flushed = result[result.length - 1];
          return flushed.text === interim.trim();
        },
      ),
      { numRuns: 300 },
    );
  });

  it('preserves all original transcript lines unchanged', () => {
    fc.assert(
      fc.property(
        transcriptArb,
        fc.string({ minLength: 0, maxLength: 100 }),
        speakerRoleArb,
        (transcript, interim, role) => {
          const opts = { speakerId: 'speaker-1', speakerRole: role, language: 'en-US' };
          const result = flushOnStop(transcript, interim, opts);
          for (let i = 0; i < transcript.length; i++) {
            if (result[i] !== transcript[i]) return false;
          }
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('provider is always "web-speech" on flushed line', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim() !== ''),
        (interim) => {
          const opts = { speakerId: 'speaker-1', speakerRole: 'user' as const, language: 'en-US' };
          const result = flushOnStop([], interim, opts);
          return result[0].provider === 'web-speech';
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---- Unit tests for applyConfidenceFilter ----

describe('applyConfidenceFilter (unit)', () => {
  const makeLine = (confidence: number): TranscriptionLine => ({
    id: `t-${confidence}`,
    text: `text-${confidence}`,
    timestamp: 1000,
    isInterim: false,
    speakerId: 'speaker-1',
    speakerRole: 'user',
    detection: 'manual',
    detectionConfidence: 1,
    asrConfidence: confidence,
    language: 'en-US',
    provider: 'web-speech',
  });

  it('keeps lines with confidence >= threshold', () => {
    const lines = [makeLine(0.5), makeLine(0.8), makeLine(0.3)];
    const { kept, droppedCount } = applyConfidenceFilter(lines, 0.3);
    expect(kept).toHaveLength(3);
    expect(droppedCount).toBe(0);
  });

  it('drops lines with confidence < threshold', () => {
    const lines = [makeLine(0.1), makeLine(0.2), makeLine(0.5)];
    const { kept, droppedCount } = applyConfidenceFilter(lines, 0.3);
    expect(kept).toHaveLength(1);
    expect(kept[0].asrConfidence).toBe(0.5);
    expect(droppedCount).toBe(2);
  });

  it('returns empty kept array when all below threshold', () => {
    const lines = [makeLine(0.1), makeLine(0.2)];
    const { kept, droppedCount } = applyConfidenceFilter(lines, 0.5);
    expect(kept).toHaveLength(0);
    expect(droppedCount).toBe(2);
  });

  it('handles empty input', () => {
    const { kept, droppedCount } = applyConfidenceFilter([], 0.3);
    expect(kept).toHaveLength(0);
    expect(droppedCount).toBe(0);
  });

  it('threshold exactly equal to confidence keeps the line', () => {
    const lines = [makeLine(0.3)];
    const { kept, droppedCount } = applyConfidenceFilter(lines, 0.3);
    expect(kept).toHaveLength(1);
    expect(droppedCount).toBe(0);
  });
});

// ---- Property 4: Confidence filter is a strict pass-through ----

describe('applyConfidenceFilter (Property 4: confidence filter is a strict pass-through)', () => {
  it('keeps exactly those lines with asrConfidence >= threshold', () => {
    fc.assert(
      fc.property(
        fc.array(transcriptionLineArb, { minLength: 0, maxLength: 30 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (lines, threshold) => {
          const { kept, droppedCount } = applyConfidenceFilter(lines, threshold);

          // Every kept line must have confidence >= threshold
          for (const line of kept) {
            if (line.asrConfidence < threshold) return false;
          }

          // Dropped count equals lines below threshold
          const expectedDropped = lines.filter((l) => l.asrConfidence < threshold).length;
          if (droppedCount !== expectedDropped) return false;

          // kept + dropped === total input
          if (kept.length + droppedCount !== lines.length) return false;

          return true;
        },
      ),
      { numRuns: 500 },
    );
  });

  it('kept lines preserve their original values unchanged', () => {
    fc.assert(
      fc.property(
        fc.array(transcriptionLineArb, { minLength: 1, maxLength: 20 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (lines, threshold) => {
          const { kept } = applyConfidenceFilter(lines, threshold);
          const expectedKept = lines.filter((l) => l.asrConfidence >= threshold);

          if (kept.length !== expectedKept.length) return false;
          for (let i = 0; i < kept.length; i++) {
            if (kept[i] !== expectedKept[i]) return false;
          }
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('order of kept lines is preserved from input', () => {
    fc.assert(
      fc.property(
        fc.array(transcriptionLineArb, { minLength: 2, maxLength: 20 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (lines, threshold) => {
          const { kept } = applyConfidenceFilter(lines, threshold);

          // Verify order is preserved: each kept line appears after the previous in the input
          let lastIdx = -1;
          for (const keptLine of kept) {
            const idx = lines.indexOf(keptLine);
            if (idx <= lastIdx) return false;
            lastIdx = idx;
          }
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('threshold of 0 keeps all lines (since asrConfidence >= 0 always)', () => {
    fc.assert(
      fc.property(
        fc.array(transcriptionLineArb, { minLength: 0, maxLength: 20 }),
        (lines) => {
          const { kept, droppedCount } = applyConfidenceFilter(lines, 0);
          return kept.length === lines.length && droppedCount === 0;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('threshold of 1 drops all lines except those with confidence exactly 1', () => {
    fc.assert(
      fc.property(
        fc.array(transcriptionLineArb, { minLength: 0, maxLength: 20 }),
        (lines) => {
          const { kept, droppedCount } = applyConfidenceFilter(lines, 1);
          const expectedKeptCount = lines.filter((l) => l.asrConfidence >= 1).length;
          return kept.length === expectedKeptCount && droppedCount === lines.length - expectedKeptCount;
        },
      ),
      { numRuns: 200 },
    );
  });
});
