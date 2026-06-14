// ============================================
// Zule AI — CryptoVault tests
// ============================================
//
// Unit tests pin down the `CryptoVault` contract with a handful of
// representative examples, then a property-based test exercises the
// AES-GCM round-trip and wrong-passphrase rejection across the full
// input space.
//
// Property numbers refer to design.md §"Correctness Properties".
// Run under Vitest's jsdom environment, which inherits Node 19+'s
// global `crypto.subtle` implementation — no polyfill needed.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  CryptoVault,
  IV_LENGTH_BYTES,
  PBKDF2_ITERATIONS,
  SALT_LENGTH_BYTES,
} from './cryptoVault';

// ---------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------

/** A deterministic, stable salt so two vaults can derive the same key. */
function fixedSalt(): Uint8Array {
  const s = new Uint8Array(SALT_LENGTH_BYTES);
  for (let i = 0; i < SALT_LENGTH_BYTES; i++) s[i] = i + 1;
  return s;
}

async function unlockWithFixedSalt(passphrase: string): Promise<CryptoVault> {
  const v = new CryptoVault();
  const r = await v.unlock(passphrase, fixedSalt());
  if (!r.ok) throw new Error('test setup: unlock failed');
  return v;
}

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

describe('CryptoVault — exported constants match Requirement 15.1', () => {
  it('uses PBKDF2 with 200 000 iterations', () => {
    expect(PBKDF2_ITERATIONS).toBe(200_000);
  });

  it('uses a 16-byte salt and a 12-byte AES-GCM IV', () => {
    expect(SALT_LENGTH_BYTES).toBe(16);
    expect(IV_LENGTH_BYTES).toBe(12);
  });
});

// ---------------------------------------------------------------------
// Lifecycle: locked / unlocked / lock-again
// ---------------------------------------------------------------------

