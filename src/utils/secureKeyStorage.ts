// ============================================
// Zule AI — Secure Key Storage (renderer-side)
// ============================================
//
// Encrypts provider API keys (OpenAI/Anthropic/Gemini) before they are
// persisted to IndexedDB, using Electron's `safeStorage` (OS credential
// store — DPAPI/Keychain/libsecret) via the preload bridge in
// electron/main.ts. The renderer never handles the encryption key itself.
//
// Stored values carry a prefix so old and new formats can coexist:
//   "enc:v1:<base64>"  — encrypted via safeStorage.
//   "plain:<key>"      — safeStorage was unavailable when saved (e.g. the
//                         app was run outside Electron via `npm run dev`);
//                         stored as-is with an explicit marker so this is
//                         never mistaken for an encrypted value.
//   <anything else>    — a legacy raw key written before this module
//                         existed. Treated as plaintext; gets upgraded to
//                         "enc:v1:" the next time the user saves Settings.

const ENC_PREFIX = 'enc:v1:';
const PLAIN_PREFIX = 'plain:';

async function isSecureStorageAvailable(): Promise<boolean> {
  const api = window.electronAPI;
  if (!api?.isElectron || !api.secureStorageIsAvailable) return false;
  try {
    return await api.secureStorageIsAvailable();
  } catch {
    return false;
  }
}

/**
 * Encrypt an API key for storage. Falls back to a clearly-marked plaintext
 * value when running outside Electron or when the OS keystore is
 * unavailable, rather than silently failing to save the key at all.
 */
export async function encryptApiKey(plaintext: string): Promise<string> {
  const api = window.electronAPI;
  if (api?.secureStorageEncrypt && (await isSecureStorageAvailable())) {
    try {
      const cipher = await api.secureStorageEncrypt(plaintext);
      return ENC_PREFIX + cipher;
    } catch (err) {
      console.warn(
        '[secureKeyStorage] OS-level encryption failed; storing key unencrypted:',
        err,
      );
    }
  }
  return PLAIN_PREFIX + plaintext;
}

/**
 * Decrypt a value previously produced by `encryptApiKey`, transparently
 * handling the plaintext fallback and legacy unmarked-plaintext formats.
 * Returns '' if an encrypted value can't be decrypted (e.g. moved to a
 * different machine/OS user — safeStorage keys are not portable).
 */
export async function decryptApiKey(stored: string | undefined): Promise<string> {
  if (!stored) return '';

  if (stored.startsWith(ENC_PREFIX)) {
    const cipher = stored.slice(ENC_PREFIX.length);
    const api = window.electronAPI;
    if (api?.secureStorageDecrypt) {
      try {
        return await api.secureStorageDecrypt(cipher);
      } catch (err) {
        console.warn(
          '[secureKeyStorage] Failed to decrypt stored key (OS keystore unavailable or key moved to a different machine):',
          err,
        );
        return '';
      }
    }
    return '';
  }

  if (stored.startsWith(PLAIN_PREFIX)) {
    return stored.slice(PLAIN_PREFIX.length);
  }

  // Legacy raw key written before OS-level encryption was added.
  return stored;
}
