// ============================================
// Zule AI — Ring Buffer Property-Based Tests
// ============================================
//
// Feature: screen-context-latency, Property 13: Ring buffer bounded at 5
//
// Validates: Requirements 8.5

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { pushToRingBuffer } from '../ringBuffer';

describe('Ring Buffer Property Tests', () => {
  // Feature: screen-context-latency, Property 13: Ring buffer bounded at 5
  describe('Property 13: Ring buffer bounded at 5', () => {
    it('buffer.length ≤ 5 after any number of pushes (1–1000)', () => {
      const MAX_SIZE = 5;

      fc.assert(
        fc.property(
          // Generate a random push count between 1 and 1000
          fc.integer({ min: 1, max: 1000 }),
          // Generate random items to push (arbitrary strings)
          fc.array(fc.string(), { minLength: 1000, maxLength: 1000 }),
          (pushCount, items) => {
            // Start with an empty buffer and push `pushCount` items
            let buffer: readonly string[] = [];
            for (let i = 0; i < pushCount; i++) {
              buffer = pushToRingBuffer(buffer, items[i % items.length], MAX_SIZE);
            }

            // **Validates: Requirements 8.5**
            // Property assertion: buffer never exceeds maxSize
            expect(buffer.length).toBeLessThanOrEqual(MAX_SIZE);
            expect(buffer.length).toBeGreaterThan(0);

            // Verify the buffer contains the N most recent entries
            // where N = min(pushCount, MAX_SIZE)
            const expectedLength = Math.min(pushCount, MAX_SIZE);
            expect(buffer.length).toBe(expectedLength);

            // Verify the buffer contains the most recent entries in order
            const allPushed: string[] = [];
            for (let i = 0; i < pushCount; i++) {
              allPushed.push(items[i % items.length]);
            }
            const expectedEntries = allPushed.slice(-MAX_SIZE);
            expect([...buffer]).toEqual(expectedEntries);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
