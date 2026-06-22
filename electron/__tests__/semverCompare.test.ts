// Feature: auto-updater, Property 1: Semver comparison correctness
// Validates: Requirements 1.6, 2.4, 4.9
//
// For any pair of semantic version strings (currentVersion, availableVersion)
// conforming to SemVer 2.0.0, isCandidateUpdate returns true iff
// availableVersion is strictly greater than currentVersion under SemVer 2.0.0
// precedence rules (including pre-release identifier comparison).

import { describe, test, expect } from 'vitest';
import * as fc from 'fast-check';
import * as semver from 'semver';
import { isCandidateUpdate } from '../autoUpdateService';

/**
 * Arbitrary that generates valid SemVer 2.0.0 version strings.
 * Produces versions like "1.2.3", "0.0.1-alpha", "2.10.0-beta.1"
 */
function semverArb(): fc.Arbitrary<string> {
  const major = fc.nat({ max: 20 });
  const minor = fc.nat({ max: 20 });
  const patch = fc.nat({ max: 20 });

  // Pre-release identifiers: alphanumeric dot-separated segments
  const preReleaseId = fc.oneof(
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), { minLength: 1, maxLength: 8 }),
    fc.nat({ max: 99 }).map(String),
  );

  const preRelease = fc.option(
    fc.array(preReleaseId, { minLength: 1, maxLength: 3 }).map(ids => ids.join('.')),
    { nil: undefined },
  );

  return fc.tuple(major, minor, patch, preRelease).map(([maj, min, pat, pre]) => {
    const base = `${maj}.${min}.${pat}`;
    return pre !== undefined ? `${base}-${pre}` : base;
  });
}

describe('Property 1: Semver comparison correctness', () => {
  // **Validates: Requirements 1.6, 2.4, 4.9**
  test('isCandidateUpdate returns true iff availableVersion > currentVersion per SemVer 2.0.0', () => {
    fc.assert(
      fc.property(semverArb(), semverArb(), (current, available) => {
        // Use the semver package as the oracle (reference implementation)
        const expectedGt = semver.gt(available, current);
        const result = isCandidateUpdate(current, available);

        expect(result).toBe(expectedGt);
      }),
      { numRuns: 200 }, // Above minimum 100 iterations
    );
  });

  test('isCandidateUpdate returns false for equal versions', () => {
    fc.assert(
      fc.property(semverArb(), (version) => {
        const result = isCandidateUpdate(version, version);
        expect(result).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  test('isCandidateUpdate returns false when available < current', () => {
    fc.assert(
      fc.property(semverArb(), semverArb(), (a, b) => {
        // Ensure a > b by using semver oracle
        const greater = semver.gt(a, b) ? a : b;
        const lesser = semver.gt(a, b) ? b : a;

        // Skip equal versions
        if (semver.eq(a, b)) return;

        // available is lesser, current is greater → should be false
        const result = isCandidateUpdate(greater, lesser);
        expect(result).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  test('isCandidateUpdate returns false for invalid version strings', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant('not-a-version'),
          fc.constant(''),
          fc.constant('1.2'),
          fc.constant('abc.def.ghi'),
          fc.constant('1.2.3.4'),
        ),
        semverArb(),
        (invalid, valid) => {
          // Invalid as current
          expect(isCandidateUpdate(invalid, valid)).toBe(false);
          // Invalid as available
          expect(isCandidateUpdate(valid, invalid)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
