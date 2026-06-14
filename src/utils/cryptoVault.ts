// ============================================
// Zule AI — CryptoVault (PBKDF2 + AES-GCM)
// ============================================
//
// In-memory encryption vault used by Settings_Store to protect API keys
// for cloud Provider_Adapters. The vault holds a single AES-GCM 256-bit
// CryptoKey derived from a user-supplied passphrase via
// PBKDF2(SHA-256, 200 000 iterations).
//
// Acceptance criteria covered:
//   - 15.1 — API keys are persisted under AES-GCM with a key derived via
//     PBKDF2(SHA-256, 200 000 iterations) from a user-supplied passphrase.
//   - 15.2 — While the vault is locked, the AI_Provider_Router refuses
//     to use cloud providers; this module exposes `isLocked` so the
//     router can gate cloud calls and the UI can prompt for unlock.
//
// Design references:
//   - design.md §"Stealth and Privacy"
//   - design.md §18 "Settings_Store and CryptoVault"
//   - design.md §"Error transport" (Result<T, ZuleError>)
//
// Threat model & scoping (intentional non-goals):
//   - The vault is a single-user, single-passphrase keychain. Multi-user
//     identity is out of scope; the passphrase is owned by the local
//     User as in Requirement 15.1.
//   - The derived key is held only in memory (`CryptoKey` with
//     `extractable: false`), never persisted. The salt is returned from
//     `unlock` and persisted by the caller (`Settings_Store`).
//   - Authentication is provided by AES-GCM's built-in tag; a wrong
//     passphrase or tampered ciphertext always surfaces as
//     `crypto.decrypt-failed`, never as silent corruption.

import { err, ok, type Result } from '../types/result';
import type { ZuleError } from '../types/errors';

/**
 * PBKDF2 iteration count mandated by Requirement 15.1.
 *
 * Exported so callers (tests, settings UI) can reference the same
 * constant rather than hard-coding the value, but it is not configurable
 * at runtime: the spec pins it.
 */
export const PBKDF2_ITERATIONS = 200_000;

/**
 * Salt size in bytes. 128 bits is the standard PBKDF2 / NIST SP 800-132
 * recommendation; the salt is generated once on first unlock and then
 * persisted alongside the encrypted key material in Settings_Store.
 */
export const SALT_LENGTH_BYTES = 16;

/**
 * AES-GCM IV size in bytes. 96 bits is the value recommended by
 * NIST SP 800-38D for AES-GCM and the only size that avoids the
 * GCM "implicit nonce mismatch" pitfall. A new IV is generated for
 * every `encrypt(...)` call.
 */
export const IV_LENGTH_BYTES = 12;

/**
 * AES-GCM authentication tag size in bytes (default for Web Crypto).
 * Used for input-length sanity checks on `decrypt(...)`.
 */
export const GCM_TAG_LENGTH_BYTES = 16;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

/**
 * Stateful, in-memory encryption vault.
 *
 * Lifecycle:
 *   1. Construct a vault (empty / locked).
 *   2. Call `unlock(passphrase, salt?)` — derives the AES-GCM key.
 *      On first unlock, omit `salt` to generate a fresh random salt;
 *      persist the returned salt in Settings_Store. On subsequent
 *      unlocks (a new session), pass the persisted salt back.
 *   3. Call `encrypt(plaintext)` / `decrypt(ciphertext)` — wraps the
 *      ciphertext as `base64(IV || ciphertext)` using a fresh 96-bit
 *      IV per encryption.
 *   4. Call `lock()` to clear the in-memory key (e.g. on session end
 *     or panic-hide).
 *
 * Errors are returned as `Result<T, ZuleError>` rather than thrown so
 * the orchestration layer (`useZuleError`) can surface them through
 * the standard toast + telemetry pipeline.
 */
export class CryptoVault {
  /** AES-GCM 256 key derived from the passphrase, or `null` while locked. */
  private key: CryptoKey | null = null;

  /** Salt used to derive the current key, or `null` while locked. */
  private currentSalt: Uint8Array | null = null;

  /** True when no key is loaded; cloud providers must be gated on this. */
  get isLocked(): boolean {
    return this.key === null;
  }

  /**
   * Salt currently in use, or `null` while locked.
   *
   * The caller is expected to persist this value (alongside any
   * ciphertext it stores) so a future session can re-unlock the vault
   * with the same passphrase.
   */
  get salt(): Uint8Array | null {
    return this.currentSalt;
  }

  /**
   * Derive an AES-GCM key from `passphrase` using PBKDF2 (SHA-256,
   * 200 000 iterations) and store it in memory.
   *
   * If `salt` is omitted, a cryptographically random 128-bit salt is
   * generated and returned in the `Result`. Callers persist the salt
   * (it is not secret; it just needs to be reproducible).
   *
   * Returns `crypto.passphrase-wrong` for an empty passphrase and
   * `crypto.decrypt-failed` for any underlying Web Crypto failure
   * (e.g. unavailable in the host environment).
   */
  async unlock(
    passphrase: string,
    salt?: Uint8Array,
  ): Promise<Result<{ salt: Uint8Array }, ZuleError>> {
    if (typeof passphrase !== 'string' || passphrase.length === 0) {
      return err({ kind: 'crypto.passphrase-wrong' });
    }

    const subtle = getSubtle();
    if (!subtle) {
      return err({ kind: 'crypto.decrypt-failed' });
    }

    const useSalt =
      salt && salt.byteLength > 0
        ? new Uint8Array(salt) // copy to detach from caller storage
        : generateRandomBytes(SALT_LENGTH_BYTES);

    try {
      const baseKey = await subtle.importKey(
        'raw',
        TEXT_ENCODER.encode(passphrase),
        { name: 'PBKDF2' },
        /* extractable */ false,
        ['deriveKey'],
      );

      const aesKey = await subtle.deriveKey(
        {
          name: 'PBKDF2',
          hash: 'SHA-256',
          salt: useSalt,
          iterations: PBKDF2_ITERATIONS,
        },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        /* extractable */ false,
        ['encrypt', 'decrypt'],
      );

      this.key = aesKey;
      this.currentSalt = useSalt;
      // Return a copy so callers cannot mutate our internal salt.
      return ok({ salt: new Uint8Array(useSalt) });
    } catch {
      // Drop any partially-loaded state before bubbling the error.
      this.key = null;
      this.currentSalt = null;
      return err({ kind: 'crypto.decrypt-failed' });
    }
  }

