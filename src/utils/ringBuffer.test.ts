// ============================================
// Zule AI — Ring Buffer Property Tests
// ============================================
//
// **Validates: Requirements 13.6**
//
// Property 39: After any number of OCR results, the ring buffer length
// never exceeds 5 (or, more generally, the configured maxSize).

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { pushToRingBuffer } from './ringBuffer';

describe('pushToRingBuffer', () => {
  // --- Property-Based Tests ---

  /**
   * Property 39: Recent-OCR ring buffer is bounded.
   *
   * After any sequence of pushes, the buffer length never exceeds maxSize.
   * **Validates: Requirements 13.6**
   */
  it('Property 39: buffer length never exceeds maxSize after any number of pushes', () => {
    fc.assert(
      fc.property(
        // Generate a maxSize between 1 and 20 and a list of entries to push
        fc.integer({ min: 1, max: 20 }),
        fc.array(fc.string(), { minLength: 0, maxLength: 100 }),
        (maxSize, entries) => {
          let buffer: string[] = [];
          for (const entry of entries) {
            buffer = pushToRingBuffer(buffer, entry, maxSize);
            // Invariant: length is never above maxSize
            expect(buffer.length).toBeLessThanOrEqual(maxSize);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('Property 39 (OCR-specific): buffer length never exceeds 5 for the screen capture use case', () => {
    const OCR_RING_BUFFER_MAX = 5;

    fc.assert(
      fc.property(
        // Simulate a sequence of OCR results with varying lengths
        fc.array(
          fc.record({
            text: fc.string({ minLength: 1, maxLength: 200 }),
            timestamp: fc.nat(),
            hash: fc.uint8Array({ minLength: 8, maxLength: 8 }),
          }),
          { minLength: 0, maxLength: 50 },
        ),
        (ocrResults) => {
          let buffer: Array<{ text: string; timestamp: number; hash: Uint8Array }> = [];
          for (const entry of ocrResults) {
            buffer = pushToRingBuffer(buffer, entry, OCR_RING_BUFFER_MAX);
            expect(buffer.length).toBeLessThanOrEqual(OCR_RING_BUFFER_MAX);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('the most recently pushed entry is always at the end', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.array(fc.integer(), { minLength: 1, maxLength: 50 }),
        (maxSize, entries) => {
          let buffer: number[] = [];
          for (const entry of entries) {
            buffer = pushToRingBuffer(buffer, entry, maxSize);
            expect(buffer[buffer.length - 1]).toBe(entry);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('order of entries is preserved (oldest at index 0, newest at end)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.array(fc.integer(), { minLength: 1, maxLength: 50 }),
        (maxSize, entries) => {
          let buffer: number[] = [];
          for (const entry of entries) {
            buffer = pushToRingBuffer(buffer, entry, maxSize);
          }
          // The final buffer should be the tail of entries, length ≤ maxSize
          const expectedTail = entries.slice(-maxSize);
          expect(buffer).toEqual(expectedTail);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('does not mutate the input buffer', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.array(fc.string(), { minLength: 0, maxLength: 10 }),
        fc.string(),
        (maxSize, initial, newEntry) => {
          const frozen = Object.freeze([...initial]);
          // Should not throw despite frozen input
          const result = pushToRingBuffer(frozen, newEntry, maxSize);
          expect(result).not.toBe(frozen);
        },
      ),
      { numRuns: 200 },
    );
  });

  // --- Edge-case unit tests ---

  it('throws RangeError when maxSize < 1', () => {
    expect(() => pushToRingBuffer([], 'x', 0)).toThrow(RangeError);
    expect(() => pushToRingBuffer([], 'x', -1)).toThrow(RangeError);
  });

  it('handles an empty initial buffer', () => {
    const result = pushToRingBuffer([], 'a', 3);
    expect(result).toEqual(['a']);
  });

  it('evicts oldest when at capacity', () => {
    const result = pushToRingBuffer(['a', 'b', 'c'], 'd', 3);
    expect(result).toEqual(['b', 'c', 'd']);
  });

  it('handles maxSize of 1', () => {
    let buf = pushToRingBuffer([], 'first', 1);
    expect(buf).toEqual(['first']);
    buf = pushToRingBuffer(buf, 'second', 1);
    expect(buf).toEqual(['second']);
  });
});
