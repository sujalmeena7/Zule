// ============================================
// Property test: Ephemeral mode does not persist
// Property 45 — Validates: Requirements 15.4
// ============================================

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { shouldPersistMeeting, type PrivacyMode } from './sessionPolicy';

/**
 * **Validates: Requirements 15.4**
 *
 * Property 45: When ephemeral mode is enabled, the stop-session flow
 * should NOT persist meetings to disk. Modeled as a pure predicate:
 *   shouldPersistMeeting('ephemeral') === false
 *   shouldPersistMeeting('normal') === true
 */
describe('sessionPolicy — shouldPersistMeeting', () => {
  it('Property 45: ephemeral mode always returns false (never persists)', () => {
    fc.assert(
      fc.property(
        // Generate arbitrary contexts/calls — the predicate must always hold
        fc.constant('ephemeral' as PrivacyMode),
        (mode) => {
          expect(shouldPersistMeeting(mode)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 45: normal mode always returns true (always persists)', () => {
    fc.assert(
      fc.property(
        fc.constant('normal' as PrivacyMode),
        (mode) => {
          expect(shouldPersistMeeting(mode)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 45: shouldPersistMeeting partitions the PrivacyMode domain exhaustively', () => {
    const validModes: PrivacyMode[] = ['ephemeral', 'normal'];
    fc.assert(
      fc.property(
        fc.constantFrom(...validModes),
        (mode) => {
          const result = shouldPersistMeeting(mode);
          // The function is a total function over the PrivacyMode domain
          expect(typeof result).toBe('boolean');
          // Ephemeral never persists, normal always persists
          if (mode === 'ephemeral') {
            expect(result).toBe(false);
          } else {
            expect(result).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