  /**
   * Clear the in-memory key. Idempotent.
   *
   * Web Crypto's `CryptoKey` is opaque and we have no direct access to
   * its underlying bytes; releasing the reference is the best a JS
   * caller can do. The salt is also cleared so a relock-then-unlock
   * cycle goes back through the normal "first unlock" path if no salt
   * is provided.
   */
  lock(): void {
    this.key = null;
    this.currentSalt = null;
  }

  /**
   * AES-GCM encrypt `plaintext` with a fresh 96-bit IV. Returns the
   * concatenation `IV || ciphertext` base64-encoded.
   *
   * Errors:
   *   - `crypto.decrypt-failed` if the vault is locked (no key) or the
   *     underlying Web Crypto call rejects. We deliberately reuse the
   *     decrypt-failed kind here rather than introducing an
   *     encrypt-failed variant: the failure surface for the caller
   *     (re-prompt for passphrase, toast, telemetry) is identical.
   */
  async encrypt(plaintext: string): Promise<Result<string, ZuleError>> {
    if (this.key === null) {
      return err({ kind: 'crypto.decrypt-failed' });
    }
    const subtle = getSubtle();
    if (!subtle) {
      return err({ kind: 'crypto.decrypt-failed' });
    }

    try {
      const iv = generateRandomBytes(IV_LENGTH_BYTES);
      const data = TEXT_ENCODER.encode(plaintext);
      const ciphertext = await subtle.encrypt(
        { name: 'AES-GCM', iv },
        this.key,
        data,
      );

      const ctBytes = new Uint8Array(ciphertext);
      const combined = new Uint8Array(iv.length + ctBytes.length);
      combined.set(iv, 0);
      combined.set(ctBytes, iv.length);
      return ok(toBase64(combined));
    } catch {
      return err({ kind: 'crypto.decrypt-failed' });
    }
  }

  /**
   * AES-GCM decrypt a `base64(IV || ciphertext)` blob produced by
   * `encrypt(...)`. Returns `crypto.decrypt-failed` when:
   *   - the vault is locked,
   *   - the input is not valid base64,
   *   - the input is too short to contain an IV plus a GCM tag,
   *   - the ciphertext was produced under a different key, or
   *   - the ciphertext or tag have been tampered with.
   *
   * AES-GCM's authenticated-encryption tag means a wrong key can never
   * yield a "wrong but plausible" plaintext: the decrypt either returns
   * the exact original bytes or rejects.
   */
  async decrypt(ciphertext: string): Promise<Result<string, ZuleError>> {
    if (this.key === null) {
      return err({ kind: 'crypto.decrypt-failed' });
    }
    const subtle = getSubtle();
    if (!subtle) {
      return err({ kind: 'crypto.decrypt-failed' });
    }

    let combined: Uint8Array;
    try {
      combined = fromBase64(ciphertext);
    } catch {
      return err({ kind: 'crypto.decrypt-failed' });
    }

    // An AES-GCM ciphertext is at minimum IV (12) + tag (16) bytes.
    // A shorter input cannot have come from a well-formed `encrypt`.
    if (combined.length < IV_LENGTH_BYTES + GCM_TAG_LENGTH_BYTES) {
      return err({ kind: 'crypto.decrypt-failed' });
    }

    const iv = combined.subarray(0, IV_LENGTH_BYTES);
    const data = combined.subarray(IV_LENGTH_BYTES);

    try {
      const plaintext = await subtle.decrypt(
        { name: 'AES-GCM', iv },
        this.key,
        data,
      );
      return ok(TEXT_DECODER.decode(plaintext));
    } catch {
      return err({ kind: 'crypto.decrypt-failed' });
    }
  }
}

// ---------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------

/**
 * Resolve the Web Crypto `subtle` interface in a way that works in
 * both the browser (`window.crypto.subtle`) and Vitest's jsdom +
 * Node 19+ environment (`globalThis.crypto.subtle`). Returns `null`
 * when the host lacks Web Crypto entirely.
 */
function getSubtle(): SubtleCrypto | null {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  return c && c.subtle ? c.subtle : null;
}

/**
 * Cryptographically secure random bytes. Throws if the host has no
 * `crypto.getRandomValues` — which would also disable PBKDF2 above,
 * so this is effectively unreachable in supported environments.
 */
function generateRandomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('CryptoVault: secure random generator is unavailable');
  }
  c.getRandomValues(out);
  return out;
}

/**
 * Encode a `Uint8Array` as standard (RFC 4648) base64. Uses `btoa`,
 * which is available globally in browsers, jsdom, and Node 16+.
 */
function toBase64(bytes: Uint8Array): string {
  // Build the binary string in chunks to avoid `Maximum call stack
  // size exceeded` on large inputs from `String.fromCharCode(...spread)`.
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(binary);
}

/**
 * Decode a standard (RFC 4648) base64 string. Throws on malformed
 * input — callers translate that into `crypto.decrypt-failed`.
 */
function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
