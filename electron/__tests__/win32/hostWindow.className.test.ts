// ============================================
// Property 6: Class-name safety
// ============================================
//
// ∀ generated seeds: `randomClassName()` matches format regex, contains no
// blocklisted substrings, and over 10000 seeds collision rate is 0.
//
// **Validates: Requirements 1.1, 1.4**

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import { randomClassName } from '../../win32/hostWindow';

// ── Constants ────────────────────────────────────────────────────────────────

/** Format regex from Requirement 1.1 */
const CLASS_NAME_REGEX = /^[A-Za-z][A-Za-z0-9_]{5,31}$/;

/** Blocklisted substrings (case-insensitive) from Requirement 1.1 */
const BLOCKLIST = ['chrome', 'electron', 'zule', 'overlay', 'widget'];

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Property 6: Class-name safety', () => {
  it('∀ generated names: matches /^[A-Za-z][A-Za-z0-9_]{5,31}$/', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const name = randomClassName();
        return CLASS_NAME_REGEX.test(name);
      }),
      { numRuns: 1000 },
    );
  });

  it('∀ generated names: contains no blocklisted substring (case-insensitive)', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const name = randomClassName();
        const lower = name.toLowerCase();
        return BLOCKLIST.every((word) => !lower.includes(word));
      }),
      { numRuns: 1000 },
    );
  });

  it('over 10000 generated names: zero collisions (all unique)', () => {
    const COUNT = 10_000;
    const names = new Set<string>();

    for (let i = 0; i < COUNT; i++) {
      names.add(randomClassName());
    }

    expect(names.size).toBe(COUNT);
  });

  it('∀ generated names: function terminates and returns a string', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const name = randomClassName();
        return typeof name === 'string' && name.length >= 6 && name.length <= 32;
      }),
      { numRuns: 500 },
    );
  });
});
