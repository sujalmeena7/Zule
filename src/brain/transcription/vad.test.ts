// ============================================
// Property-based tests for the VAD module
// ============================================
//
// **Property 13: VAD gate semantics (parameterised over pipeline)**
// **Validates: Requirements 5.1, 5.2, 5.3, 5.6, 6.1, 6.2**
//
// Tests the pure `scoreChunk` function and `mapSensitivityToThreshold`
// directly — no IPC, no React, no audio hardware. Uses `fast-check` to
// generate arbitrary PCM buffers and speech thresholds.

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  scoreChunk,
  mapSensitivityToThreshold,
  SPEECH_FLOOR,
  DEFAULT_FRAME_SIZE,
  type VADConfig,
} from './vad';

// ---- Helpers --------------------------------------------------------

/**
 * Arbitrary for generating a valid Float32Array PCM buffer with samples
 * in [-1, 1] (the standard PCM range for whisper:transcribe).
 */
const arbValidPcm = (minLen = 1, maxLen = 4800) =>
  fc
    .array(fc.double({ min: -1, max: 1, noNaN: true }), {
      minLength: minLen,
      maxLength: maxLen,
    })
    .map((arr) => new Float32Array(arr));

/**
 * Arbitrary for a speech threshold in the open interval (0, 1).
 */
const arbThreshold = fc.double({ min: 0.01, max: 0.99, noNaN: true });

// ---- Property 13: VAD gate semantics --------------------------------

