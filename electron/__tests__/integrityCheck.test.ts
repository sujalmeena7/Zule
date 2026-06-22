// Feature: auto-updater, Property 3: Integrity verification rejects invalid artefacts
//
// For any tuple (installerBytes, expectedHash, expectedSize) where either
// hash(installerBytes) !== expectedHash or len(installerBytes) !== expectedSize,
// verifyIntegrity SHALL return false. Conversely, for any tuple where both
// conditions hold, it SHALL return true.
//
// **Validates: Requirements 1.4, 1.5, 5.8, 8.3**

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import crypto from 'node:crypto';

// Mock electron — required by autoUpdateService.ts via createRequire
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: () => '1.0.0',
  },
}));

// Mock semver — only needed for module-level parsing in autoUpdateService
vi.mock('semver', () => ({
  parse: (v: string) => ({ major: 0, minor: 0, patch: 0, prerelease: [], raw: v }),
  valid: (v: string) => v,
  gt: () => false,
}));

import { verifyIntegrity } from '../autoUpdateService';

// ---------------------------------------------------------------------------
// Oracle: compute SHA-512 base64 hash of bytes (same algorithm as verifyIntegrity)
// ---------------------------------------------------------------------------

function oracleHash(bytes: Uint8Array): string {
  return crypto.createHash('sha512').update(bytes).digest('base64');
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generates random byte arrays of length 0..1024 */
const bytesArb = fc.uint8Array({ minLength: 0, maxLength: 1024 });

/**
 * Generates a random base64 string that is NOT equal to a given hash.
 * We produce a random 64-byte buffer and base64-encode it, which is
 * overwhelmingly unlikely to collide with any real SHA-512 hash.
 */
function wrongHashArb(correctHash: string): fc.Arbitrary<string> {
  return fc.uint8Array({ minLength: 64, maxLength: 64 }).map((arr) => {
    const h = Buffer.from(arr).toString('base64');
    // In the astronomically unlikely event of collision, flip one character
    return h === correctHash ? h.slice(0, -1) + (h.endsWith('A') ? 'B' : 'A') : h;
  });
}

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

describe('Property 3: Integrity verification rejects invalid artefacts', () => {
  // Property A (positive): valid (bytes, correct_hash, correct_size) → true
  it('returns true when both hash and size match', () => {
    fc.assert(
      fc.property(bytesArb, (bytes) => {
        const correctHash = oracleHash(bytes);
        const correctSize = bytes.length;

        const result = verifyIntegrity(Buffer.from(bytes), correctHash, correctSize);
        expect(result).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  // Property B (negative, wrong hash): (bytes, wrong_hash, correct_size) → false
  it('returns false when hash does not match', () => {
    fc.assert(
      fc.property(bytesArb, (bytes) => {
        const correctHash = oracleHash(bytes);
        const correctSize = bytes.length;

        // Generate a wrong hash by computing hash of different data
        const tampered = new Uint8Array(bytes.length + 1);
        tampered.set(bytes);
        tampered[bytes.length] = 0xff;
        const wrongHash = oracleHash(tampered);

        // Ensure the wrong hash is actually different (it will be for non-trivial inputs)
        if (wrongHash === correctHash) return; // skip degenerate case

        const result = verifyIntegrity(Buffer.from(bytes), wrongHash, correctSize);
        expect(result).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  // Property B (negative, wrong size): (bytes, correct_hash, wrong_size) → false
  it('returns false when size does not match', () => {
    fc.assert(
      fc.property(
        bytesArb,
        fc.integer({ min: 1, max: 1000 }),
        (bytes, sizeDelta) => {
          const correctHash = oracleHash(bytes);
          const wrongSize = bytes.length + sizeDelta; // always different since sizeDelta >= 1

          const result = verifyIntegrity(Buffer.from(bytes), correctHash, wrongSize);
          expect(result).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Property B (negative, both wrong): (bytes, wrong_hash, wrong_size) → false
  it('returns false when both hash and size do not match', () => {
    fc.assert(
      fc.property(
        bytesArb,
        fc.integer({ min: 1, max: 1000 }),
        (bytes, sizeDelta) => {
          const wrongSize = bytes.length + sizeDelta;

          // Generate wrong hash by appending a byte
          const tampered = new Uint8Array(bytes.length + 1);
          tampered.set(bytes);
          tampered[bytes.length] = 0xab;
          const wrongHash = oracleHash(tampered);

          const result = verifyIntegrity(Buffer.from(bytes), wrongHash, wrongSize);
          expect(result).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