describe('CryptoVault — lifecycle', () => {
  it('starts locked with no salt', () => {
    const v = new CryptoVault();
    expect(v.isLocked).toBe(true);
    expect(v.salt).toBeNull();
  });

  it('unlock generates a fresh salt when none is provided and exposes it', async () => {
    const v = new CryptoVault();
    const r = await v.unlock('correct horse battery staple');
    expect(r.ok).toBe(true);
    if (!r.ok) return; // narrow for TS

    expect(r.value.salt.byteLength).toBe(SALT_LENGTH_BYTES);
    expect(v.isLocked).toBe(false);
    expect(v.salt).not.toBeNull();
    expect(v.salt!.byteLength).toBe(SALT_LENGTH_BYTES);
  });

  it('unlock with an explicit salt reuses that salt', async () => {
    const salt = fixedSalt();
    const v = new CryptoVault();
    const r = await v.unlock('passphrase', salt);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Array.from(r.value.salt)).toEqual(Array.from(salt));
  });

  it('unlock rejects an empty passphrase as crypto.passphrase-wrong', async () => {
    const v = new CryptoVault();
    const r = await v.unlock('');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('crypto.passphrase-wrong');
    expect(v.isLocked).toBe(true);
  });

  it('lock clears the in-memory key and salt and is idempotent', async () => {
    const v = await unlockWithFixedSalt('x');
    expect(v.isLocked).toBe(false);

    v.lock();
    expect(v.isLocked).toBe(true);
    expect(v.salt).toBeNull();

    // Calling lock again is a no-op.
    v.lock();
    expect(v.isLocked).toBe(true);
  });

  it('encrypt and decrypt fail with crypto.decrypt-failed while locked', async () => {
    const v = new CryptoVault();

    const enc = await v.encrypt('hello');
    expect(enc.ok).toBe(false);
    if (!enc.ok) expect(enc.error.kind).toBe('crypto.decrypt-failed');

    const dec = await v.decrypt('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(dec.ok).toBe(false);
    if (!dec.ok) expect(dec.error.kind).toBe('crypto.decrypt-failed');
  });

  it('a copy of the returned salt does not leak internal state', async () => {
    const v = new CryptoVault();
    const r = await v.unlock('p');
    if (!r.ok) throw new Error('setup');

    // Mutating the returned salt should not affect a subsequent unlock.
    r.value.salt.fill(0);
    expect(v.salt!.every((b) => b === 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Round-trip examples
// ---------------------------------------------------------------------

describe('CryptoVault — round-trip', () => {
  it('decrypt(encrypt(p)) === p for a single ASCII string', async () => {
    const v = await unlockWithFixedSalt('top-secret');
    const enc = await v.encrypt('hello world');
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;

    const dec = await v.decrypt(enc.value);
    expect(dec.ok).toBe(true);
    if (!dec.ok) return;
    expect(dec.value).toBe('hello world');
  });

  it('two encryptions of the same plaintext produce different ciphertexts (fresh IV)', async () => {
    const v = await unlockWithFixedSalt('top-secret');
    const a = await v.encrypt('same');
    const b = await v.encrypt('same');
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value).not.toBe(b.value);
  });

  it('decrypt fails for a ciphertext produced under a different passphrase', async () => {
    const v1 = await unlockWithFixedSalt('one');
    const v2 = await unlockWithFixedSalt('two');

    const enc = await v1.encrypt('payload');
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;

    const dec = await v2.decrypt(enc.value);
    expect(dec.ok).toBe(false);
    if (dec.ok) return;
    expect(dec.error.kind).toBe('crypto.decrypt-failed');
  });

  it('decrypt fails for malformed base64 input', async () => {
    const v = await unlockWithFixedSalt('p');
    const dec = await v.decrypt('not-valid-base64!!!@@@');
    expect(dec.ok).toBe(false);
  });

  it('decrypt fails for an input shorter than IV + GCM tag', async () => {
    const v = await unlockWithFixedSalt('p');
    const dec = await v.decrypt('AAAA'); // 3 bytes after base64 decode
    expect(dec.ok).toBe(false);
  });

  it('decrypt fails when the ciphertext is tampered with', async () => {
    const v = await unlockWithFixedSalt('p');
    const enc = await v.encrypt('payload');
    if (!enc.ok) throw new Error('setup');

    // Flip the last base64 character; AES-GCM tag verification rejects.
    const tampered =
      enc.value.slice(0, -1) + (enc.value.endsWith('A') ? 'B' : 'A');

    const dec = await v.decrypt(tampered);
    expect(dec.ok).toBe(false);
  });

  it('round-trips multi-byte UTF-8 (CJK, emoji)', async () => {
    const v = await unlockWithFixedSalt('p');
    const cases = ['日本語テスト', '汉字测试', '🎉🚀✨', 'Mixed: hi 👋 こんにちは'];
    for (const c of cases) {
      const enc = await v.encrypt(c);
      if (!enc.ok) throw new Error('encrypt');
      const dec = await v.decrypt(enc.value);
      if (!dec.ok) throw new Error('decrypt');
      expect(dec.value).toBe(c);
    }
  });

  it('a re-unlock with the same passphrase + salt can decrypt prior ciphertext', async () => {
    const salt = fixedSalt();
    const a = new CryptoVault();
    await a.unlock('shared', salt);
    const enc = await a.encrypt('persisted');
    if (!enc.ok) throw new Error('setup');

    // New session: same passphrase + persisted salt must decrypt.
    const b = new CryptoVault();
    await b.unlock('shared', salt);
    const dec = await b.decrypt(enc.value);
    expect(dec.ok).toBe(true);
    if (dec.ok) expect(dec.value).toBe('persisted');
  });
});

// ---------------------------------------------------------------------
// Property 42 — AES-GCM key vault round-trips arbitrary plaintext
// Validates: Requirements 15.1
// ---------------------------------------------------------------------
//
// For all non-empty UTF-8 plaintext strings P and any non-empty
// passphrase K, decrypt(encrypt(P, K), K) === P.
// For any K ≠ K', decrypt(encrypt(P, K), K') rejects (AES-GCM tag
// verification fails — it cannot return a wrong plaintext).

describe('CryptoVault — Property 42: AES-GCM key vault round-trips arbitrary plaintext', () => {
  it(
    'decrypt(encrypt(p, k), k) === p; decrypt(encrypt(p, k), k != k\') rejects',
    async () => {
      // Fresh salt per run so vaults under k and k' can derive comparable
      // keys: same salt + same passphrase => same AES-GCM key.
      const salt = fixedSalt();

      await fc.assert(
        fc.asyncProperty(
          // Arbitrary non-empty Unicode plaintext (no lone surrogates,
          // so the TextEncoder/TextDecoder round-trip is exact).
          fc.fullUnicodeString({ minLength: 1, maxLength: 200 }),
          // Two passphrases, ASCII printable to keep generators fast and
          // sidestep any TextEncoder normalisation concerns.
          fc
            .stringMatching(/^[\x21-\x7e]{1,32}$/)
            .filter((s) => s.length > 0),
          fc
            .stringMatching(/^[\x21-\x7e]{1,32}$/)
            .filter((s) => s.length > 0),
          async (plaintext, k1, k2) => {
            // ---- Same-key round-trip --------------------------------
            const v1 = new CryptoVault();
            const ru = await v1.unlock(k1, salt);
            expect(ru.ok).toBe(true);
            if (!ru.ok) return;

            const enc = await v1.encrypt(plaintext);
            expect(enc.ok).toBe(true);
            if (!enc.ok) return;

            const dec = await v1.decrypt(enc.value);
            expect(dec.ok).toBe(true);
            if (!dec.ok) return;
            expect(dec.value).toBe(plaintext);

            // ---- Wrong-key rejection --------------------------------
            // Only meaningful when k1 != k2; with the same salt + same
            // passphrase the keys would be identical and decryption
            // would (correctly) succeed.
            if (k1 !== k2) {
              const v2 = new CryptoVault();
              const ru2 = await v2.unlock(k2, salt);
              expect(ru2.ok).toBe(true);
              if (!ru2.ok) return;

              const wrong = await v2.decrypt(enc.value);
              // AES-GCM's authentication tag guarantees a wrong key
              // cannot yield a valid plaintext; the result is always
              // a `crypto.decrypt-failed` error, never the original P.
              expect(wrong.ok).toBe(false);
              if (wrong.ok) {
                // Should be unreachable; the assertion above will fail
                // first. Belt-and-braces: if it ever decoded, it must
                // not equal the plaintext.
                expect(wrong.value).not.toBe(plaintext);
              }
            }
          },
        ),
        // PBKDF2(SHA-256, 200 000) is intentionally expensive — it is
        // the cost-imposing factor of Requirement 15.1. Each run does
        // up to two key derivations plus an encrypt and two decrypts.
        // Keep the run count small enough that the suite stays under a
        // sensible local-CI budget while still sampling the input space.
        { numRuns: 12 },
      );
    },
    // Vitest test-level timeout. PBKDF2 200 000 iters is ~100-300 ms in
    // Node Web Crypto; 12 runs * up to 2 derivations gives us plenty of
    // headroom even on slow CI runners.
    60_000,
  );
});
