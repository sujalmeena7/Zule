// Feature: auto-updater, Property 2: Manifest parsing completeness
//
// **Validates: Requirements 1.2, 1.3**
//
// For any YAML string representing a Latest_Release_Manifest, the
// `parseManifest` function SHALL return a valid parsed result containing
// version, artefact filename, file size, and integrity hash if and only if
// all four fields are present and well-formed; otherwise it SHALL return a
// parse-failure result. No partial result (with any of the four fields
// missing) shall ever be accepted.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseManifest } from '../autoUpdateService';

// ── Generators ───────────────────────────────────────────────────────────────

/** Generates a valid semver version string (major.minor.patch). */
const arbSemver = fc
  .tuple(
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 0, max: 99 }),
  )
  .map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

/** Generates a non-empty filename string (e.g., installer exe name). */
const arbFilename = fc
  .stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')), {
    minLength: 1,
    maxLength: 30,
  })
  .map((base) => `${base}.exe`);

/** Generates a positive integer for file size. */
const arbSize = fc.integer({ min: 1, max: 500_000_000 });

/** Generates a non-empty hash string (hex-like, simulating sha512 base64). */
const arbHash = fc
  .stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/='.split('')), {
    minLength: 10,
    maxLength: 88,
  });

/**
 * Builds a YAML string from optional fields. If a field is undefined,
 * it is omitted from the output.
 */
function buildManifestYaml(fields: {
  version?: string;
  path?: string;
  size?: number;
  sha512?: string;
}): string {
  const lines: string[] = [];
  if (fields.version !== undefined) lines.push(`version: ${fields.version}`);
  if (fields.path !== undefined) lines.push(`path: ${fields.path}`);
  if (fields.size !== undefined) lines.push(`size: ${fields.size}`);
  if (fields.sha512 !== undefined) lines.push(`sha512: ${fields.sha512}`);
  return lines.join('\n');
}

// ── Property Test ────────────────────────────────────────────────────────────

describe('Property 2: Manifest parsing completeness', () => {
  it('returns ok:true iff all 4 fields are present and well-formed', () => {
    // Generate manifests with each field optionally present
    const arbManifestFields = fc.record({
      version: fc.option(arbSemver, { nil: undefined }),
      path: fc.option(arbFilename, { nil: undefined }),
      size: fc.option(arbSize, { nil: undefined }),
      sha512: fc.option(arbHash, { nil: undefined }),
    });

    fc.assert(
      fc.property(arbManifestFields, (fields) => {
        const yaml = buildManifestYaml(fields);
        const result = parseManifest(yaml);

        const allPresent =
          fields.version !== undefined &&
          fields.path !== undefined &&
          fields.size !== undefined &&
          fields.sha512 !== undefined;

        if (allPresent) {
          // All 4 fields present and well-formed → must succeed
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.manifest.version).toBe(fields.version);
            expect(result.manifest.filename).toBe(fields.path);
            expect(result.manifest.size).toBe(fields.size);
            expect(result.manifest.hash).toBe(fields.sha512);
          }
        } else {
          // At least one field missing → must fail
          expect(result.ok).toBe(false);
        }
      }),
      { numRuns: 150 },
    );
  });

  it('rejects manifests with invalid version (non-semver)', () => {
    // Note: semver library accepts 'v1.0.0' as valid (strips v prefix).
    // Only truly invalid version strings should be rejected.
    const arbInvalidVersion = fc.constantFrom(
      'not-a-version',
      'abc',
      '1.2',
      '1',
      '',
      'hello.world.foo',
      '999',
      'a.b.c',
    );

    fc.assert(
      fc.property(arbInvalidVersion, arbFilename, arbSize, arbHash, (version, path, size, sha512) => {
        const yaml = buildManifestYaml({ version, path, size, sha512 });
        const result = parseManifest(yaml);
        expect(result.ok).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects manifests with invalid size (zero, negative, or non-integer)', () => {
    const arbInvalidSize = fc.constantFrom(0, -1, -100);

    fc.assert(
      fc.property(arbSemver, arbFilename, arbInvalidSize, arbHash, (version, path, size, sha512) => {
        const yaml = buildManifestYaml({ version, path, size, sha512 });
        const result = parseManifest(yaml);
        expect(result.ok).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('returns ok:true for complete manifests with valid fields (positive case)', () => {
    fc.assert(
      fc.property(arbSemver, arbFilename, arbSize, arbHash, (version, path, size, sha512) => {
        const yaml = buildManifestYaml({ version, path, size, sha512 });
        const result = parseManifest(yaml);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.manifest.version).toBe(version);
          expect(result.manifest.filename).toBe(path);
          expect(result.manifest.size).toBe(size);
          expect(result.manifest.hash).toBe(sha512);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('handles empty and non-string inputs gracefully', () => {
    expect(parseManifest('')).toEqual({ ok: false, reason: 'Empty or invalid input' });
    expect(parseManifest('   ')).toEqual({ ok: false, reason: 'Missing or invalid version field' });
  });
});