describe('Property 13: VAD gate semantics (parameterised over pipeline)', () => {
  // **Validates: Requirements 5.1, 5.2, 5.3, 5.6, 6.1, 6.2**

  it('scoreChunk returns a score in [0, 1] for any valid PCM buffer', () => {
    fc.assert(
      fc.property(arbValidPcm(), arbThreshold, (pcm, speechThreshold) => {
        const cfg: VADConfig = { speechThreshold };
        const result = scoreChunk(pcm, cfg);

        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1);
        expect(typeof result.score).toBe('number');
        expect(Number.isNaN(result.score)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('isSpeech === (score >= speechThreshold) for any valid PCM and threshold', () => {
    fc.assert(
      fc.property(arbValidPcm(), arbThreshold, (pcm, speechThreshold) => {
        const cfg: VADConfig = { speechThreshold };
        const result = scoreChunk(pcm, cfg);

        expect(result.isSpeech).toBe(result.score >= speechThreshold);
      }),
      { numRuns: 200 },
    );
  });

  it('empty pcm yields score === 0 and isSpeech === false regardless of threshold', () => {
    fc.assert(
      fc.property(arbThreshold, (speechThreshold) => {
        const pcm = new Float32Array(0);
        const cfg: VADConfig = { speechThreshold };
        const result = scoreChunk(pcm, cfg);

        expect(result.score).toBe(0);
        expect(result.isSpeech).toBe(false);
      }),
      { numRuns: 50 },
    );
  });

  it('any sample outside [-2, 2] yields score === 0 and isSpeech === false', () => {
    // Generate a PCM buffer with at least one out-of-range sample.
    const arbOutOfRange = fc
      .tuple(
        fc.array(fc.double({ min: -1, max: 1, noNaN: true }), {
          minLength: 0,
          maxLength: 100,
        }),
        fc.double({ min: 2.01, max: 1000, noNaN: true }).map((v) =>
          fc.boolean().map((neg) => (neg ? -v : v)),
        ),
        fc.array(fc.double({ min: -1, max: 1, noNaN: true }), {
          minLength: 0,
          maxLength: 100,
        }),
      )
      .chain(([prefix, badArb, suffix]) =>
        badArb.map((bad) => new Float32Array([...prefix, bad, ...suffix])),
      );

    fc.assert(
      fc.property(arbOutOfRange, arbThreshold, (pcm, speechThreshold) => {
        const cfg: VADConfig = { speechThreshold };
        const result = scoreChunk(pcm, cfg);

        expect(result.score).toBe(0);
        expect(result.isSpeech).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('NaN samples yield score === 0 and isSpeech === false', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 50 }),
        arbThreshold,
        (insertIdx, speechThreshold) => {
          const buf = new Float32Array(51);
          buf.fill(0.1);
          buf[insertIdx] = NaN;
          const cfg: VADConfig = { speechThreshold };
          const result = scoreChunk(buf, cfg);

          expect(result.score).toBe(0);
          expect(result.isSpeech).toBe(false);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('Infinity samples yield score === 0 and isSpeech === false', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 50 }),
        fc.boolean(),
        arbThreshold,
        (insertIdx, positive, speechThreshold) => {
          const buf = new Float32Array(51);
          buf.fill(0.1);
          buf[insertIdx] = positive ? Infinity : -Infinity;
          const cfg: VADConfig = { speechThreshold };
          const result = scoreChunk(buf, cfg);

          expect(result.score).toBe(0);
          expect(result.isSpeech).toBe(false);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('scoreChunk is deterministic: same input always produces same output', () => {
    fc.assert(
      fc.property(arbValidPcm(1, 2000), arbThreshold, (pcm, speechThreshold) => {
        const cfg: VADConfig = { speechThreshold };
        const r1 = scoreChunk(pcm, cfg);
        const r2 = scoreChunk(pcm, cfg);

        expect(r1.score).toBe(r2.score);
        expect(r1.isSpeech).toBe(r2.isSpeech);
      }),
      { numRuns: 100 },
    );
  });

  it('silence (all-zero buffer) always produces isSpeech === false for threshold > 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4800 }),
        arbThreshold,
        (len, speechThreshold) => {
          const pcm = new Float32Array(len); // all zeros
          const cfg: VADConfig = { speechThreshold };
          const result = scoreChunk(pcm, cfg);

          expect(result.score).toBe(0);
          expect(result.isSpeech).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---- Property 15: VAD failure fall-through ----------------------------

describe('Property 15: VAD failure forwards the chunk and logs a typed error', () => {
  // **Validates: Requirements 5.5**
  //
  // For any PCM chunk where the VAD throws or returns an invalid score
  // (NaN, value outside [0, 1], or undefined), the pipeline SHALL invoke
  // whisper:transcribe(pcm) for that chunk and SHALL emit a typed
  // transcription.vad-failed telemetry event.
  //
  // At the scoreChunk level we validate the defensive guarantee: scoreChunk
  // never throws and always returns { score: 0, isSpeech: false } for
  // invalid inputs. The caller (pipeline) uses this to forward the chunk.

  /**
   * Arbitrary Float32Array containing at least one out-of-range sample
   * (NaN, Infinity, or value > 2 / < -2).
   */
  const arbInvalidPcm = fc
    .tuple(
      fc.array(fc.double({ min: -1, max: 1, noNaN: true }), {
        minLength: 0,
        maxLength: 100,
      }),
      fc.oneof(
        fc.constant(NaN),
        fc.constant(Infinity),
        fc.constant(-Infinity),
        fc.double({ min: 2.01, max: 1000, noNaN: true }),
        fc.double({ min: -1000, max: -2.01, noNaN: true }),
      ),
      fc.array(fc.double({ min: -1, max: 1, noNaN: true }), {
        minLength: 0,
        maxLength: 100,
      }),
    )
    .map(([prefix, bad, suffix]) => new Float32Array([...prefix, bad, ...suffix]));

  it('scoreChunk never throws for any Float32Array with out-of-range samples', () => {
    fc.assert(
      fc.property(arbInvalidPcm, arbThreshold, (pcm, speechThreshold) => {
        const cfg: VADConfig = { speechThreshold };
        // Must not throw
        const result = scoreChunk(pcm, cfg);
        expect(result).toBeDefined();
        expect(typeof result.score).toBe('number');
        expect(typeof result.isSpeech).toBe('boolean');
      }),
      { numRuns: 200 },
    );
  });

  it('scoreChunk returns { score: 0, isSpeech: false } for NaN-containing buffers', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -1, max: 1, noNaN: true }), {
          minLength: 0,
          maxLength: 50,
        }),
        fc.nat({ max: 50 }),
        arbThreshold,
        (validSamples, insertPos, speechThreshold) => {
          const arr = [...validSamples];
          const pos = Math.min(insertPos, arr.length);
          arr.splice(pos, 0, NaN);
          const pcm = new Float32Array(arr);
          const cfg: VADConfig = { speechThreshold };
          const result = scoreChunk(pcm, cfg);

          expect(result.score).toBe(0);
          expect(result.isSpeech).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('scoreChunk returns { score: 0, isSpeech: false } for Infinity-containing buffers', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -1, max: 1, noNaN: true }), {
          minLength: 0,
          maxLength: 50,
        }),
        fc.nat({ max: 50 }),
        fc.boolean(),
        arbThreshold,
        (validSamples, insertPos, positive, speechThreshold) => {
          const arr = [...validSamples];
          const pos = Math.min(insertPos, arr.length);
          arr.splice(pos, 0, positive ? Infinity : -Infinity);
          const pcm = new Float32Array(arr);
          const cfg: VADConfig = { speechThreshold };
          const result = scoreChunk(pcm, cfg);

          expect(result.score).toBe(0);
          expect(result.isSpeech).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('scoreChunk returns { score: 0, isSpeech: false } for values > 2', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -1, max: 1, noNaN: true }), {
          minLength: 0,
          maxLength: 50,
        }),
        fc.double({ min: 2.01, max: 1000, noNaN: true }),
        arbThreshold,
        (validSamples, bigValue, speechThreshold) => {
          const arr = [...validSamples, bigValue];
          const pcm = new Float32Array(arr);
          const cfg: VADConfig = { speechThreshold };
          const result = scoreChunk(pcm, cfg);

          expect(result.score).toBe(0);
          expect(result.isSpeech).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('scoreChunk returns { score: 0, isSpeech: false } for empty Float32Array', () => {
    fc.assert(
      fc.property(arbThreshold, (speechThreshold) => {
        const pcm = new Float32Array(0);
        const cfg: VADConfig = { speechThreshold };
        const result = scoreChunk(pcm, cfg);

        expect(result.score).toBe(0);
        expect(result.isSpeech).toBe(false);
      }),
      { numRuns: 50 },
    );
  });

  it('property-based: any Float32Array with at least one out-of-range sample returns deterministic fallback', () => {
    fc.assert(
      fc.property(arbInvalidPcm, arbThreshold, (pcm, speechThreshold) => {
        const cfg: VADConfig = { speechThreshold };
        const result = scoreChunk(pcm, cfg);

        // The deterministic fallback for invalid inputs:
        expect(result.score).toBe(0);
        expect(result.isSpeech).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});

// ---- mapSensitivityToThreshold --------------------------------------

describe('mapSensitivityToThreshold', () => {
  it('maps low to 0.20', () => {
    expect(mapSensitivityToThreshold('low')).toBe(0.2);
  });

  it('maps medium to 0.35', () => {
    expect(mapSensitivityToThreshold('medium')).toBe(0.35);
  });

  it('maps high to 0.55', () => {
    expect(mapSensitivityToThreshold('high')).toBe(0.55);
  });

  it('threshold values are strictly ordered: low < medium < high', () => {
    const low = mapSensitivityToThreshold('low');
    const medium = mapSensitivityToThreshold('medium');
    const high = mapSensitivityToThreshold('high');

    expect(low).toBeLessThan(medium);
    expect(medium).toBeLessThan(high);
  });

  it('all thresholds are in the open interval (0, 1)', () => {
    for (const level of ['low', 'medium', 'high'] as const) {
      const t = mapSensitivityToThreshold(level);
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThan(1);
    }
  });
});
